const { createClient } = require('@libsql/client');
const express = require('express');
const compression = require('compression');
const crypto  = require('crypto');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

// ═════════════════════════════════════════════════════════════
//  RATE LIMITING — protección contra fuerza bruta en /login
// ═════════════════════════════════════════════════════════════
const loginAttempts = new Map();
const LOGIN_MAX     = 10;           // intentos permitidos
const LOGIN_WINDOW  = 15 * 60_000; // ventana de 15 minutos

// IP del cliente. Se usa SOLO como clave del rate limit en memoria: no se
// guarda en ningún lado ni se registra en la bitácora.
function reqIp(req) {
  const ip = req?.headers?.['x-forwarded-for']?.split(',')[0].trim() || req?.socket?.remoteAddress || '';
  return ip.replace(/^::ffff:/, '');   // IPv4 mapeada a IPv6: normaliza la clave
}

function checkLoginRate(ip) {
  const now    = Date.now();
  const record = loginAttempts.get(ip) || { count: 0, resetAt: now + LOGIN_WINDOW };
  if (now > record.resetAt) { record.count = 0; record.resetAt = now + LOGIN_WINDOW; }
  if (record.count >= LOGIN_MAX) return false;
  record.count++;
  loginAttempts.set(ip, record);
  return true;
}

// Limpiar entradas expiradas cada hora para no acumular memoria
setInterval(() => {
  const now = Date.now();
  for (const [ip, r] of loginAttempts) if (now > r.resetAt) loginAttempts.delete(ip);
}, 60 * 60_000);

// ═════════════════════════════════════════════════════════════
//  AUTENTICACIÓN
//
//  Mecanismo: cookie httpOnly firmada con HMAC-SHA256.
//  - El servidor valida la cookie en cada petición.
//  - JS del navegador nunca puede leer la cookie (httpOnly).
//  - SESSION_SECRET debe ser una variable de entorno en
//    producción (Vercel). Sin ella, cada reinicio del servidor
//    invalida las sesiones activas.
// ═════════════════════════════════════════════════════════════

const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
// Sin valor por defecto a proposito: tenerlo escrito acá lo publicaba en el
// repositorio. Solo se usa para sembrar el primer admin (ver initDB).
const APP_PASSWORD   = process.env.APP_PASSWORD   || '';
const COOKIE_NAME    = 'keynes_auth';
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 días en segundos

function parseCookies(req) {
  const cookies = {};
  const header = req.headers.cookie;
  if (!header) return cookies;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx < 0) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    cookies[k] = decodeURIComponent(v);
  });
  return cookies;
}

// ── Hashing de contraseñas (scrypt con salt por usuario) ─────
// Formato versionado: `salt:hash:N`. Los hashes viejos `salt:hash` (sin N) se
// leen con el default histórico de Node (N=16384) y se re-hashean al próximo login.
// ponytail: scryptSync bloquea el event loop ~100-200ms por login; aceptable a
// este volumen. Si el tráfico de logins sube, pasar a la versión async de scrypt.
const SCRYPT_N      = 1 << 17;                 // 131072 — recomendado OWASP
const SCRYPT_OPTS   = { N: SCRYPT_N, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const SCRYPT_N_OLD  = 16384;                    // default histórico (hashes sin N)

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64, SCRYPT_OPTS).toString('hex');
  return `${salt}:${hash}:${SCRYPT_N}`;
}
function verifyPassword(pw, stored) {
  const [salt, hash, nStr] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const N = nStr ? parseInt(nStr, 10) : SCRYPT_N_OLD;
  const opts = { N, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
  const test = crypto.scryptSync(String(pw), salt, 64, opts).toString('hex');
  const a = Buffer.from(test, 'hex'), b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// ¿El hash almacenado usa un costo menor al actual? (para re-hashear tras login)
function needsRehash(stored) {
  const nStr = String(stored || '').split(':')[2];
  return (nStr ? parseInt(nStr, 10) : SCRYPT_N_OLD) < SCRYPT_N;
}

// ─────────────────────────────────────────────────────────────
//  ENCRIPTACIÓN EN REPOSO (AES-256-GCM) de datos sensibles
//
//  Protege un backup/volcado robado de la base: teléfono, email,
//  contactos, observaciones y montos/conceptos de pago se guardan
//  cifrados y se descifran en el servidor al leer.
//
//  IMPORTANTE (producción): definir ENCRYPTION_KEY en Vercel y NO
//  cambiarla nunca — sin la misma clave los datos cifrados no se
//  pueden recuperar. Si no hay ninguna clave estable configurada,
//  el cifrado queda deshabilitado (guarda en claro) para no arriesgar
//  la pérdida de datos ante reinicios con secreto rotativo.
// ─────────────────────────────────────────────────────────────
const ENC_KEY_SOURCE = process.env.ENCRYPTION_KEY || process.env.SESSION_SECRET || '';
const ENC_ENABLED    = ENC_KEY_SOURCE.length > 0;
const ENC_KEY        = ENC_ENABLED ? crypto.scryptSync(ENC_KEY_SOURCE, 'keynes-enc-v1', 32) : null;
const ENC_PREFIX     = 'enc:v1:';

// ── Clave anterior (solo para descifrar) ─────────────────────
// Durante mucho tiempo no hubo ENCRYPTION_KEY y el cifrado colgaba de
// SESSION_SECRET. El día que se define una ENCRYPTION_KEY propia, todo lo ya
// guardado sigue estando cifrado con la vieja. Esta clave secundaria se usa
// SOLO para leer eso, hasta que la migración lo recifre con la nueva.
// Existe únicamente si ambas están definidas y son distintas.
const ENC_LEGACY_SRC = (process.env.ENCRYPTION_KEY && process.env.SESSION_SECRET &&
                        process.env.ENCRYPTION_KEY !== process.env.SESSION_SECRET)
                       ? process.env.SESSION_SECRET : '';
const ENC_LEGACY_KEY = ENC_LEGACY_SRC ? crypto.scryptSync(ENC_LEGACY_SRC, 'keynes-enc-v1', 32) : null;

function encrypt(plain) {
  if (plain === null || plain === undefined) return plain;
  const s = String(plain);
  if (!ENC_ENABLED || s === '') return s;
  if (s.startsWith(ENC_PREFIX)) return s; // ya cifrado
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const ct = Buffer.concat([cipher.update(s, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + iv.toString('hex') + ':' + tag.toString('hex') + ':' + ct.toString('hex');
}

// Intenta descifrar con una clave concreta. Devuelve null si no es la correcta
// (GCM detecta la clave equivocada por el tag de autenticación, no adivina).
function _decryptWith(s, key) {
  try {
    const parts = s.split(':'); // enc : v1 : iv : tag : ct
    const iv = Buffer.from(parts[2], 'hex'), tag = Buffer.from(parts[3], 'hex'), ct = Buffer.from(parts[4], 'hex');
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch { return null; }
}

// Descifra probando la clave actual y, si no da, la anterior. Devuelve null si
// ninguna sirve — quien llame decide qué hacer con eso.
function decryptOrNull(val) {
  if (val === null || val === undefined) return val;
  const s = String(val);
  if (!s.startsWith(ENC_PREFIX)) return s; // texto en claro (legacy o cifrado deshabilitado)
  if (!ENC_ENABLED) return s;
  const actual = _decryptWith(s, ENC_KEY);
  if (actual !== null) return actual;
  if (ENC_LEGACY_KEY) {
    const viejo = _decryptWith(s, ENC_LEGACY_KEY);
    if (viejo !== null) return viejo;   // aún no recifrado: se lee igual
  }
  return null;
}

function decrypt(val) {
  const d = decryptOrNull(val);
  if (d !== null) return d;
  console.error('[decrypt] no se pudo descifrar con ninguna clave conocida');
  return '';
}
// Descifra un número (monto) guardado cifrado como texto
function decryptNum(val) { const d = decrypt(val); const n = Number(d); return Number.isFinite(n) ? n : 0; }

// Todas las columnas cifradas del sistema, en un solo lugar. La usa la
// migración de recifrado. Si algún día se cifra una columna nueva, va acá.
const ENC_COLUMNAS = [
  { tabla: 'alumnos',               pk: 'id',             cols: ['telefono', 'email', 'contacto2_nombre', 'contacto2_relacion', 'contacto2_telefono', 'caracteristicas'] },
  { tabla: 'empresas',              pk: 'id',             cols: ['telefono', 'email', 'direccion', 'contacto_nombre', 'contacto_telefono'] },
  { tabla: 'inscripciones',         pk: 'inscripcion_id', cols: ['tutores'] },
  { tabla: 'clases',                pk: 'id',             cols: ['observaciones'] },
  { tabla: 'asistencias_generales', pk: 'id',             cols: ['observaciones'] },
  { tabla: 'pagos_alumno',          pk: 'id',             cols: ['concepto', 'monto'] },
  { tabla: 'pagos_empresa',         pk: 'id',             cols: ['concepto', 'monto'] },
  { tabla: 'soporte_mensajes',      pk: 'id',             cols: ['asunto', 'mensaje'] },
  { tabla: 'usuarios',              pk: 'id',             cols: ['twofa_secret'] },
];

// ─────────────────────────────────────────────────────────────
//  2FA — TOTP (RFC 6238), sin dependencias externas
// ─────────────────────────────────────────────────────────────
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32_ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  let bits = 0, value = 0; const out = [];
  for (const c of String(str).replace(/=+$/, '').toUpperCase()) {
    const idx = B32_ALPHABET.indexOf(c);
    if (idx < 0) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}
function totpCode(secretB32, tSeconds) {
  const counter = Math.floor(tSeconds / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', base32Decode(secretB32)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const bin = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(bin % 1000000).padStart(6, '0');
}
function totpVerify(secretB32, code, window = 1) {
  if (!/^\d{6}$/.test(String(code || ''))) return false;
  const now = Math.floor(Date.now() / 1000);
  for (let w = -window; w <= window; w++) {
    if (totpCode(secretB32, now + w * 30) === String(code)) return true;
  }
  return false;
}
function newTotpSecret() { return base32Encode(crypto.randomBytes(20)); }

// ── Token de sesión: `${userId}.${exp}.${HMAC(userId.exp.password_hash)}` ──
//
// Dos propiedades que el token anterior (`userId.HMAC(userId)`) no tenía:
//  1. VENCE. Antes una cookie robada servía para siempre.
//  2. SE REVOCA al cambiar la contraseña, porque el hash entra en la firma.
//     Antes, cambiarle la clave a alguien NO cerraba su sesión abierta — para
//     sacar a un empleado había que desactivar la cuenta sí o sí.
function tokenMac(userId, exp, pwHash) {
  return crypto.createHmac('sha256', SESSION_SECRET)
    .update(`${userId}.${exp}.${pwHash}`).digest('hex');
}
function signUserToken(userId, pwHash) {
  const exp = Math.floor(Date.now() / 1000) + COOKIE_MAX_AGE;
  return `${userId}.${exp}.${tokenMac(userId, exp, pwHash)}`;
}

// Carga el usuario desde la cookie (o null si inválida / vencida / inactivo)
async function getUserFromReq(req) {
  const parts = String(parseCookies(req)[COOKIE_NAME] || '').split('.');
  if (parts.length < 3) return null;
  const mac    = parts.pop();
  const exp    = Number(parts.pop());
  const userId = parts.join('.');   // el id puede contener puntos
  if (!userId || !Number.isFinite(exp)) return null;
  if (exp <= Math.floor(Date.now() / 1000)) return null;   // sesión vencida
  try {
    const r = await db.execute({ sql: 'SELECT * FROM usuarios WHERE id = ?', args: [userId] });
    const u = r.rows[0];
    if (!u || !u.activo) return null;
    const expected = tokenMac(userId, exp, u.password_hash);
    const a = Buffer.from(mac), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return u;
  } catch { return null; }
}

// Sesión ausente/vencida: las rutas de API responden 401 JSON; las de página,
// redirección. Antes /api/* también redirigía, y eso dejaba la app a medias:
// fetch() sigue la redirección, recibe el HTML del login con status 200, res.ok
// da true, res.json() explota y el catch se lo traga. Resultado: el usuario veía
// datos viejos del caché, sin barra de admin y sin saber que su sesión caducó.
function denyAuth(req, res) {
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Sesión expirada. Volvé a iniciar sesión.' });
  }
  res.redirect('/login');
}

async function requireAuth(req, res, next) {
  try {
    await initDB();
    const u = await getUserFromReq(req);
    if (!u) return denyAuth(req, res);
    req.user = u;
    next();
  } catch (err) {
    console.error('[requireAuth]', err.message);
    denyAuth(req, res);
  }
}

function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  res.status(403).json({ error: 'Solo el administrador puede realizar esta acción.' });
}

function setAuthCookie(req, res, userId, pwHash) {
  const isHttps = req.headers['x-forwarded-proto'] === 'https' || req.secure;
  const parts = [
    `${COOKIE_NAME}=${signUserToken(userId, pwHash)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Strict',
    `Max-Age=${COOKIE_MAX_AGE}`,
  ];
  if (isHttps) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0`);
}

// ── Middlewares globales ──────────────────────────────────────
app.use(compression());  // gzip/brotli de las respuestas (reduce ancho de banda)
app.use(express.json({ limit: '2mb' }));  // reducido: 10 MB era excesivo
app.use(express.urlencoded({ extended: false, limit: '2mb' }));

// ── Headers de seguridad ──────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// ── Assets estáticos públicos (CSS, JS — no requieren autenticación) ──────────
app.get('/styles.css', (req, res) => res.sendFile(path.join(__dirname, 'public', 'styles.css')));
app.get('/app.js',     (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.js')));
app.get('/data.js',    (req, res) => res.sendFile(path.join(__dirname, 'public', 'data.js')));
// Plantilla del certificado: se sirve desde un modulo base64 (require) para que
// @vercel/node la bundlee siempre (includeFiles no la tomaba de forma fiable).
const CERT_TEMPLATE_B64 = require('./cert/cert-template-data');
app.get('/cert-template.png', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.type('png').send(Buffer.from(CERT_TEMPLATE_B64, 'base64'));
});
const CERT_PPTX_B64 = require('./cert/cert-pptx-data');
app.get('/cert-template.pptx', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.type('application/vnd.openxmlformats-officedocument.presentationml.presentation')
     .send(Buffer.from(CERT_PPTX_B64, 'base64'));
});

// ── Verificación de certificados (QR) ────────────────────────
// Firma HMAC del payload del certificado. Sin base de datos: el QR lleva los
// datos + la firma; la página /verificar recomputa la firma para validar.
function certSign(d) {
  return crypto.createHmac('sha256', SESSION_SECRET).update('cert:' + d).digest('hex').slice(0, 32);
}
function escapeHtml(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Página pública de verificación (la abre quien escanea el QR).
app.get('/verificar', (req, res) => {
  const d = String(req.query.d || '');
  const s = String(req.query.s || '');
  let valid = false, data = null;
  try {
    const expected = certSign(d);
    valid = s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected));
    if (valid) data = JSON.parse(Buffer.from(d.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch { valid = false; }

  const rows = valid ? [
    ['Alumno', data.n],
    ['Tipo', data.k === 'ingles' ? 'Inglés' : 'Informática'],
    data.k === 'ingles' ? ['Sistema', data.c] : ['Curso', data.c],
    data.k === 'ingles' && data.l ? ['Nivel', data.l] : null,
    data.h ? ['Horas cátedra', data.h] : null,
    ['Fecha', data.f],
  ].filter(Boolean).map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join('') : '';

  res.type('html').send(`<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Verificación de certificado — Keynes</title>
<style>
  :root{color-scheme:light}
  body{margin:0;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f1f5f9;color:#1e293b;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:20px}
  .card{background:#fff;border-radius:16px;box-shadow:0 10px 40px rgba(0,0,0,.08);max-width:460px;width:100%;overflow:hidden}
  .head{padding:26px 28px;text-align:center;color:#fff;background:${valid ? '#15803d' : '#b91c1c'}}
  .head .ico{font-size:44px;line-height:1}
  .head h1{margin:8px 0 2px;font-size:20px}
  .head p{margin:0;opacity:.9;font-size:13.5px}
  .brand{font-weight:800;letter-spacing:.02em;padding:14px 28px 0;color:#1e3a5f;font-size:15px}
  .brand span{color:#b8860b;font-weight:600;font-size:11px;display:block;letter-spacing:.05em}
  table{width:100%;border-collapse:collapse;margin:12px 0 8px}
  th,td{text-align:left;padding:10px 28px;font-size:14px;border-bottom:1px solid #eef2f7}
  th{color:#64748b;font-weight:600;width:42%}
  .foot{padding:14px 28px 22px;font-size:12px;color:#94a3b8;text-align:center}
</style></head><body>
  <div class="card">
    <div class="head">
      <div class="ico">${valid ? '✓' : '✕'}</div>
      <h1>${valid ? 'Certificado válido' : 'Certificado no válido'}</h1>
      <p>${valid ? 'Emitido por Keynes Education &amp; Technology' : 'La firma no coincide o el enlace fue alterado.'}</p>
    </div>
    ${valid ? `<div class="brand">KEYNES <span>EDUCATION &amp; TECHNOLOGY · ESTUDIOS SUPERIORES</span></div><table>${rows}</table>` : ''}
    <div class="foot">Verificación de autenticidad · keynes-sistema</div>
  </div>
</body></html>`);
});

// ── Rutas públicas (sin autenticación) ───────────────────────
app.get('/login', async (req, res) => {
  try { await initDB(); if (await getUserFromReq(req)) return res.redirect('/'); } catch {}
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', async (req, res) => {
  const ip = reqIp(req) || 'unknown';
  if (!checkLoginRate(ip)) {
    return res.status(429).redirect('/login?error=2');
  }

  try {
    await initDB();
    const username = (req.body.username || '').trim().slice(0, 100).toLowerCase();
    const password = (req.body.password || '').slice(0, 200);

    const code = String(req.body.code || '').trim();
    const r = await db.execute({ sql: 'SELECT * FROM usuarios WHERE username = ?', args: [username] });
    const u = r.rows[0];
    if (u && u.activo && verifyPassword(password, u.password_hash)) {
      // Segundo factor si está habilitado
      if (u.twofa_enabled) {
        const secret = decrypt(u.twofa_secret);
        if (!code) return res.redirect('/login?error=3&u=' + encodeURIComponent(username));
        if (!secret || !totpVerify(secret, code)) {
          // Contraseña correcta pero segundo factor incorrecto: vale la pena verlo.
          await logEvent({
            tipo: 'auth', accion: 'login_2fa_fallido', usuarioId: u.id, usuario: u.username,
            detalle: 'contraseña correcta, código 2FA incorrecto',
          });
          return res.redirect('/login?error=4&u=' + encodeURIComponent(username));
        }
      }
      // Re-hash transparente si el hash almacenado usa un costo viejo.
      // La cookie se firma con el hash que queda EFECTIVAMENTE guardado: como el
      // hash entra en la firma del token, usar el viejo dejaría al usuario
      // deslogueado apenas termina de entrar.
      let effHash = u.password_hash;
      if (needsRehash(u.password_hash)) {
        try {
          const nuevo = hashPassword(password);
          await db.execute({ sql: 'UPDATE usuarios SET password_hash = ? WHERE id = ?', args: [nuevo, u.id] });
          effHash = nuevo;
        } catch (e) { console.error('[login] re-hash falló:', e.message); }
      }
      setAuthCookie(req, res, u.id, effHash);
      await logEvent({ tipo: 'auth', accion: 'login_ok', usuarioId: u.id, usuario: u.username });
      return res.redirect('/');
    }
    // Fallo: se registra el usuario intentado, nunca la contraseña.
    // Sin `dedup` a propósito: checkLoginRate ya corta en 10 intentos por IP
    // cada 15 min, así que el volumen está acotado antes de llegar acá. Deduplicar
    // además taparía a alguien probando usuarios distintos, que es justo lo que
    // se quiere ver.
    await logEvent({
      tipo: 'auth', accion: 'login_fallido', usuario: username,
      detalle: u ? (u.activo ? 'contraseña incorrecta' : 'usuario desactivado') : 'usuario inexistente',
    });
  } catch (err) {
    console.error('[POST /login]', err.message);
  }

  res.redirect('/login?error=1');
});

app.get('/logout', async (req, res) => {
  // /logout va antes de requireAuth, así que req.user no existe todavía:
  // se resuelve desde la cookie solo para dejar constancia de quién salió.
  try {
    const u = await getUserFromReq(req);
    if (u) await logEvent({ tipo: 'auth', accion: 'logout', usuarioId: u.id, usuario: u.username });
  } catch {}
  clearAuthCookie(res);
  res.redirect('/login');
});

// ── Backup automático (Vercel Cron) ──────────────────────────
// Protegido por Bearer (CRON_SECRET). Vercel Cron envía ese header
// automáticamente. Sin CRON_SECRET el endpoint queda cerrado (401).
app.get('/api/cron/backup', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'No autorizado.' });
  }
  try {
    await initDB();
    const data = await fetchAllData(true);
    const json = JSON.stringify({ exportedAt: new Date().toISOString(), ...data });
    const sent = await sendBackupEmail(json);

    // Bitácora del día: correo aparte. Si falla, no tumba el backup.
    let logs = { eventos: 0, enviado: false, borrados: 0 };
    try { logs = await enviarLogsDiarios(); }
    catch (e) { console.error('[cron logs]', e.message); }

    res.json({ ok: true, sent, logs, students: data.students.length, companies: data.companies.length });
  } catch (err) {
    console.error('[cron backup]', err.message);
    res.status(500).json({ error: 'Error generando el backup.' });
  }
});

// ── Protección: todo lo que sigue requiere autenticación ─────
app.use(requireAuth);

// Firma del payload de un certificado (solo usuarios autenticados pueden emitir).
// Devuelve la firma HMAC; el cliente arma la URL del QR: /verificar?d=..&s=..
app.get('/api/cert-firma', (req, res) => {
  const d = String(req.query.d || '');
  if (!d || d.length > 2000) return res.status(400).json({ error: 'payload inválido' });
  res.json({ s: certSign(d) });
});

// ── Único archivo estático que falta servir ──────────────────
// Antes esto era express.static(__dirname), que entregaba TODO el directorio a
// cualquier usuario autenticado: server.js, seed.js, push-to-production.js,
// schema.sql, package.json y los tests. Un usuario común podía descargar el
// código y estudiar el modelo de permisos para buscarle la vuelta.
// styles.css, app.js y data.js ya tienen su propia ruta (públicas, más arriba);
// login.html la sirve /login; cert-template.png/.pptx también tienen la suya.
// Acá solo queda la app.
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ═════════════════════════════════════════════════════════════
//  GESTIÓN DE USUARIOS
// ═════════════════════════════════════════════════════════════

// Usuario actual (para que el frontend sepa el rol)
app.get('/api/me', (req, res) => {
  res.json({ id: req.user.id, username: req.user.username, nombre: req.user.nombre, role: req.user.role, twofaEnabled: !!req.user.twofa_enabled });
});

// ── 2FA (TOTP) — autogestionado por cada usuario ─────────────
// Paso 1: generar secreto (queda pendiente hasta confirmar con un código)
app.post('/api/me/2fa/setup', async (req, res) => {
  try {
    const secret = newTotpSecret();
    await db.execute({ sql: 'UPDATE usuarios SET twofa_secret = ?, twofa_enabled = 0 WHERE id = ?', args: [encrypt(secret), req.user.id] });
    const label = encodeURIComponent(`Keynes:${req.user.username}`);
    const otpauth = `otpauth://totp/${label}?secret=${secret}&issuer=Keynes&digits=6&period=30`;
    res.json({ secret, otpauth });
  } catch (err) {
    console.error('[2fa setup]', err.message);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

// Paso 2: confirmar y activar con un código del autenticador
app.post('/api/me/2fa/enable', async (req, res) => {
  try {
    const r = await db.execute({ sql: 'SELECT twofa_secret FROM usuarios WHERE id = ?', args: [req.user.id] });
    const secret = decrypt(r.rows[0]?.twofa_secret);
    if (!secret) return res.status(400).json({ error: 'Primero generá el código QR/secreto.' });
    if (!totpVerify(secret, req.body.code)) return res.status(400).json({ error: 'Código incorrecto. Probá de nuevo.' });
    await db.execute({ sql: 'UPDATE usuarios SET twofa_enabled = 1 WHERE id = ?', args: [req.user.id] });
    await logEvent({ tipo: 'auth', accion: '2fa_activado', usuarioId: req.user.id, usuario: req.user.username });
    res.json({ ok: true });
  } catch (err) {
    console.error('[2fa enable]', err.message);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

// Desactivar 2FA (confirmando la contraseña actual)
app.post('/api/me/2fa/disable', async (req, res) => {
  try {
    if (!verifyPassword(String(req.body.currentPassword || ''), req.user.password_hash)) {
      return res.status(403).json({ error: 'La contraseña actual es incorrecta.' });
    }
    await db.execute({ sql: "UPDATE usuarios SET twofa_enabled = 0, twofa_secret = '' WHERE id = ?", args: [req.user.id] });
    await logEvent({ tipo: 'auth', accion: '2fa_desactivado', usuarioId: req.user.id, usuario: req.user.username });
    res.json({ ok: true });
  } catch (err) {
    console.error('[2fa disable]', err.message);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

const VALID_ROLES = ['admin', 'usuario'];
const USERNAME_RE = /^[a-z0-9._-]{3,100}$/;

// Cualquier usuario edita su PROPIA cuenta: nombre, usuario y contraseña.
// Cambiar usuario o contraseña exige confirmar la contraseña actual.
app.patch('/api/me', async (req, res) => {
  try {
    const me = req.user;
    const nombre = req.body.nombre !== undefined ? String(req.body.nombre).trim().slice(0, 120) : me.nombre;
    const newUsername = req.body.username !== undefined ? String(req.body.username).trim().toLowerCase().slice(0, 100) : me.username;
    const newPassword = req.body.password ? String(req.body.password) : null;
    const current = String(req.body.currentPassword || '');

    const changingUsername = newUsername !== me.username;
    const changingPassword = newPassword !== null;

    if ((changingUsername || changingPassword) && !verifyPassword(current, me.password_hash)) {
      return res.status(403).json({ error: 'La contraseña actual es incorrecta.' });
    }
    if (changingUsername && !USERNAME_RE.test(newUsername)) {
      return res.status(400).json({ error: 'Usuario inválido (mín. 3 caracteres: letras, números, . _ -).' });
    }
    if (changingPassword && newPassword.length < 6) {
      return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres.' });
    }

    if (changingPassword) {
      await db.execute({ sql: 'UPDATE usuarios SET nombre = ?, username = ?, password_hash = ? WHERE id = ?',
        args: [nombre, newUsername, hashPassword(newPassword), me.id] });
    } else {
      await db.execute({ sql: 'UPDATE usuarios SET nombre = ?, username = ? WHERE id = ?',
        args: [nombre, newUsername, me.id] });
    }
    res.json({ ok: true });
  } catch (err) {
    if (String(err.message || '').includes('UNIQUE')) {
      return res.status(409).json({ error: 'Ese nombre de usuario ya está en uso.' });
    }
    console.error('[PATCH /api/me]', err.message);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

// ── Soporte: recibir un mensaje del usuario y enviarlo al correo del dueño ──
//  El correo destino NO vive en el cliente. Con Formspree, el correo real queda
//  oculto en el panel de Formspree y acá solo se usa un form ID.
//  Se guarda cifrado en reposo y se envía por email si hay proveedor configurado.
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'soporte@ejemplo.com';

// URL del form de Formspree (https://formspree.io/f/XXXX). Acepta el endpoint
// completo (FORMSPREE_ENDPOINT) o solo el ID (FORMSPREE_ID).
const FORMSPREE_URL = process.env.FORMSPREE_ENDPOINT
  || (process.env.FORMSPREE_ID ? `https://formspree.io/f/${process.env.FORMSPREE_ID}` : '');

async function sendSupportEmail(asunto, cuerpo, meta = {}) {
  // 1) Formspree (recomendado): HTTP, sin dependencias, correo oculto en su panel.
  if (FORMSPREE_URL) {
    const r = await fetch(FORMSPREE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        _subject: asunto,
        email: meta.replyTo || undefined,   // para poder responder al usuario
        usuario: meta.usuario || '',
        message: cuerpo,
      }),
    });
    if (r.ok) return true;
    console.error('[soporte] Formspree falló:', r.status, await r.text().catch(() => ''));
    // sigue al fallback
  }
  // 2) Resend (alternativa): requiere RESEND_API_KEY.
  const key = process.env.RESEND_API_KEY;
  if (key) {
    const from = process.env.SUPPORT_FROM || 'Keynes Soporte <onboarding@resend.dev>';
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [SUPPORT_EMAIL], subject: asunto, text: cuerpo }),
    });
    if (r.ok) return true;
    console.error('[soporte] Resend falló:', r.status, await r.text().catch(() => ''));
  }
  return false;
}

// Envía el backup (JSON) como adjunto por correo vía Resend. Requiere
// RESEND_API_KEY; destinatario BACKUP_EMAIL o, en su defecto, SUPPORT_EMAIL.
async function sendBackupEmail(jsonStr) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return false;
  const to    = process.env.BACKUP_EMAIL || SUPPORT_EMAIL;
  const from  = process.env.SUPPORT_FROM || 'Keynes Backup <onboarding@resend.dev>';
  const fecha = new Date().toISOString().slice(0, 10);
  const content = Buffer.from(jsonStr, 'utf8').toString('base64');
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from, to: [to], subject: `[Keynes] Backup ${fecha}`,
      text: `Backup automático de Keynes (${fecha}). Archivo JSON adjunto.`,
      attachments: [{ filename: `keynes-backup-${fecha}.json`, content }],
    }),
  });
  if (!r.ok) console.error('[backup] Resend falló:', r.status, await r.text().catch(() => ''));
  return r.ok;
}

app.post('/api/soporte', async (req, res) => {
  try {
    const asunto  = String(req.body.asunto  || '').trim().slice(0, 200);
    const mensaje = String(req.body.mensaje || '').trim().slice(0, 5000);
    if (!mensaje) return res.status(400).json({ error: 'El mensaje no puede estar vacío.' });

    const u = req.user;
    const fecha = new Date().toISOString();
    const cuerpo =
      `Nuevo mensaje de soporte — Keynes\n` +
      `De: ${u.nombre || u.username} (usuario: ${u.username}, rol: ${u.role})\n` +
      `Fecha: ${new Date().toLocaleString('es')}\n` +
      `Asunto: ${asunto || '(sin asunto)'}\n\n` +
      `${mensaje}\n`;

    let enviado = false;
    try { enviado = await sendSupportEmail(`[Keynes] ${asunto || 'Mensaje de soporte'}`, cuerpo, { usuario: `${u.nombre || u.username} (${u.username})` }); }
    catch (e) { console.error('[soporte] error enviando email:', e.message); }

    // Guardar cifrado como respaldo (para no perder el mensaje si el email no está configurado)
    await db.execute({
      sql: 'INSERT INTO soporte_mensajes (id, usuario_id, usuario_nombre, asunto, mensaje, fecha, enviado) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [`sop-${Date.now()}-${Math.round(Math.random() * 1e6)}`, u.id, u.nombre || u.username, encrypt(asunto), encrypt(mensaje), fecha, enviado ? 1 : 0],
    });

    res.json({ ok: true, enviado });
  } catch (err) {
    console.error('[POST /api/soporte]', err.message);
    res.status(500).json({ error: 'No se pudo enviar el mensaje.' });
  }
});

// Cuántos administradores activos quedan (para no dejar el sistema sin admin)
async function countActiveAdmins() {
  const r = await db.execute("SELECT COUNT(*) AS n FROM usuarios WHERE role = 'admin' AND activo = 1");
  return Number(r.rows[0].n) || 0;
}

// Listar usuarios (solo admin) — nunca devuelve hashes
app.get('/api/users', requireAdmin, async (req, res) => {
  try {
    const r = await db.execute('SELECT id, username, nombre, role, activo, created_at FROM usuarios ORDER BY created_at');
    res.json({ users: r.rows.map(u => ({
      id: u.id, username: u.username, nombre: u.nombre || '', role: u.role, activo: !!u.activo, createdAt: u.created_at || '',
    })) });
  } catch (err) {
    console.error('[GET /api/users]', err.message);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

// Crear usuario (solo admin)
app.post('/api/users', requireAdmin, async (req, res) => {
  try {
    const username = String(req.body.username || '').trim().toLowerCase().slice(0, 100);
    const password = String(req.body.password || '');
    const nombre   = String(req.body.nombre || '').trim().slice(0, 120);
    const role     = VALID_ROLES.includes(req.body.role) ? req.body.role : 'usuario';

    if (!/^[a-z0-9._-]{3,100}$/.test(username)) {
      return res.status(400).json({ error: 'Usuario inválido (mín. 3 caracteres: letras, números, . _ -).' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' });
    }

    const nuevoId = crypto.randomUUID();
    await db.execute({
      sql: 'INSERT INTO usuarios (id, username, nombre, password_hash, role, activo, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
      args: [nuevoId, username, nombre, hashPassword(password), role, new Date().toISOString()],
    });
    await logEvent({
      tipo: 'usuario', accion: 'crear', usuarioId: req.user.id, usuario: req.user.username,
      entidad: 'usuario', entidadId: nuevoId, detalle: `creó '${username}' (rol: ${role})`,
    });
    res.json({ ok: true });
  } catch (err) {
    if (String(err.message || '').includes('UNIQUE')) {
      return res.status(409).json({ error: 'Ya existe un usuario con ese nombre.' });
    }
    console.error('[POST /api/users]', err.message);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

// Modificar usuario (solo admin): nombre, role, activo y opcionalmente contraseña
app.patch('/api/users/:id', requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const r  = await db.execute({ sql: 'SELECT * FROM usuarios WHERE id = ?', args: [id] });
    const target = r.rows[0];
    if (!target) return res.status(404).json({ error: 'Usuario no encontrado.' });

    const nombre   = req.body.nombre !== undefined ? String(req.body.nombre).trim().slice(0, 120) : target.nombre;
    const username = req.body.username !== undefined ? String(req.body.username).trim().toLowerCase().slice(0, 100) : target.username;
    const isSelf  = target.id === req.user.id;
    // Nadie puede quitarse a sí mismo el rol de admin ni desactivar su propia cuenta.
    const role    = isSelf ? target.role : (VALID_ROLES.includes(req.body.role) ? req.body.role : target.role);
    const activo  = isSelf ? 1 : (req.body.activo !== undefined ? (req.body.activo ? 1 : 0) : (target.activo ? 1 : 0));
    const password = req.body.password ? String(req.body.password) : null;

    if (username !== target.username && !USERNAME_RE.test(username)) {
      return res.status(400).json({ error: 'Usuario inválido (mín. 3 caracteres: letras, números, . _ -).' });
    }
    // No dejar el sistema sin ningún admin activo
    const wasActiveAdmin = target.role === 'admin' && target.activo;
    const staysActiveAdmin = role === 'admin' && activo === 1;
    if (wasActiveAdmin && !staysActiveAdmin && (await countActiveAdmins()) <= 1) {
      return res.status(400).json({ error: 'No podés quitar el último administrador activo.' });
    }
    if (password !== null && password.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' });
    }

    if (password !== null) {
      await db.execute({
        sql: 'UPDATE usuarios SET nombre = ?, username = ?, role = ?, activo = ?, password_hash = ? WHERE id = ?',
        args: [nombre, username, role, activo, hashPassword(password), id],
      });
    } else {
      await db.execute({
        sql: 'UPDATE usuarios SET nombre = ?, username = ?, role = ?, activo = ? WHERE id = ?',
        args: [nombre, username, role, activo, id],
      });
    }
    // Qué cambió realmente (nunca la contraseña en sí, solo que se cambió)
    const cambios = [];
    if (username !== target.username)        cambios.push(`usuario: '${target.username}' → '${username}'`);
    if (nombre   !== (target.nombre || ''))  cambios.push('nombre');
    if (role     !== target.role)            cambios.push(`rol: ${target.role} → ${role}`);
    if (activo   !== (target.activo ? 1 : 0)) cambios.push(activo ? 'reactivado' : 'desactivado');
    if (password !== null)                    cambios.push('contraseña cambiada');
    await logEvent({
      tipo: 'usuario', accion: 'editar', usuarioId: req.user.id, usuario: req.user.username,
      entidad: 'usuario', entidadId: id,
      detalle: `editó '${target.username}': ${cambios.length ? cambios.join(', ') : 'sin cambios'}`,
    });
    res.json({ ok: true });
  } catch (err) {
    if (String(err.message || '').includes('UNIQUE')) {
      return res.status(409).json({ error: 'Ese nombre de usuario ya está en uso.' });
    }
    console.error('[PATCH /api/users]', err.message);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

// Eliminar usuario (solo admin)
app.delete('/api/users/:id', requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    if (id === req.user.id) return res.status(400).json({ error: 'No podés eliminar tu propia cuenta.' });
    const r = await db.execute({ sql: 'SELECT * FROM usuarios WHERE id = ?', args: [id] });
    const target = r.rows[0];
    if (!target) return res.status(404).json({ error: 'Usuario no encontrado.' });
    if (target.role === 'admin' && target.activo && (await countActiveAdmins()) <= 1) {
      return res.status(400).json({ error: 'No podés eliminar el último administrador activo.' });
    }
    await db.execute({ sql: 'DELETE FROM usuarios WHERE id = ?', args: [id] });
    await logEvent({
      tipo: 'usuario', accion: 'borrar', usuarioId: req.user.id, usuario: req.user.username,
      entidad: 'usuario', entidadId: id, detalle: `eliminó '${target.username}' (rol: ${target.role})`,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /api/users]', err.message);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

// ═════════════════════════════════════════════════════════════
//  BASE DE DATOS
// ═════════════════════════════════════════════════════════════

const db = createClient({
  url:       process.env.TURSO_DATABASE_URL || 'file:keynes.db',
  authToken: process.env.TURSO_AUTH_TOKEN   || undefined,
});

// ═════════════════════════════════════════════════════════════
//  BITÁCORA (logs)
//
//  La tabla `logs` es una COLA, no un histórico: se llena durante
//  el día y el cron diario la vacía DESPUÉS de enviarla por correo.
//  Nunca guarda más de un día (~30-80 filas), así que el costo en
//  writes es marginal frente a lo que ya escribe POST /api/data.
//
//  `detalle` va cifrado: puede contener nombres de alumnos.
//  Nunca se registran contraseñas, secretos TOTP, montos de pago ni IPs.
// ═════════════════════════════════════════════════════════════

const LOG_MAX_POR_REQUEST = 50;   // tope de filas por guardado
const LOG_MAX_DIAS        = 30;   // red de seguridad si el correo falla

// Arma la sentencia INSERT de un evento (no la ejecuta). Se usa suelta
// (logEvent) o empujada dentro de un batch ya existente (POST /api/data).
function logStmt(ev) {
  return {
    sql: 'INSERT INTO logs (ts, tipo, accion, usuario_id, usuario, entidad, entidad_id, detalle) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    args: [
      new Date().toISOString(),
      String(ev.tipo    || 'sistema').slice(0, 20),
      String(ev.accion  || '').slice(0, 40),
      String(ev.usuarioId || '').slice(0, 100),
      String(ev.usuario   || '').slice(0, 100),
      String(ev.entidad   || '').slice(0, 20),
      String(ev.entidadId || '').slice(0, 100),
      encrypt(String(ev.detalle || '').slice(0, 500)),
    ],
  };
}

// Registra un evento. NUNCA lanza: un fallo del log jamás debe romper la
// operación que lo generó (login, guardado, borrado de usuario).
// Se hace `await` a propósito: en serverless la instancia puede congelarse
// apenas se responde, y un insert sin await se perdería.
async function logEvent(ev) {
  try {
    await db.execute(logStmt(ev));
  } catch (e) {
    console.error('[log]', e.message);
  }
}

// Hora local de Paraguay para el correo (los ts se guardan en UTC).
function horaLocal(ts) {
  try {
    return new Date(ts).toLocaleTimeString('es', {
      timeZone: 'America/Asuncion', hour: '2-digit', minute: '2-digit', hour12: false,
    });
  } catch { return String(ts || '').slice(11, 16); }
}

const LOG_TITULOS = { auth: 'ACCESOS', dato: 'DATOS', usuario: 'USUARIOS', error: 'ERRORES', sistema: 'SISTEMA' };
const LOG_ORDEN   = ['auth', 'dato', 'usuario', 'error', 'sistema'];

// Cuerpo del correo: texto plano agrupado por tipo (buscable desde Gmail).
function formatLogsTexto(eventos) {
  const grupos = {};
  eventos.forEach(e => { (grupos[e.tipo] = grupos[e.tipo] || []).push(e); });
  const tipos = [...LOG_ORDEN, ...Object.keys(grupos).filter(t => !LOG_ORDEN.includes(t))];
  let out = '';
  for (const tipo of tipos) {
    const g = grupos[tipo];
    if (!g || !g.length) continue;
    out += `\n── ${LOG_TITULOS[tipo] || tipo.toUpperCase()} (${g.length}) ──\n`;
    for (const e of g) {
      const cols = [
        horaLocal(e.ts).padEnd(5),
        (e.usuario || '—').padEnd(12),
        (e.accion  || '').padEnd(18),
        (e.entidad || '').padEnd(8),
        e.detalle  || '',
      ];
      out += cols.join(' ').replace(/\s+$/, '') + '\n';
    }
  }
  return out;
}

// Envía la bitácora del día: texto legible en el cuerpo + JSON adjunto.
async function sendLogsEmail(fecha, eventos) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return false;
  const to   = process.env.BACKUP_EMAIL || SUPPORT_EMAIL;
  const from = process.env.SUPPORT_FROM || 'Keynes Bitácora <onboarding@resend.dev>';

  const cuerpo = eventos.length
    ? `Actividad del sistema — ${fecha}\n${eventos.length} eventos. Horarios en hora de Paraguay.\n${formatLogsTexto(eventos)}\nDetalle completo en el JSON adjunto.\n`
    : `Actividad del sistema — ${fecha}\n\nSin actividad registrada.\n`;

  const body = {
    from, to: [to],
    subject: `[Keynes] Actividad ${fecha} — ${eventos.length} evento${eventos.length === 1 ? '' : 's'}`,
    text: cuerpo,
  };
  // Sin eventos no adjuntamos nada: el correo existe solo para confirmar que el cron corrió.
  if (eventos.length) {
    body.attachments = [{
      filename: `keynes-logs-${fecha}.json`,
      content: Buffer.from(JSON.stringify(eventos, null, 2), 'utf8').toString('base64'),
    }];
  }

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) console.error('[logs] Resend falló:', r.status, await r.text().catch(() => ''));
  return r.ok;
}

// Envía los logs acumulados y SOLO ENTONCES los borra.
// Si el correo falla, las filas quedan y salen en el envío siguiente:
// nunca se pierde un evento. Se borra por `id <= maxId` (capturado antes de
// enviar) para no arrastrar filas escritas mientras corría el envío.
async function enviarLogsDiarios() {
  const fecha = new Date().toISOString().slice(0, 10);
  const r = await db.execute('SELECT * FROM logs ORDER BY id');
  const rows = r.rows;

  const eventos = rows.map(x => ({
    ts: x.ts, tipo: x.tipo, accion: x.accion,
    usuario: x.usuario || '', usuarioId: x.usuario_id || '',
    entidad: x.entidad || '', entidadId: x.entidad_id || '',
    detalle: decrypt(x.detalle) || '',
  }));

  const enviado = await sendLogsEmail(fecha, eventos);

  let borrados = 0;
  if (enviado && rows.length) {
    const maxId = rows[rows.length - 1].id;
    await db.execute({ sql: 'DELETE FROM logs WHERE id <= ?', args: [maxId] });
    borrados = rows.length;
  } else if (rows.length) {
    // ponytail: red de seguridad. Si el correo lleva días fallando (típico:
    // falta RESEND_API_KEY) la cola no puede crecer sin límite.
    const corte = new Date(Date.now() - LOG_MAX_DIAS * 86400_000).toISOString();
    const d = await db.execute({ sql: 'DELETE FROM logs WHERE ts < ?', args: [corte] });
    borrados = Number(d.rowsAffected) || 0;
    if (borrados) console.error(`[logs] correo falló; purgadas ${borrados} filas de más de ${LOG_MAX_DIAS} días`);
  }

  return { eventos: eventos.length, enviado, borrados };
}

let ready = false;
async function initDB() {
  if (ready) return;
  const ddl = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
  await db.executeMultiple(ddl);

  // Migraciones para bases de datos pre-existentes
  const migrations = [
    "ALTER TABLE alumnos ADD COLUMN dias_clase       TEXT DEFAULT ''",
    "ALTER TABLE alumnos ADD COLUMN horario          TEXT DEFAULT ''",
    "ALTER TABLE alumnos ADD COLUMN empresa_id       TEXT DEFAULT ''",
    "ALTER TABLE alumnos ADD COLUMN caracteristicas  TEXT DEFAULT ''",
    `CREATE TABLE IF NOT EXISTS asistencias_generales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alumno_id TEXT NOT NULL REFERENCES alumnos(id) ON DELETE CASCADE,
      fecha TEXT DEFAULT '', presente INTEGER DEFAULT 1, horas REAL DEFAULT 0
    )`,
    "CREATE INDEX IF NOT EXISTS idx_asist_gen_alumno ON asistencias_generales(alumno_id)",
    "ALTER TABLE clases ADD COLUMN homework_tarea TEXT    DEFAULT ''",
    "ALTER TABLE clases ADD COLUMN homework_hecho INTEGER DEFAULT 0",
    "ALTER TABLE cursos  ADD COLUMN has_homework  INTEGER DEFAULT 0",
    "ALTER TABLE cursos  ADD COLUMN allow_manual  INTEGER DEFAULT 0",  // permitir carga manual de clases aunque tenga temas
    "ALTER TABLE cursos  ADD COLUMN notas         TEXT    DEFAULT ''", // notas / materiales del curso
    "ALTER TABLE asistencias_generales ADD COLUMN observaciones TEXT DEFAULT ''",
    "ALTER TABLE alumnos ADD COLUMN alertas_dismissed TEXT DEFAULT '{}'",
    "ALTER TABLE alumnos ADD COLUMN estado        TEXT    DEFAULT 'activo'",  // activo | pausado | finalizado
    "ALTER TABLE alumnos ADD COLUMN tipo_pago     TEXT    DEFAULT 'mensual'", // config de pago unificada por alumno
    "ALTER TABLE alumnos ADD COLUMN monto_pago    INTEGER DEFAULT 0",
    "ALTER TABLE alumnos ADD COLUMN horas_paquete INTEGER",
    `CREATE TABLE IF NOT EXISTS pagos_alumno (
      id TEXT PRIMARY KEY,
      alumno_id TEXT NOT NULL REFERENCES alumnos(id) ON DELETE CASCADE,
      fecha TEXT DEFAULT '', concepto TEXT DEFAULT '', monto INTEGER DEFAULT 0, pagado INTEGER DEFAULT 0
    )`,
    "CREATE INDEX IF NOT EXISTS idx_pagos_alumno ON pagos_alumno(alumno_id)",
    `CREATE TABLE IF NOT EXISTS usuarios (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      nombre TEXT DEFAULT '',
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'usuario',       -- 'admin' | 'usuario'
      activo INTEGER DEFAULT 1,
      created_at TEXT DEFAULT ''
    )`,
    "ALTER TABLE usuarios ADD COLUMN twofa_secret  TEXT    DEFAULT ''",  // secreto TOTP (cifrado en reposo)
    "ALTER TABLE usuarios ADD COLUMN twofa_enabled INTEGER DEFAULT 0",
    // Hash de contenido por entidad: permite saltear reescrituras si no cambió (ahorra writes)
    "ALTER TABLE alumnos  ADD COLUMN data_hash TEXT DEFAULT ''",
    "ALTER TABLE cursos   ADD COLUMN data_hash TEXT DEFAULT ''",
    "ALTER TABLE empresas ADD COLUMN data_hash TEXT DEFAULT ''",
    `CREATE TABLE IF NOT EXISTS pagos_empresa (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
      alumno_id TEXT DEFAULT '',
      fecha TEXT DEFAULT '', concepto TEXT DEFAULT '', monto INTEGER DEFAULT 0, pagado INTEGER DEFAULT 0
    )`,
    "CREATE INDEX IF NOT EXISTS idx_pagos_empresa ON pagos_empresa(empresa_id)",
    `CREATE TABLE IF NOT EXISTS soporte_mensajes (
      id TEXT PRIMARY KEY,
      usuario_id TEXT DEFAULT '', usuario_nombre TEXT DEFAULT '',
      asunto TEXT DEFAULT '', mensaje TEXT DEFAULT '',   -- cifrados en reposo
      fecha TEXT DEFAULT '', enviado INTEGER DEFAULT 0
    )`,
    // Sincronización incremental (delta): versión en la que cambió cada entidad
    "ALTER TABLE cursos   ADD COLUMN updated_v INTEGER DEFAULT 0",
    "ALTER TABLE alumnos  ADD COLUMN updated_v INTEGER DEFAULT 0",
    "ALTER TABLE empresas ADD COLUMN updated_v INTEGER DEFAULT 0",
    // Lápidas de borrado: para que el cliente sepa qué eliminar en el delta
    `CREATE TABLE IF NOT EXISTS deletions (
      entity TEXT NOT NULL, entity_id TEXT NOT NULL, v INTEGER NOT NULL
    )`,
    "CREATE INDEX IF NOT EXISTS idx_deletions_v ON deletions(v)",
    // Bitácora: COLA de un día, no histórico. El cron diario la envía y la vacía.
    `CREATE TABLE IF NOT EXISTS logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ts         TEXT NOT NULL,
      tipo       TEXT NOT NULL,
      accion     TEXT NOT NULL,
      usuario_id TEXT DEFAULT '',
      usuario    TEXT DEFAULT '',
      entidad    TEXT DEFAULT '',
      entidad_id TEXT DEFAULT '',
      detalle    TEXT DEFAULT ''
    )`,
    // La bitácora guardó IPs en su primer día. Se elimina la columna, y con
    // ella los valores ya escritos. Falla sin consecuencias si ya no existe.
    "ALTER TABLE logs DROP COLUMN ip",
    // Hash por colección hija: evita reescribir asistencias/pagos/clases cuando no
    // cambiaron, aunque el alumno esté "sucio" por otro campo. Corta la amplificación
    // de writes (tomar asistencia ya no reescribe todas las clases del alumno).
    "ALTER TABLE alumnos       ADD COLUMN asist_hash  TEXT DEFAULT ''",
    "ALTER TABLE alumnos       ADD COLUMN pagos_hash  TEXT DEFAULT ''",
    "ALTER TABLE inscripciones ADD COLUMN clases_hash TEXT DEFAULT ''",
  ];
  for (const sql of migrations) {
    try { await db.execute(sql); } catch {}
  }

  // Seed del administrador principal: si no hay usuarios, crear 'admin' con
  // APP_PASSWORD. Sin esa variable NO se usa una contraseña por defecto -eso la
  // dejaba publicada en el repositorio-: se genera una al azar y se avisa por
  // consola. En producción la variable existe, así que esto no cambia nada.
  try {
    const uCount = await db.execute('SELECT COUNT(*) AS n FROM usuarios');
    if (Number(uCount.rows[0].n) === 0) {
      const pw = APP_PASSWORD || crypto.randomBytes(18).toString('base64url');
      if (!APP_PASSWORD) {
        console.error('[seed admin] Falta APP_PASSWORD. Se creó el admin con esta ' +
                      'contraseña aleatoria, anotala y definí la variable: ' + pw);
      }
      await db.execute({
        sql: 'INSERT INTO usuarios (id, username, nombre, password_hash, role, activo, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
        args: ['admin', 'admin', 'Administrador', hashPassword(pw), 'admin', new Date().toISOString()],
      });
    }
  } catch (e) { console.error('[seed admin]', e.message); }

  // Migración única: unificar pagos por-inscripción → pagos por-alumno, y tomar
  // la config de pago (tipo/monto/horas) de la primera inscripción de cada alumno.
  const pagosMigFlag = await db.execute("SELECT value FROM meta WHERE key = 'pagos_unificados'");
  if (!pagosMigFlag.rows[0]) {
    try {
      await db.execute(`
        INSERT INTO pagos_alumno (id, alumno_id, fecha, concepto, monto, pagado)
        SELECT p.id || '-mig', i.alumno_id, p.fecha, p.concepto, p.monto, p.pagado
        FROM pagos p JOIN inscripciones i ON p.inscripcion_id = i.inscripcion_id
      `);
    } catch {}
    try {
      await db.execute(`
        UPDATE alumnos SET
          tipo_pago     = COALESCE((SELECT tipo_pago     FROM inscripciones WHERE alumno_id = alumnos.id ORDER BY rowid LIMIT 1), 'mensual'),
          monto_pago    = COALESCE((SELECT monto_pago    FROM inscripciones WHERE alumno_id = alumnos.id ORDER BY rowid LIMIT 1), 0),
          horas_paquete =          (SELECT horas_paquete FROM inscripciones WHERE alumno_id = alumnos.id ORDER BY rowid LIMIT 1)
        WHERE id IN (SELECT DISTINCT alumno_id FROM inscripciones)
      `);
    } catch {}
    // Preservar el estado "Finalizado" derivado: alumnos con inscripciones y todas completadas
    try {
      await db.execute(`
        UPDATE alumnos SET estado = 'finalizado'
        WHERE id IN (SELECT DISTINCT alumno_id FROM inscripciones)
          AND id NOT IN (SELECT DISTINCT alumno_id FROM inscripciones WHERE completado = 0)
      `);
    } catch {}
    await db.execute("INSERT OR IGNORE INTO meta (key, value) VALUES ('pagos_unificados', '1')");
  }

  // Migración única: copiar asistencias por inscripción → asistencias generales por alumno
  const migFlag = await db.execute("SELECT value FROM meta WHERE key = 'asistencias_migrated'");
  if (!migFlag.rows[0]) {
    try {
      await db.execute(`
        INSERT INTO asistencias_generales (alumno_id, fecha, presente, horas)
        SELECT i.alumno_id, a.fecha, MAX(a.presente), MAX(a.horas)
        FROM asistencias a
        JOIN inscripciones i ON a.inscripcion_id = i.inscripcion_id
        GROUP BY i.alumno_id, a.fecha
      `);
    } catch {}
    await db.execute("INSERT OR IGNORE INTO meta (key, value) VALUES ('asistencias_migrated', '1')");
  }

  // Eliminar temas duplicados (sin restricción UNIQUE en la tabla, pueden acumularse)
  await db.execute('DELETE FROM temas WHERE rowid NOT IN (SELECT MIN(rowid) FROM temas GROUP BY curso_id, descripcion)');

  // Seed inicial de temas solo si el curso existe pero no tiene temas
  const excelTopics = await db.execute("SELECT COUNT(*) as n FROM temas WHERE curso_id = 'excel-avanzado'");
  if (Number(excelTopics.rows[0].n) === 0) {
    await db.executeMultiple(`
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-avanzado',  0, 'C1.1 - Ordenar y Autofiltro');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-avanzado',  1, 'C1.2 - Ordenar y Autofiltro');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-avanzado',  2, 'C1.3 - Filtro Avanzado y Subtotales');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-avanzado',  3, 'C1.4 - Filtros y SubTotales');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-avanzado',  4, 'C1.5 Repaso');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-avanzado',  5, 'C2.1 - BuscarV BuscarH');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-avanzado',  6, 'C2.2 - BuscarV BuscarH');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-avanzado',  7, 'C2.3 - BuscarV BuscarH');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-avanzado',  8, 'C3.1 Funciones Lógicas');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-avanzado',  9, 'C3.2 Funciones Lógicas');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-avanzado', 10, 'C3.3 Repaso');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-avanzado', 11, 'C4.1 - Contar y Sumar Si');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-avanzado', 12, 'C4.2 - Validaciones');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-avanzado', 13, 'C4.3 - Repasos');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-avanzado', 14, 'C5.1 - Tabla Dinámica');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-avanzado', 15, 'C5.2 - Tabla Dinámica');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-avanzado', 16, 'C5.3 - Tabla Dinámica');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-avanzado', 17, 'C5.4 - Tabla Dinámica');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-avanzado', 18, 'C5.5 - Tabla Dinámica');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-avanzado', 19, 'C5.6 - Repaso Tablas Dinámicas');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-avanzado', 20, 'C6.1 - Cta Resultado – Proyección');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-avanzado', 21, 'C6.2 – Consolidación');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-avanzado', 22, 'C6.2a ConsAsuncion');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-avanzado', 23, 'C6.2b ConsLuque');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-avanzado', 24, 'C6.3 - Repaso Consolidación');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-avanzado', 25, 'C7.1 - Macros');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-avanzado', 26, 'C7.2 - Macros y Gráficos');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-avanzado', 27, 'C8. Repaso del Curso');
    `);
  }

  // Seed temas power-bi
  const powerBiTopics = await db.execute("SELECT COUNT(*) as n FROM temas WHERE curso_id = 'power-bi'");
  if (Number(powerBiTopics.rows[0].n) === 0) {
    await db.executeMultiple(`
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('power-bi', 0, 'Tablas dinámicas. Introducción a Power BI. Instalación de la interface');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('power-bi', 1, 'Medidas DAX.');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('power-bi', 2, 'Autos SA');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('power-bi', 3, 'Caso Starbucks');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('power-bi', 4, 'Caso Super Tienda');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('power-bi', 5, 'Proyecto Final');
    `);
  }

  // Seed temas excel-basico
  const basicoTopics = await db.execute("SELECT COUNT(*) as n FROM temas WHERE curso_id = 'excel-basico'");
  if (Number(basicoTopics.rows[0].n) === 0) {
    await db.executeMultiple(`
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-basico',  0, 'C.1. Relleno de Datos & Fórmulas');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-basico',  1, 'C.2. Formato & Series');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-basico',  2, 'C.3. Fórmulas y Funciones');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-basico',  3, 'C.4. Plantilla de Ventas');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-basico',  4, 'C.5. Función Si');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-basico',  5, 'C.6. Buscar V');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-basico',  6, 'C.7. Validación de Datos');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-basico',  7, 'C.8. Registro de Ventas');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-basico',  8, 'C.9. Gráficos');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-basico',  9, 'C.10. Listas & Filtros');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-basico', 10, 'C.11. Lista de Alumnos');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-basico', 11, 'C.12. Tabla dinámica');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-basico', 12, 'C.13. Tablas');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-basico', 13, 'C.14. Ejercicios Extras (Opcional)');
    `);
  }

  // Seed temas excel-financiero
  const financieroTopics = await db.execute("SELECT COUNT(*) as n FROM temas WHERE curso_id = 'excel-financiero'");
  if (Number(financieroTopics.rows[0].n) === 0) {
    await db.executeMultiple(`
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-financiero',  0, 'EJ1.1 - Cuenta de Resultados. Modelos Económicos y Financieros');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-financiero',  1, 'EJ2.1 - Rentas y Sistemas de Amortización. Préstamo hipotecario');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-financiero',  2, 'EJ2.2 - Apéndice de Funciones Financieras y Sistemas de Amortización');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-financiero',  3, 'EJ2.3 - Sistema Frances Realista');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-financiero',  4, 'EJ3.1 - Construcción y Análisis de Balances. Buscar Objetivo-Solver');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-financiero',  5, 'EJ3.2 - Introducción Solver');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-financiero',  6, 'EJ3.3 - Solver para cuadrar balance y para Beneficio Máximo');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-financiero',  7, 'EJ4.1 - Evaluación de proyectos');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-financiero',  8, 'EJ5.1 - Validación de datos - Agrícola Colonial');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-financiero',  9, 'EJ5.2 - Validación de Datos con funciones lógicas - Ross (Opcional)');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-financiero', 10, 'EJ6.1 - Manejo de Bases de Datos. Análisis de Datos. Estadística. Manufacturas Arnaiz');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-financiero', 11, 'EJ7.1 - Macros. Personalizar funciones financieras');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('excel-financiero', 12, 'EJ8.1 - Repaso');
    `);
  }

  // Seed temas duolingo
  const duolingoTopics = await db.execute("SELECT COUNT(*) as n FROM temas WHERE curso_id = 'duolingo'");
  if (Number(duolingoTopics.rows[0].n) === 0) {
    await db.executeMultiple(`
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo',  0, 'M1 Grammar: Present Simple');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo',  1, 'M1 Grammar: Present Continuous');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo',  2, 'M1 Grammar: Past Simple');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo',  3, 'M1 Grammar: Future with "will" and "going to"');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo',  4, 'M1 Grammar: There is / There are');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo',  5, 'M1 Grammar: Can / Could');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo',  6, 'M1 Grammar: Comparatives and Superlatives');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo',  7, 'M1 Grammar: Adverbs of Frequency');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo',  8, 'M1 Grammar: Prepositions');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo',  9, 'M1 Vocabulary: Daily Routines, Family, Work and Studies, Travel, Food, Technology, Emotions and Personality');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo', 10, 'M1 Skills: Lectura de textos cortos');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo', 11, 'M1 Skills: Comprensión auditiva básica');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo', 12, 'M1 Skills: Respuestas orales simples');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo', 13, 'M1 Skills: Escritura de oraciones y párrafos cortos');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo', 14, 'M2 Speaking: Describe a photo');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo', 15, 'M2 Speaking: Answer short questions');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo', 16, 'M2 Speaking: Personal opinions');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo', 17, 'M2 Speaking: Fluency practice');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo', 18, 'M2 Speaking: Pronunciation Exercises');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo', 19, 'M2 Writing: Short paragraph writing');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo', 20, 'M2 Writing: Email and opinion writing');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo', 21, 'M2 Writing: Describing experiences');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo', 22, 'M2 Writing: Expanding answers with connectors');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo', 23, 'M2 Writing: Make questions');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo', 24, 'M2 Listening: Conversations');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo', 25, 'M2 Listening: Short talks');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo', 26, 'M2 Listening: Dictation practice');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo', 27, 'M2 Listening: Identifying key information');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo', 28, 'M2 Reading: Sentence completion');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo', 29, 'M2 Reading: Reading comprehension');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo', 30, 'M2 Reading: Vocabulary in context');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo', 31, 'M2 Reading: Fast reading strategies');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo', 32, 'M3: Administración del tiempo');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo', 33, 'M3: Técnicas para responder rápidamente');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo', 34, 'M3: Cómo evitar errores frecuentes');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo', 35, 'M3: Simulacros del examen');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo', 36, 'M3: Práctica intensiva de speaking y writing');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo', 37, 'M3: Feedback personalizado');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo', 38, 'HW1: Exercises of grammar and new vocabulary');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo', 39, 'HW1: Short readings with questions about comprehension');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo', 40, 'HW1: Read and Select Exercises');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo', 41, 'HW1: Listen and Type practice');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo', 42, 'HW2: Timed reading comprehension exercises');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo', 43, 'HW2: Interactive reading activities');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo', 44, 'HW2: Listening comprehension exercises');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo', 45, 'HW2: Dictation and vocabulary recognition exercises');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo', 46, 'HW3: Recording of timed oral responses');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo', 47, 'HW3: Read aloud practices');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo', 48, 'HW3: Speak about the photo');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo', 49, 'HW3: Interview simulations');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo', 50, 'HW4: Writing short and long answers');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo', 51, 'HW4: Write about the photo');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo', 52, 'HW4: Interactive Writing');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo', 53, 'HW4: Corrección de escritura y estructura de textos');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo', 54, 'HW5: Mini exam simulations');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo', 55, 'HW5: Timed exercises');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo', 56, 'HW5: Error analysis and correction');
      INSERT INTO temas (curso_id, orden, descripcion) VALUES ('duolingo', 57, 'HW5: Customized improvement plan based on results');
    `);
  }

  // Migración única: cifrar los datos sensibles ya existentes (una sola vez).
  // Solo corre si hay una clave estable configurada (ENC_ENABLED).
  if (ENC_ENABLED) {
    const encFlag = await db.execute("SELECT value FROM meta WHERE key = 'datos_cifrados_v1'");
    if (!encFlag.rows[0]) {
      try {
        const ops = [];
        (await db.execute('SELECT id, telefono, email, contacto2_nombre, contacto2_relacion, contacto2_telefono, caracteristicas FROM alumnos')).rows.forEach(r =>
          ops.push({ sql: 'UPDATE alumnos SET telefono=?, email=?, contacto2_nombre=?, contacto2_relacion=?, contacto2_telefono=?, caracteristicas=? WHERE id=?',
            args: [encrypt(r.telefono), encrypt(r.email), encrypt(r.contacto2_nombre), encrypt(r.contacto2_relacion), encrypt(r.contacto2_telefono), encrypt(r.caracteristicas), r.id] }));
        (await db.execute('SELECT id, telefono, email, direccion, contacto_nombre, contacto_telefono FROM empresas')).rows.forEach(r =>
          ops.push({ sql: 'UPDATE empresas SET telefono=?, email=?, direccion=?, contacto_nombre=?, contacto_telefono=? WHERE id=?',
            args: [encrypt(r.telefono), encrypt(r.email), encrypt(r.direccion), encrypt(r.contacto_nombre), encrypt(r.contacto_telefono), r.id] }));
        (await db.execute('SELECT inscripcion_id, tutores FROM inscripciones')).rows.forEach(r =>
          ops.push({ sql: 'UPDATE inscripciones SET tutores=? WHERE inscripcion_id=?', args: [encrypt(r.tutores), r.inscripcion_id] }));
        (await db.execute('SELECT id, observaciones FROM clases')).rows.forEach(r =>
          ops.push({ sql: 'UPDATE clases SET observaciones=? WHERE id=?', args: [encrypt(r.observaciones), r.id] }));
        (await db.execute('SELECT id, observaciones FROM asistencias_generales')).rows.forEach(r =>
          ops.push({ sql: 'UPDATE asistencias_generales SET observaciones=? WHERE id=?', args: [encrypt(r.observaciones), r.id] }));
        (await db.execute('SELECT id, concepto, monto FROM pagos_alumno')).rows.forEach(r =>
          ops.push({ sql: 'UPDATE pagos_alumno SET concepto=?, monto=? WHERE id=?', args: [encrypt(r.concepto), encrypt(String(r.monto ?? 0)), r.id] }));
        if (ops.length) await db.batch(ops, 'write');
      } catch (e) { console.error('[migracion cifrado]', e.message); }
      await db.execute("INSERT OR IGNORE INTO meta (key, value) VALUES ('datos_cifrados_v1', '1')");
    }
  }

  // ── Recifrado: de la clave vieja (SESSION_SECRET) a la nueva ──
  // Corre una sola vez, y SOLO si existe una ENCRYPTION_KEY propia distinta de
  // SESSION_SECRET. Hasta que termine, decryptOrNull() sigue leyendo lo viejo
  // con la clave anterior, así que el sistema funciona igual durante la
  // transición y una migración a medias no rompe nada.
  //
  // Regla de oro: un valor que no se puede descifrar con NINGUNA de las dos
  // claves se deja intacto. Nunca se escribe encima de algo ilegible, porque
  // eso convertiría un dato recuperable en uno perdido.
  if (ENC_LEGACY_KEY) {
    const recFlag = await db.execute("SELECT value FROM meta WHERE key = 'datos_recifrados_v2'");
    if (!recFlag.rows[0]) {
      let filas = 0, ilegibles = 0;
      try {
        const ops = [];
        for (const t of ENC_COLUMNAS) {
          let rows;
          try { rows = (await db.execute(`SELECT ${t.pk}, ${t.cols.join(', ')} FROM ${t.tabla}`)).rows; }
          catch { continue; }   // tabla inexistente en esta base: se saltea
          for (const r of rows) {
            const sets = [], args = [];
            for (const c of t.cols) {
              const v = r[c];
              if (v === null || v === undefined || String(v) === '') continue;
              const s = String(v);
              if (!s.startsWith(ENC_PREFIX)) continue;               // en claro: es cosa de la v1
              if (_decryptWith(s, ENC_KEY) !== null) continue;       // ya está con la clave nueva
              const claro = _decryptWith(s, ENC_LEGACY_KEY);
              if (claro === null) { ilegibles++; continue; }         // intacto, a propósito
              sets.push(`${c} = ?`); args.push(encrypt(claro));
            }
            if (sets.length) {
              args.push(r[t.pk]);
              ops.push({ sql: `UPDATE ${t.tabla} SET ${sets.join(', ')} WHERE ${t.pk} = ?`, args });
              filas++;
            }
          }
        }
        if (ops.length) await db.batch(ops, 'write');
        console.log(`[recifrado v2] ${filas} filas recifradas con la clave nueva` +
                    (ilegibles ? `; ${ilegibles} valores ilegibles conservados sin tocar` : ''));
        await db.execute("INSERT OR IGNORE INTO meta (key, value) VALUES ('datos_recifrados_v2', '1')");
      } catch (e) {
        // Sin bandera: reintenta en el próximo arranque. Lo ya recifrado se saltea.
        console.error('[recifrado v2] fallo, se reintentara:', e.message);
      }
    }
  }

  // Eliminar tablas legacy ya migradas (pagos/asistencias por inscripción) para
  // liberar storage. Idempotente: si no existen, no hace nada.
  try { await db.execute('DROP TABLE IF EXISTS asistencias'); } catch {}
  try { await db.execute('DROP TABLE IF EXISTS pagos'); } catch {}

  ready = true;
}

// Hash de contenido de una entidad (para saltear escrituras sin cambios)
function entityHash(obj) {
  return crypto.createHash('sha1').update(JSON.stringify(obj)).digest('hex');
}

// ─────────────────────────────────────────────────────────────
//  GET /api/version  →  { version }   (1 fila leída; poll barato)
// ─────────────────────────────────────────────────────────────
app.get('/api/version', async (req, res) => {
  try {
    await initDB();
    const vr = await db.execute("SELECT value FROM meta WHERE key = 'data_version'");
    res.json({ version: vr.rows[0] ? Number(vr.rows[0].value) || 1 : 1 });
  } catch (err) {
    console.error('[GET /api/version]', err.message);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

// Ventana de sincronización delta: si el cliente está más de N versiones atrás,
// se le manda un full-load (más barato que reconstruir un delta gigante).
// Debe coincidir con el podado de lápidas en POST /api/data.
const DELTA_WINDOW = 500;

const groupBy = (rows, key) => { const m = {}; for (const r of rows) (m[r[key]] || (m[r[key]] = [])).push(r); return m; };

// Construye las entidades del cliente (courses/companies/students) a partir de
// las filas crudas. Compartido por el full-load y el delta.
function buildEntities({ cursosRows, temasRows, empresasRows, alumnosRows, inscRows, clasesRows, asistGenRows, pagosAlRows, pagosEmpRows }, isAdmin) {
  const temasByCurso   = groupBy(temasRows, 'curso_id');
  const inscByAlumno   = groupBy(inscRows, 'alumno_id');
  const clasesByInsc   = groupBy(clasesRows, 'inscripcion_id');
  const asistByAlumno  = groupBy(asistGenRows, 'alumno_id');
  const pagosByAlumno  = groupBy(pagosAlRows, 'alumno_id');
  const pagosByEmpresa = groupBy(pagosEmpRows, 'empresa_id');

  const courses = cursosRows.map(c => ({
    id: c.id, name: c.nombre,
    topics: (temasByCurso[c.id] || []).map(t => t.descripcion),
    hasHomework: !!c.has_homework, allowManual: !!c.allow_manual, notes: c.notas || '',
  }));

  const companies = empresasRows.map(e => ({
    id:           e.id,
    name:         e.nombre,
    ruc:          e.ruc               || '',
    phone:        decrypt(e.telefono)  || '',
    email:        decrypt(e.email)     || '',
    address:      decrypt(e.direccion) || '',
    modality:     e.modalidad         || '',
    diasClase:    e.dias_clase ? e.dias_clase.split(',').filter(Boolean) : [],
    horario:      e.horario           || '',
    contactName:  decrypt(e.contacto_nombre)   || '',
    contactRole:  e.contacto_cargo    || '',
    contactPhone: decrypt(e.contacto_telefono) || '',
    pagosEmpresa: (pagosByEmpresa[e.id] || []).map(p => ({
      id: p.id, studentId: p.alumno_id || null, date: p.fecha,
      concept: decrypt(p.concepto), amount: decryptNum(p.monto), paid: !!p.pagado,
    })),
  }));

  const students = alumnosRows.map(a => {
    const enrollments = (inscByAlumno[a.id] || []).map(insc => ({
      enrollId:     insc.inscripcion_id,
      courseId:     insc.curso_id,
      tutors:       (() => { const t = decrypt(insc.tutores); return t ? t.split(',').map(x => x.trim()).filter(Boolean) : []; })(),
      startDate:    insc.fecha_inicio       || '',
      estimatedEnd: insc.fecha_fin_estimada || '',
      completed:    !!insc.completado,
      classes: (clasesByInsc[insc.inscripcion_id] || []).map(cl => ({
        date: cl.fecha, startTime: cl.hora_inicio, endTime: cl.hora_fin,
        modality: cl.modalidad, topic: cl.tema, professor: cl.profesor, observations: decrypt(cl.observaciones),
        ...(cl.homework_tarea ? { homework: { task: cl.homework_tarea, done: !!cl.homework_hecho } } : {}),
      })),
      attendance: [],   // tabla legacy `asistencias` en desuso (se usa attendance a nivel alumno)
    }));

    return {
      id:               a.id,
      name:             a.nombre,
      surname:          a.apellido,
      phone:            decrypt(a.telefono)   || '',
      email:            decrypt(a.email)      || '',
      modality:         a.modalidad           || '',
      diasClase:        a.dias_clase ? a.dias_clase.split(',').filter(Boolean) : [],
      horario:          a.horario             || '',
      empresaId:        a.empresa_id          || '',
      contact2Name:     decrypt(a.contacto2_nombre)   || '',
      contact2Relation: decrypt(a.contacto2_relacion) || '',
      contact2Phone:    decrypt(a.contacto2_telefono) || '',
      caracteristicas:  decrypt(a.caracteristicas)    || '',
      estado:           a.estado || 'activo',
      payment: isAdmin ? {
        type:         a.tipo_pago          || 'mensual',
        amount:       Number(a.monto_pago) || 0,
        packageHours: a.horas_paquete ? Number(a.horas_paquete) : null,
      } : { type: a.tipo_pago || 'mensual', amount: 0, packageHours: null },
      payments: (pagosByAlumno[a.id] || []).map(p => ({
        date: p.fecha, concept: decrypt(p.concepto), amount: decryptNum(p.monto), paid: !!p.pagado,
      })),
      alertasDismissed: (() => { try { return JSON.parse(a.alertas_dismissed || '{}'); } catch { return {}; } })(),
      attendance: (asistByAlumno[a.id] || []).map(at => ({
        date: at.fecha, present: !!at.presente, hours: Number(at.horas),
        ...(at.observaciones ? { observations: decrypt(at.observaciones) } : {}),
      })),
      enrollments,
    };
  });

  return { students, courses, companies };
}

// Construye `IN (?, ?, …)` con sus args; devuelve null si la lista está vacía.
function inClause(ids) {
  if (!ids.length) return null;
  return { ph: ids.map(() => '?').join(','), args: ids };
}

// ─────────────────────────────────────────────────────────────
//  GET /api/data  →  { students, courses, companies, version }
//  Con ?since=N devuelve solo lo cambiado desde la versión N (delta),
//  siempre que N esté dentro de la ventana; si no, full-load.
// ─────────────────────────────────────────────────────────────
app.get('/api/data', async (req, res) => {
  try {
    await initDB();
    const isAdmin = req.user.role === 'admin';

    const verR = await db.execute("SELECT value FROM meta WHERE key = 'data_version'");
    const version = verR.rows[0] ? Number(verR.rows[0].value) || 1 : 1;

    const since = Number(req.query.since) || 0;
    const canDelta = since >= 1 && since <= version && since > version - DELTA_WINDOW;

    // ── DELTA: solo entidades con updated_v > since + lápidas ──
    if (canDelta) {
      const [cIdsR, eIdsR, aIdsR, delR] = await Promise.all([
        db.execute({ sql: 'SELECT id FROM cursos   WHERE updated_v > ?', args: [since] }),
        db.execute({ sql: 'SELECT id FROM empresas WHERE updated_v > ?', args: [since] }),
        db.execute({ sql: 'SELECT id FROM alumnos  WHERE updated_v > ?', args: [since] }),
        db.execute({ sql: 'SELECT entity, entity_id FROM deletions WHERE v > ?', args: [since] }),
      ]);
      const cursoIds  = cIdsR.rows.map(r => r.id);
      const empIds    = eIdsR.rows.map(r => r.id);
      const alumnoIds = aIdsR.rows.map(r => r.id);

      const cIn = inClause(cursoIds), eIn = inClause(empIds), aIn = inClause(alumnoIds);
      const empty = { rows: [] };

      const [cursosR, temasR, empresasR, alumnosR, inscR, pagosEmpR] = await Promise.all([
        cIn ? db.execute({ sql: `SELECT * FROM cursos WHERE id IN (${cIn.ph})`, args: cIn.args }) : empty,
        cIn ? db.execute({ sql: `SELECT curso_id, descripcion FROM temas WHERE curso_id IN (${cIn.ph}) GROUP BY curso_id, descripcion ORDER BY curso_id, MIN(orden)`, args: cIn.args }) : empty,
        eIn ? db.execute({ sql: `SELECT * FROM empresas WHERE id IN (${eIn.ph})`, args: eIn.args }) : empty,
        aIn ? db.execute({ sql: `SELECT * FROM alumnos WHERE id IN (${aIn.ph})`, args: aIn.args }) : empty,
        aIn ? db.execute({ sql: `SELECT * FROM inscripciones WHERE alumno_id IN (${aIn.ph}) ORDER BY rowid`, args: aIn.args }) : empty,
        (isAdmin && eIn) ? db.execute({ sql: `SELECT * FROM pagos_empresa WHERE empresa_id IN (${eIn.ph}) ORDER BY fecha`, args: eIn.args }) : empty,
      ]);

      const inscIds = inscR.rows.map(r => r.inscripcion_id);
      const iIn = inClause(inscIds);
      const [clasesR, asistGenR, pagosAlR] = await Promise.all([
        iIn ? db.execute({ sql: `SELECT * FROM clases WHERE inscripcion_id IN (${iIn.ph}) ORDER BY fecha`, args: iIn.args }) : empty,
        aIn ? db.execute({ sql: `SELECT * FROM asistencias_generales WHERE alumno_id IN (${aIn.ph}) ORDER BY fecha`, args: aIn.args }) : empty,
        (isAdmin && aIn) ? db.execute({ sql: `SELECT * FROM pagos_alumno WHERE alumno_id IN (${aIn.ph}) ORDER BY fecha`, args: aIn.args }) : empty,
      ]);

      const { students, courses, companies } = buildEntities({
        cursosRows: cursosR.rows, temasRows: temasR.rows, empresasRows: empresasR.rows,
        alumnosRows: alumnosR.rows, inscRows: inscR.rows, clasesRows: clasesR.rows,
        asistGenRows: asistGenR.rows, pagosAlRows: pagosAlR.rows, pagosEmpRows: pagosEmpR.rows,
      }, isAdmin);

      const deleted = { students: [], courses: [], companies: [] };
      for (const d of delR.rows) {
        if (d.entity === 'alumno')  deleted.students.push(d.entity_id);
        else if (d.entity === 'curso')   deleted.courses.push(d.entity_id);
        else if (d.entity === 'empresa') deleted.companies.push(d.entity_id);
      }

      return res.json({ partial: true, students, courses, companies, deleted, version });
    }

    // ── FULL-LOAD ─────────────────────────────────────────────
    const all = await fetchAllData(isAdmin);
    res.json({ students: all.students, courses: all.courses, companies: all.companies, version });
  } catch (err) {
    console.error('[GET /api/data]', err.message);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

// Carga completa de todas las entidades (usado por el GET full-load y el backup).
async function fetchAllData(isAdmin) {
  const [cursosR, temasR, empresasR, alumnosR, inscR, clasesR, asistGenR, pagosAlR, pagosEmpR, verR] = await Promise.all([
    db.execute('SELECT * FROM cursos ORDER BY rowid'),
    db.execute('SELECT curso_id, descripcion FROM temas GROUP BY curso_id, descripcion ORDER BY curso_id, MIN(orden)'),
    db.execute('SELECT * FROM empresas ORDER BY rowid'),
    db.execute('SELECT * FROM alumnos ORDER BY rowid'),
    db.execute('SELECT * FROM inscripciones ORDER BY rowid'),
    db.execute('SELECT * FROM clases ORDER BY fecha'),
    db.execute('SELECT * FROM asistencias_generales ORDER BY fecha'),
    isAdmin ? db.execute('SELECT * FROM pagos_alumno ORDER BY fecha')  : Promise.resolve({ rows: [] }),
    isAdmin ? db.execute('SELECT * FROM pagos_empresa ORDER BY fecha') : Promise.resolve({ rows: [] }),
    db.execute("SELECT value FROM meta WHERE key = 'data_version'"),
  ]);
  const { students, courses, companies } = buildEntities({
    cursosRows: cursosR.rows, temasRows: temasR.rows, empresasRows: empresasR.rows,
    alumnosRows: alumnosR.rows, inscRows: inscR.rows, clasesRows: clasesR.rows,
    asistGenRows: asistGenR.rows, pagosAlRows: pagosAlR.rows, pagosEmpRows: pagosEmpR.rows,
  }, isAdmin);
  const version = verR.rows[0] ? Number(verR.rows[0].value) || 1 : 1;
  return { students, courses, companies, version };
}

// ─────────────────────────────────────────────────────────────
//  POST /api/data  →  sincroniza todo el estado a la DB
// ─────────────────────────────────────────────────────────────
// Sanitiza strings de entrada: recorta espacios y limita longitud
function sanitizeStr(val, maxLen = 500) {
  if (val === null || val === undefined) return '';
  return String(val).trim().slice(0, maxLen);
}

app.post('/api/data', async (req, res) => {
  const { students, courses, companies } = req.body;
  if (!Array.isArray(students) || !Array.isArray(courses)) {
    return res.status(400).json({ error: 'Se esperan arrays students y courses.' });
  }
  // Límite de seguridad: evitar payloads enormes con entidades falsas
  if (students.length > 5000 || courses.length > 500 || (companies || []).length > 1000) {
    return res.status(400).json({ error: 'Demasiados registros.' });
  }

  try {
    await initDB();
  } catch (err) {
    console.error('[POST /api/data init]', err.message);
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }

  // Transacción de escritura: toma el lock ANTES de leer la versión, por lo que
  // dos usuarios guardando a la vez se serializan. El segundo ve la versión ya
  // incrementada por el primero → 409 → el cliente hace merge y reintenta.
  // Sin esto, la lectura de versión y la de IDs existentes no eran atómicas y un
  // guardado concurrente podía borrar el alumno recién creado por el otro usuario.
  let tx;
  try {
    tx = await db.transaction('write');

    // Leer versión actual del servidor (dentro de la transacción)
    let serverVersion = 1;
    const vr = await tx.execute("SELECT value FROM meta WHERE key = 'data_version'");
    if (vr.rows[0]) serverVersion = Number(vr.rows[0].value) || 1;
    const nextV = serverVersion + 1;   // versión que tendrán las entidades escritas en este guardado

    // Rechazar si el cliente envía una versión distinta a la del servidor
    // (clientVersion = 0 significa cliente viejo sin soporte de versiones → se permite)
    const clientVersion = Number(req.body.clientVersion || 0);
    if (clientVersion > 0 && clientVersion !== serverVersion) {
      await tx.rollback();
      return res.status(409).json({ error: 'conflict', serverVersion, message: 'Datos desactualizados. Recargue la página.' });
    }

    // Snapshots consistentes dentro de la misma transacción (id + hash de contenido).
    // Se traen también los nombres: mismas filas leídas, y permiten que la bitácora
    // diga "borró al alumno Juan Pérez" en vez de solo el id.
    // Los hashes por colección hija (asist_hash, pagos_hash) permiten saltear la
    // reescritura de asistencias y pagos cuando no cambiaron.
    const existCursosR   = await tx.execute('SELECT id, data_hash, nombre FROM cursos');
    const existAlumnosR  = await tx.execute('SELECT id, data_hash, nombre, apellido, asist_hash, pagos_hash FROM alumnos');
    const existEmpresasR = await tx.execute('SELECT id, data_hash, nombre FROM empresas');
    const existCursoIds   = existCursosR.rows.map(r => r.id);
    const existAlumnoIds  = existAlumnosR.rows.map(r => r.id);
    const existEmpresaIds = existEmpresasR.rows.map(r => r.id);
    const cursoHash   = {}; existCursosR.rows.forEach(r => { cursoHash[r.id]   = r.data_hash; });
    const alumnoHash  = {}; existAlumnosR.rows.forEach(r => { alumnoHash[r.id]  = r.data_hash; });
    const empresaHash = {}; existEmpresasR.rows.forEach(r => { empresaHash[r.id] = r.data_hash; });
    // Hashes de las colecciones hijas (para saltear reescrituras que no cambiaron)
    const asistHashDB = {}; existAlumnosR.rows.forEach(r => { asistHashDB[r.id] = r.asist_hash || ''; });
    const pagosHashDB = {}; existAlumnosR.rows.forEach(r => { pagosHashDB[r.id] = r.pagos_hash || ''; });

    const newCursoIds   = courses.map(c => c.id);
    const newAlumnoIds  = students.map(s => s.id);
    const newEmpresaIds = (companies || []).map(c => c.id);

    // Modo parcial (POST por-entidad): el cliente manda SOLO lo que cambió + una
    // lista explícita de borrados. En modo completo (legacy), los borrados se
    // infieren por diferencia de IDs contra lo existente.
    const partial = req.body.partial === true;
    const delIn = req.body.deletions || {};
    const delCursos   = partial ? (Array.isArray(delIn.courses)   ? delIn.courses   : []) : existCursoIds.filter(id => !newCursoIds.includes(id));
    const delEmpresas = partial ? (Array.isArray(delIn.companies) ? delIn.companies : []) : existEmpresaIds.filter(id => !newEmpresaIds.includes(id));
    const delAlumnos  = partial ? (Array.isArray(delIn.students)  ? delIn.students  : []) : existAlumnoIds.filter(id => !newAlumnoIds.includes(id));
    // Los usuarios comunes no pueden escribir datos de pago ni crear/editar/eliminar
    // alumnos, empresas ni cursos: solo registran clases, asistencia y tareas.
    const isAdminSave = req.user.role === 'admin';
    if (!isAdminSave) { delEmpresas.length = 0; delAlumnos.length = 0; delCursos.length = 0; }

    if (delCursos.length > 500 || delEmpresas.length > 1000 || delAlumnos.length > 5000) {
      await tx.rollback();
      return res.status(400).json({ error: 'Demasiados borrados.' });
    }

    const batch = [];
    let changed = false;   // ¿hubo algún cambio real? (si no, no se escribe ni se sube la versión)

    // ── Bitácora de este guardado ────────────────────────────
    // Se acumulan aquí y se convierten en filas al final, dentro del MISMO
    // batch: cero transacciones extra, cero round trips extra.
    const eventos = [];
    const nombreAlumno = id => {
      const r = existAlumnosR.rows.find(x => x.id === id);
      return r ? `${r.nombre || ''} ${r.apellido || ''}`.trim() : id;
    };
    const anotar = (accion, entidad, entidadId, nombre) => eventos.push({
      tipo: 'dato', accion, entidad, entidadId,
      usuarioId: req.user.id, usuario: req.user.username,
      detalle: nombre || entidadId,
    });

    // ── CURSOS ───────────────────────────────────────────────
    delCursos.filter(id => existCursoIds.includes(id)).forEach(id => {
      changed = true;
      anotar('borrar', 'curso', id, (existCursosR.rows.find(x => x.id === id) || {}).nombre);
      batch.push({ sql: 'DELETE FROM cursos WHERE id = ?', args: [id] });
      batch.push({ sql: 'INSERT INTO deletions (entity, entity_id, v) VALUES (?, ?, ?)', args: ['curso', id, nextV] });
    });
    // Cursos y temas: solo el admin los crea/edita. Lo que mande un no-admin se ignora.
    (isAdminSave ? courses : []).forEach(c => {
      const h = entityHash(c);
      if (cursoHash[c.id] === h) return;   // sin cambios: no reescribir
      changed = true;
      anotar(existCursoIds.includes(c.id) ? 'editar' : 'crear', 'curso', c.id, c.name);
      batch.push({ sql: 'INSERT INTO cursos (id, nombre, has_homework, allow_manual, notas, data_hash, updated_v) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET nombre = excluded.nombre, has_homework = excluded.has_homework, allow_manual = excluded.allow_manual, notas = excluded.notas, data_hash = excluded.data_hash, updated_v = excluded.updated_v', args: [c.id, c.name, c.hasHomework ? 1 : 0, c.allowManual ? 1 : 0, sanitizeStr(c.notes || '', 5000), h, nextV] });
      batch.push({ sql: 'DELETE FROM temas WHERE curso_id = ?', args: [c.id] });
      (c.topics || []).forEach((t, i) => batch.push({ sql: 'INSERT INTO temas (curso_id, orden, descripcion) VALUES (?, ?, ?)', args: [c.id, i, t] }));
    });

    // ── EMPRESAS ─────────────────────────────────────────────
    delEmpresas.filter(id => existEmpresaIds.includes(id)).forEach(id => {
      changed = true;
      anotar('borrar', 'empresa', id, (existEmpresasR.rows.find(x => x.id === id) || {}).nombre);
      batch.push({ sql: 'DELETE FROM empresas WHERE id = ?', args: [id] });
      batch.push({ sql: 'INSERT INTO deletions (entity, entity_id, v) VALUES (?, ?, ?)', args: ['empresa', id, nextV] });
    });
    // Las empresas solo las escribe el admin: el usuario común no tiene nada que guardar en ellas.
    (isAdminSave ? (companies || []) : []).forEach(c => {
      const h = entityHash(c);
      if (empresaHash[c.id] === h) return;   // sin cambios: no reescribir
      changed = true;
      anotar(existEmpresaIds.includes(c.id) ? 'editar' : 'crear', 'empresa', c.id, c.name);
      batch.push({
        sql: `INSERT INTO empresas (id, nombre, ruc, telefono, email, direccion, modalidad, dias_clase, horario, contacto_nombre, contacto_cargo, contacto_telefono, data_hash, updated_v)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                nombre = excluded.nombre, ruc = excluded.ruc, telefono = excluded.telefono,
                email = excluded.email, direccion = excluded.direccion, modalidad = excluded.modalidad,
                dias_clase = excluded.dias_clase, horario = excluded.horario,
                contacto_nombre = excluded.contacto_nombre, contacto_cargo = excluded.contacto_cargo,
                contacto_telefono = excluded.contacto_telefono, data_hash = excluded.data_hash, updated_v = excluded.updated_v`,
        args: [
          c.id, c.name, c.ruc||'', encrypt(c.phone||''), encrypt(c.email||''), encrypt(c.address||''),
          c.modality||'', (c.diasClase||[]).join(','), c.horario||'',
          encrypt(c.contactName||''), c.contactRole||'', encrypt(c.contactPhone||''),
          h, nextV,
        ],
      });

      batch.push({ sql: 'DELETE FROM pagos_empresa WHERE empresa_id = ?', args: [c.id] });
      (c.pagosEmpresa || []).forEach((p, j) => batch.push({
        sql: 'INSERT INTO pagos_empresa (id, empresa_id, alumno_id, fecha, concepto, monto, pagado) VALUES (?, ?, ?, ?, ?, ?, ?)',
        args: [p.id || `${c.id}-EP-${j}`, c.id, p.studentId || '', p.date || '', encrypt(sanitizeStr(p.concept, 300)), encrypt(String(Number(p.amount) || 0)), p.paid ? 1 : 0],
      }));
    });

    // ── ALUMNOS ──────────────────────────────────────────────
    delAlumnos.filter(id => existAlumnoIds.includes(id)).forEach(id => {
      changed = true;
      anotar('borrar', 'alumno', id, nombreAlumno(id));
      batch.push({ sql: 'DELETE FROM alumnos WHERE id = ?', args: [id] });
      batch.push({ sql: 'INSERT INTO deletions (entity, entity_id, v) VALUES (?, ?, ?)', args: ['alumno', id, nextV] });
    });

    // Determinar qué alumnos cambiaron realmente (por hash) antes de leer sus inscripciones.
    // El usuario común no puede dar de alta alumnos: solo tocar los que ya existen.
    const dirtyStudents = students.filter(s =>
      alumnoHash[s.id] !== entityHash(s) && (isAdminSave || existAlumnoIds.includes(s.id)));

    // Solo se necesitan las inscripciones existentes de los alumnos que cambiaron
    const existEnrByAlumno = {};
    const clasesHashDB = {};   // inscripcion_id → hash de sus clases en la DB
    if (dirtyStudents.length) {
      const enrResult = await tx.execute('SELECT inscripcion_id, alumno_id, clases_hash FROM inscripciones');
      enrResult.rows.forEach(r => {
        if (!existEnrByAlumno[r.alumno_id]) existEnrByAlumno[r.alumno_id] = [];
        existEnrByAlumno[r.alumno_id].push(r.inscripcion_id);
        clasesHashDB[r.inscripcion_id] = r.clases_hash || '';
      });
    }

    // No-admin: los datos de ficha (nombre, contacto, empresa, estado, pago) quedan
    // como están en la DB — solo se actualizan alertas descartadas, hash y versión.
    // Las columnas que no aparecen en el UPDATE SET conservan su valor actual.
    const alumnoSet = isAdminSave
      ? `nombre = excluded.nombre, apellido = excluded.apellido, telefono = excluded.telefono,
         email = excluded.email, modalidad = excluded.modalidad,
         dias_clase = excluded.dias_clase, horario = excluded.horario, empresa_id = excluded.empresa_id,
         contacto2_nombre = excluded.contacto2_nombre, contacto2_relacion = excluded.contacto2_relacion,
         contacto2_telefono = excluded.contacto2_telefono, caracteristicas = excluded.caracteristicas,
         estado = excluded.estado,
         tipo_pago = excluded.tipo_pago, monto_pago = excluded.monto_pago, horas_paquete = excluded.horas_paquete,
         alertas_dismissed = excluded.alertas_dismissed, asist_hash = excluded.asist_hash, pagos_hash = excluded.pagos_hash,
         data_hash = excluded.data_hash, updated_v = excluded.updated_v`
      : 'alertas_dismissed = excluded.alertas_dismissed, asist_hash = excluded.asist_hash, data_hash = excluded.data_hash, updated_v = excluded.updated_v';

    dirtyStudents.forEach(s => {
      changed = true;
      anotar(existAlumnoIds.includes(s.id) ? 'editar' : 'crear', 'alumno', s.id,
             `${s.name || ''} ${s.surname || ''}`.trim());
      const h = entityHash(s);
      const asistHashNew = entityHash(s.attendance || []);
      const pagosHashNew = entityHash(s.payments || []);
      const estadoVal = ['activo', 'pausado', 'finalizado'].includes(s.estado) ? s.estado : 'activo';
      const pay = s.payment || {};
      batch.push({
        sql: `INSERT INTO alumnos (id, nombre, apellido, telefono, email, modalidad, dias_clase, horario, empresa_id, contacto2_nombre, contacto2_relacion, contacto2_telefono, caracteristicas, alertas_dismissed, estado, tipo_pago, monto_pago, horas_paquete, asist_hash, pagos_hash, data_hash, updated_v)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET ${alumnoSet}`,
        args: [
          sanitizeStr(s.id, 100), sanitizeStr(s.name, 100), sanitizeStr(s.surname, 100),
          encrypt(sanitizeStr(s.phone, 50)), encrypt(sanitizeStr(s.email, 200)), sanitizeStr(s.modality, 50),
          (s.diasClase||[]).map(d => sanitizeStr(d, 20)).join(','),
          sanitizeStr(s.horario, 100), sanitizeStr(s.empresaId, 100),
          encrypt(sanitizeStr(s.contact2Name, 100)), encrypt(sanitizeStr(s.contact2Relation, 100)),
          encrypt(sanitizeStr(s.contact2Phone, 50)), encrypt(sanitizeStr(s.caracteristicas, 2000)),
          JSON.stringify(s.alertasDismissed || {}),
          estadoVal, sanitizeStr(pay.type || 'mensual', 30), Number(pay.amount) || 0,
          pay.packageHours ? Number(pay.packageHours) : null, asistHashNew, pagosHashNew, h, nextV,
        ],
      });

      // Asistencias: reescribir solo si cambiaron (evita reescribir historial entero)
      if (asistHashDB[s.id] !== asistHashNew) {
        batch.push({ sql: 'DELETE FROM asistencias_generales WHERE alumno_id = ?', args: [s.id] });
        (s.attendance || []).forEach(at => batch.push({
          sql: 'INSERT INTO asistencias_generales (alumno_id, fecha, presente, horas, observaciones) VALUES (?, ?, ?, ?, ?)',
          args: [s.id, at.date||'', at.present ? 1 : 0, at.hours||0, encrypt(at.observations||'')],
        }));
      }

      // Pagos unificados por alumno (cifrados) — solo el admin, y solo si cambiaron
      if (isAdminSave && pagosHashDB[s.id] !== pagosHashNew) {
        batch.push({ sql: 'DELETE FROM pagos_alumno WHERE alumno_id = ?', args: [s.id] });
        (s.payments || []).forEach((p, j) => batch.push({
          sql: 'INSERT INTO pagos_alumno (id, alumno_id, fecha, concepto, monto, pagado) VALUES (?, ?, ?, ?, ?, ?)',
          args: [`${s.id}-PAY-${j}`, s.id, p.date||'', encrypt(sanitizeStr(p.concept, 300)), encrypt(String(Number(p.amount)||0)), p.paid ? 1 : 0],
        }));
      }

      const existEnrIds = existEnrByAlumno[s.id] || [];
      const newEnrIds   = (s.enrollments || []).map(e => e.enrollId);
      existEnrIds.filter(id => !newEnrIds.includes(id)).forEach(id =>
        batch.push({ sql: 'DELETE FROM inscripciones WHERE inscripcion_id = ?', args: [id] })
      );

      (s.enrollments || []).forEach((enr, _i) => {
        const clasesHashNew = entityHash(enr.classes || []);
        batch.push({
          sql: `INSERT INTO inscripciones (inscripcion_id, alumno_id, curso_id, tutores, tipo_pago, monto_pago, horas_paquete, fecha_inicio, fecha_fin_estimada, completado, clases_hash)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(inscripcion_id) DO UPDATE SET
                  curso_id = excluded.curso_id, tutores = excluded.tutores, tipo_pago = excluded.tipo_pago,
                  monto_pago = excluded.monto_pago, horas_paquete = excluded.horas_paquete,
                  fecha_inicio = excluded.fecha_inicio,
                  fecha_fin_estimada = excluded.fecha_fin_estimada, completado = excluded.completado,
                  clases_hash = excluded.clases_hash`,
          args: [enr.enrollId, s.id, enr.courseId, encrypt((enr.tutors||[]).join(', ')),
                 'mensual', 0, null,  // config de pago migrada a nivel alumno; columnas legacy sin uso
                 enr.startDate||'', enr.estimatedEnd||'', enr.completed ? 1 : 0, clasesHashNew],
        });

        // Clases: reescribir solo si cambiaron (no al tomar asistencia u otro cambio del alumno)
        if (clasesHashDB[enr.enrollId] !== clasesHashNew) {
          batch.push({ sql: 'DELETE FROM clases WHERE inscripcion_id = ?', args: [enr.enrollId] });
          (enr.classes || []).forEach((cl, j) => batch.push({
            sql: 'INSERT INTO clases (id, inscripcion_id, fecha, hora_inicio, hora_fin, modalidad, tema, profesor, observaciones, homework_tarea, homework_hecho) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            args: [`${enr.enrollId}-CL-${j}`, enr.enrollId, cl.date||'', cl.startTime||'', cl.endTime||'', cl.modality||'', cl.topic||'', cl.professor||'', encrypt(cl.observations||''), cl.homework?.task||'', cl.homework?.done ? 1 : 0],
          }));
        }
        // (La tabla legacy `asistencias` por inscripción ya no se usa — el GET lee
        //  asistencias_generales. Se omite para no gastar writes.)
      });
    });

    // Si no hubo ningún cambio real, no se escribe nada (ni se sube la versión).
    if (!changed) {
      await tx.rollback();
      return res.json({ ok: true, newVersion: serverVersion, unchanged: true });
    }

    // ── Bitácora: al batch, dentro de la misma transacción ───
    // Por encima del tope se escribe una sola fila resumen: un guardado masivo
    // no puede inflar la cola con cientos de filas.
    if (eventos.length > LOG_MAX_POR_REQUEST) {
      const porTipo = eventos.reduce((a, e) => { a[e.accion] = (a[e.accion] || 0) + 1; return a; }, {});
      batch.push(logStmt({
        tipo: 'dato', accion: 'guardado_masivo',
        usuarioId: req.user.id, usuario: req.user.username,
        detalle: `${eventos.length} cambios (` +
                 Object.entries(porTipo).map(([k, n]) => `${k}: ${n}`).join(', ') + ')',
      }));
    } else {
      eventos.forEach(e => batch.push(logStmt(e)));
    }

    // Incrementar versión en el mismo batch atómico
    const newVersion = nextV;
    batch.push({
      sql: "INSERT INTO meta (key, value) VALUES ('data_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      args: [String(newVersion)],
    });
    // Podar lápidas viejas (el delta solo se soporta dentro de la ventana DELTA_WINDOW)
    batch.push({ sql: 'DELETE FROM deletions WHERE v < ?', args: [newVersion - DELTA_WINDOW] });

    await tx.batch(batch);
    await tx.commit();
    res.json({ ok: true, newVersion });
  } catch (err) {
    try { if (tx) await tx.rollback(); } catch {}
    console.error('[POST /api/data]', err.message);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

// ── Inicio local ──────────────────────────────────────────────
if (require.main === module) {
  app.listen(PORT, () => console.log(`\n  Keynes corriendo en http://localhost:${PORT}\n`));
}

module.exports = app;
