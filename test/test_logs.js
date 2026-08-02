process.env.TURSO_DATABASE_URL = 'file:test.db';
const assert = require('assert');
const path = require('path');
process.env.SESSION_SECRET = 'test-secret';
process.env.APP_PASSWORD = 'Demo!1234!';
process.env.CRON_SECRET = 'cron-xyz';
const app = require(path.join(__dirname, '..', 'server.js'));
const { createClient } = require('@libsql/client');
const db = createClient({ url: 'file:test.db' });

const login = (b, u, p) => fetch(b + '/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `username=${u}&password=${encodeURIComponent(p)}` });
const ckOf = r => { const s = r.headers.get('set-cookie'); return s ? s.split(';')[0] : null; };
const post = (b, ck, body) => fetch(b + '/api/data', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ck }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, json: await r.json() }));
const getData = (b, ck) => fetch(b + '/api/data', { headers: { Cookie: ck } }).then(r => r.json());
const cron = b => fetch(b + '/api/cron/backup', { headers: { Authorization: 'Bearer cron-xyz' } }).then(r => r.json());
const mk = (id, name) => ({ id, name, surname: 'Test', estado: 'activo', payment: { type: 'mensual', amount: 100, packageHours: null }, payments: [], attendance: [], enrollments: [] });

const logs  = async () => (await db.execute('SELECT * FROM logs ORDER BY id')).rows;
const wipe  = async () => { try { await db.execute('DELETE FROM logs'); } catch {} };
// test.db es compartido entre tests: los alumnos de prueba se limpian antes y
// después para que este archivo no dependa de -ni ensucie- a los demás.
const limpiarAlumnos = async () => {
  try { await db.execute("DELETE FROM alumnos WHERE id LIKE 'LOG%' OR id LIKE 'MASS%'"); } catch {}
};

// Intercepta solo las llamadas a Resend; el resto (el propio servidor) pasa derecho.
const realFetch = global.fetch;
let resendOk = false, resendCalls = [];
global.fetch = (url, opts) => {
  if (String(url).includes('api.resend.com')) {
    resendCalls.push(JSON.parse(opts.body));
    return Promise.resolve({ ok: resendOk, status: resendOk ? 200 : 500, text: () => Promise.resolve('') });
  }
  return realFetch(url, opts);
};

(async () => {
  const server = app.listen(0); await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  await limpiarAlumnos();

  // ── 1. login OK deja constancia ──────────────────────────
  await wipe();
  const ck = ckOf(await login(base, 'admin', 'Demo!1234!'));
  let L = await logs();
  assert.equal(L.length, 1, 'login OK escribe 1 fila');
  assert.equal(L[0].tipo, 'auth');
  assert.equal(L[0].accion, 'login_ok');
  assert.equal(L[0].usuario, 'admin');

  // ── 2. login fallido también, y sin filtrar la contraseña ──
  await wipe();
  await login(base, 'admin', 'clave-incorrecta-xyz');
  L = await logs();
  assert.equal(L.length, 1, 'login fallido escribe 1 fila');
  assert.equal(L[0].accion, 'login_fallido');
  assert.ok(!JSON.stringify(L[0]).includes('clave-incorrecta-xyz'), 'la contraseña NUNCA se registra');

  // ── 3. detalle cifrado en reposo ─────────────────────────
  await wipe();
  // courses:[] a propósito. En una base recién creada los cursos vienen del
  // schema.sql sin data_hash, así que reenviarlos los marcaría a todos como
  // cambiados y el conteo dependería del estado previo de test.db.
  const init = await getData(base, ck);
  await post(base, ck, { students: [mk('LOG1', 'Zoraida')], courses: [], companies: [], clientVersion: init.version, partial: true });
  L = await logs();
  assert.equal(L.length, 1, '1 alumno cambiado = 1 fila, no 40');
  assert.equal(L[0].accion, 'crear');
  assert.equal(L[0].entidad, 'alumno');
  assert.ok(!L[0].detalle.includes('Zoraida'), 'detalle cifrado en la base');

  // ── 4. una fila por entidad cambiada, no por campo ────────
  await wipe();
  let v = (await getData(base, ck)).version;
  const r4 = await post(base, ck, { students: [mk('LOG2', 'Ana'), mk('LOG3', 'Beto')], courses: [], companies: [], clientVersion: v, partial: true });
  assert.equal(r4.status, 200);
  L = await logs();
  assert.equal(L.length, 2, '2 alumnos = exactamente 2 filas');

  // ── 5. guardar sin cambios no escribe nada ───────────────
  await wipe();
  v = (await getData(base, ck)).version;
  await post(base, ck, { students: [], courses: [], companies: [], clientVersion: v, partial: true });
  assert.equal((await logs()).length, 0, 'guardado sin cambios = 0 filas');

  // ── 6. guardado masivo colapsa en 1 fila resumen ─────────
  await wipe();
  v = (await getData(base, ck)).version;
  const muchos = Array.from({ length: 60 }, (_, i) => mk('MASS' + i, 'A' + i));
  await post(base, ck, { students: muchos, courses: [], companies: [], clientVersion: v, partial: true });
  L = await logs();
  assert.equal(L.length, 1, '60 cambios = 1 fila resumen, no 60');
  assert.equal(L[0].accion, 'guardado_masivo');

  // ── 7. EL TEST QUE IMPORTA: si el correo falla, NO se borra ──
  await wipe();
  v = (await getData(base, ck)).version;
  await post(base, ck, { students: [mk('LOG4', 'Carla')], courses: [], companies: [], clientVersion: v, partial: true });
  const antes = (await logs()).length;
  assert.ok(antes > 0, 'hay logs para enviar');

  process.env.RESEND_API_KEY = 'test-key';
  resendOk = false; resendCalls = [];
  const c1 = await cron(base);
  assert.equal(c1.logs.enviado, false, 'correo falló');
  assert.equal(c1.logs.borrados, 0, 'no borró nada');
  assert.equal((await logs()).length, antes, 'LOS LOGS SIGUEN AHÍ tras fallar el correo');

  // ── 8. si el correo sale OK, recién ahí se vacía ─────────
  resendOk = true; resendCalls = [];
  const c2 = await cron(base);
  assert.equal(c2.logs.enviado, true, 'correo enviado');
  assert.equal(c2.logs.eventos, antes, 'envió todos los eventos pendientes');
  assert.equal((await logs()).length, 0, 'recién ahora la cola quedó vacía');

  // ── 9. el correo lleva texto legible + adjunto JSON ──────
  const mail = resendCalls.find(m => String(m.subject).includes('Actividad'));
  assert.ok(mail, 'se mandó el correo de actividad');
  assert.ok(mail.text.includes('Carla'), 'el cuerpo muestra el nombre descifrado');
  assert.equal(mail.attachments.length, 1, 'un adjunto');
  assert.ok(/^keynes-logs-\d{4}-\d{2}-\d{2}\.json$/.test(mail.attachments[0].filename), 'nombre del adjunto');
  const adj = JSON.parse(Buffer.from(mail.attachments[0].content, 'base64').toString('utf8'));
  assert.ok(Array.isArray(adj) && adj.length === antes, 'el JSON adjunto trae los eventos');
  assert.ok(adj.some(e => String(e.detalle).includes('Carla')), 'el JSON viene descifrado');

  // ── 10. sin actividad: avisa igual (su ausencia sería ambigua) ──
  resendCalls = [];
  const c3 = await cron(base);
  assert.equal(c3.logs.eventos, 0);
  const vacio = resendCalls.find(m => String(m.subject).includes('Actividad'));
  assert.ok(vacio.text.includes('Sin actividad'), 'avisa que no hubo actividad');
  assert.ok(!vacio.attachments, 'sin eventos no adjunta JSON');

  // ── 11. la IP no queda en ningún lado ────────────────────
  await wipe();
  await login(base, 'admin', 'Demo!1234!');
  await login(base, 'fantasma', 'malaclave');
  const filas = await logs();
  assert.ok(filas.length >= 2, 'hay filas de acceso para revisar');
  assert.ok(!('ip' in filas[0]), 'la columna ip ya no existe en la tabla');
  const crudo = JSON.stringify(filas);
  assert.ok(!/127\.0\.0\.1|::1|::ffff:/.test(crudo), 'ninguna IP guardada en la base');

  resendOk = true; resendCalls = [];
  await cron(base);
  const m2 = resendCalls.find(x => String(x.subject).includes('Actividad'));
  assert.ok(!/127\.0\.0\.1|::1|::ffff:/.test(m2.text), 'ninguna IP en el cuerpo del correo');
  assert.ok(!/127\.0\.0\.1|::1|::ffff:/.test(Buffer.from(m2.attachments[0].content, 'base64').toString('utf8')),
            'ninguna IP en el JSON adjunto');

  // ── 12. borrado de usuario queda registrado ──────────────
  await wipe();
  await fetch(base + '/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ck }, body: JSON.stringify({ username: 'temporal', password: 'clave123', nombre: 'Temp', role: 'usuario' }) });
  L = await logs();
  assert.equal(L.length, 1, 'crear usuario escribe 1 fila');
  assert.equal(L[0].tipo, 'usuario');
  assert.ok(!JSON.stringify(L[0]).includes('clave123'), 'la contraseña del alta NUNCA se registra');

  delete process.env.RESEND_API_KEY;
  await wipe();
  await limpiarAlumnos();
  server.close();
  console.log('PASS logs: registro + cifrado + tope + el correo vacía la cola SOLO si sale bien');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
