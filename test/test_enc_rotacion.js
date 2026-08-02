// Rotacion de clave de cifrado.
//
// Situacion real: nunca se definio ENCRYPTION_KEY, asi que todo quedo cifrado
// con SESSION_SECRET. Rotar SESSION_SECRET hoy dejaria los datos ilegibles para
// siempre. Este test verifica el camino de salida:
//   A       -> datos cifrados con SESSION_SECRET
//   A + B   -> se agrega ENCRYPTION_KEY: se leen igual y se recifran con B
//   C + B   -> se rota SESSION_SECRET: los datos SIGUEN legibles
//
// Cada fase corre en su propio proceso porque las claves se derivan al cargar
// el modulo. El padre se relanza a si mismo con distinto entorno.
const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DB   = path.join(ROOT, 'rot.db');
const A = 'clave-vieja-session-secret-AAA';
const B = 'clave-nueva-encryption-key-BBB';
const C = 'session-secret-rotada-CCC';

// Replica del formato de cifrado del servidor, para inspeccionar la base cruda.
const kdf = s => crypto.scryptSync(s, 'keynes-enc-v1', 32);
function pruebaDescifrar(valor, clave) {
  try {
    const p = String(valor).split(':');
    const d = crypto.createDecipheriv('aes-256-gcm', kdf(clave), Buffer.from(p[2], 'hex'));
    d.setAuthTag(Buffer.from(p[3], 'hex'));
    return Buffer.concat([d.update(Buffer.from(p[4], 'hex')), d.final()]).toString('utf8');
  } catch { return null; }
}
function cifrarCon(texto, clave) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', kdf(clave), iv);
  const ct = Buffer.concat([c.update(texto, 'utf8'), c.final()]);
  return 'enc:v1:' + iv.toString('hex') + ':' + c.getAuthTag().toString('hex') + ':' + ct.toString('hex');
}

const ALUMNO = {
  id: 'ROT-1', name: 'Zoraida', surname: 'Benitez',
  phone: '0981-123456', email: 'zoraida@ejemplo.com', modality: 'presencial',
  diasClase: [], horario: '', empresaId: '', estado: 'activo',
  contact2Name: 'Marta', contact2Relation: 'madre', contact2Phone: '0981-999',
  caracteristicas: 'nota reservada sobre la alumna',
  payment: { type: 'mensual', amount: 350000, packageHours: null },
  payments: [{ date: '2026-06-01', concept: 'Junio', amount: 350000, paid: true }],
  attendance: [{ date: '2026-06-03', present: true, hours: 2, observations: 'muy participativa' }],
  alertasDismissed: {},
  enrollments: [{ enrollId: 'ROT-1-E1', courseId: 'excel-avanzado', tutors: ['Prof. Lopez'],
    startDate: '2026-06-01', estimatedEnd: '', completed: false,
    classes: [{ date: '2026-06-03', startTime: '18:00', endTime: '20:00', modality: 'presencial',
      topic: 'Tablas', professor: 'Prof. Lopez', observations: 'observacion privada de clase',
      homework: { task: '', done: false } }] }],
};

// ── Hijo: arranca el servidor y ejecuta la fase pedida ───────
async function hijo(fase) {
  const app = require(path.join(ROOT, 'server.js'));
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const ck = await fetch(base + '/login', { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=admin&password=' + encodeURIComponent('Demo!1234!'),
  }).then(r => (r.headers.get('set-cookie') || '').split(';')[0]);
  assert.ok(ck, 'login OK en fase ' + fase);

  if (fase === 'cargar') {
    const v = (await fetch(base + '/api/data', { headers: { Cookie: ck } }).then(r => r.json())).version;
    const r = await fetch(base + '/api/data', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ck },
      body: JSON.stringify({ students: [ALUMNO], courses: [], companies: [], clientVersion: v, partial: true }),
    });
    assert.equal(r.status, 200, 'se cargo el alumno');
    await fetch(base + '/api/soporte', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ck },
      body: JSON.stringify({ asunto: 'asunto reservado', mensaje: 'mensaje reservado' }) });
  }

  if (fase === 'leer') {
    const d = await fetch(base + '/api/data', { headers: { Cookie: ck } }).then(r => r.json());
    const s = d.students.find(x => x.id === 'ROT-1');
    assert.ok(s, 'el alumno sigue existiendo');
    assert.equal(s.phone, '0981-123456', 'telefono legible');
    assert.equal(s.email, 'zoraida@ejemplo.com', 'email legible');
    assert.equal(s.caracteristicas, 'nota reservada sobre la alumna', 'caracteristicas legibles');
    assert.equal(s.contact2Name, 'Marta', 'contacto 2 legible');
    assert.equal(s.payments[0].amount, 350000, 'monto legible');
    assert.equal(s.payments[0].concept, 'Junio', 'concepto legible');
    assert.equal(s.attendance[0].observations, 'muy participativa', 'observacion de asistencia legible');
    assert.equal(s.enrollments[0].classes[0].observations, 'observacion privada de clase', 'observacion de clase legible');
    assert.deepStrictEqual(s.enrollments[0].tutors, ['Prof. Lopez'], 'tutores legibles');
  }

  server.close();
  process.exit(0);
}

if (process.argv[2]) {
  hijo(process.argv[2]).catch(e => { console.error('FAIL(' + process.argv[2] + '):', e.message); process.exit(1); });
} else {
  // ── Padre: orquesta las tres fases ────────────────────────
  const { createClient } = require(path.join(ROOT, 'node_modules/@libsql/client'));
  const correr = (fase, env) => {
    const r = spawnSync(process.execPath, [__filename, fase], {
      encoding: 'utf8',
      env: { ...process.env, TURSO_DATABASE_URL: 'file:' + DB, APP_PASSWORD: 'Demo!1234!', ...env },
    });
    if (r.status !== 0) { console.error((r.stdout || '') + (r.stderr || '')); throw new Error('fase ' + fase + ' fallo'); }
    return r;
  };

  (async () => {
    for (const f of ['rot.db', 'rot.db-wal', 'rot.db-shm']) { try { fs.unlinkSync(path.join(ROOT, f)); } catch {} }

    // ── FASE 1: solo SESSION_SECRET=A (produccion hoy) ──────
    correr('cargar', { SESSION_SECRET: A, ENCRYPTION_KEY: '' });
    const db = createClient({ url: 'file:' + DB });
    let raw = (await db.execute("SELECT telefono, caracteristicas FROM alumnos WHERE id='ROT-1'")).rows[0];
    assert.ok(String(raw.telefono).startsWith('enc:v1:'), 'quedo cifrado en la base');
    assert.equal(pruebaDescifrar(raw.telefono, A), '0981-123456', 'cifrado con la clave vieja A');
    assert.equal(pruebaDescifrar(raw.telefono, B), null, 'la clave nueva B todavia no sirve');

    // Un valor corrupto/ajeno: la migracion NO lo debe pisar
    const basura = cifrarCon('dato de otra clave', 'clave-desconocida-ZZZ');
    await db.execute({ sql: "UPDATE alumnos SET contacto2_telefono = ? WHERE id='ROT-1'", args: [basura] });

    // ── FASE 2: se agrega ENCRYPTION_KEY=B ─────────────────
    correr('leer', { SESSION_SECRET: A, ENCRYPTION_KEY: B });   // legible durante la transicion
    raw = (await db.execute("SELECT telefono, email, caracteristicas, contacto2_telefono FROM alumnos WHERE id='ROT-1'")).rows[0];
    assert.equal(pruebaDescifrar(raw.telefono, B), '0981-123456', 'recifrado con la clave nueva B');
    assert.equal(pruebaDescifrar(raw.telefono, A), null, 'la clave vieja A ya no abre el dato');
    assert.equal(pruebaDescifrar(raw.caracteristicas, B), 'nota reservada sobre la alumna', 'caracteristicas recifradas');
    assert.equal(raw.contacto2_telefono, basura, 'el valor ilegible quedo INTACTO, no se piso');

    // Tablas que la migracion v1 no cubria
    const sop = (await db.execute('SELECT asunto, mensaje FROM soporte_mensajes LIMIT 1')).rows[0];
    assert.equal(pruebaDescifrar(sop.asunto, B), 'asunto reservado', 'soporte recifrado');
    assert.equal(pruebaDescifrar(sop.mensaje, B), 'mensaje reservado', 'mensaje de soporte recifrado');
    const cl = (await db.execute("SELECT observaciones FROM clases WHERE inscripcion_id='ROT-1-E1'")).rows[0];
    assert.equal(pruebaDescifrar(cl.observaciones, B), 'observacion privada de clase', 'clases recifradas');
    const pg = (await db.execute("SELECT concepto, monto FROM pagos_alumno WHERE alumno_id='ROT-1'")).rows[0];
    assert.equal(pruebaDescifrar(pg.monto, B), '350000', 'montos recifrados');
    const flag = (await db.execute("SELECT value FROM meta WHERE key='datos_recifrados_v2'")).rows[0];
    assert.ok(flag, 'la migracion quedo marcada como hecha');

    // ── FASE 3: se rota SESSION_SECRET a C. Lo que importa. ─
    correr('leer', { SESSION_SECRET: C, ENCRYPTION_KEY: B });

    // ── FASE 4: idempotencia, correr de nuevo no rompe nada ─
    correr('leer', { SESSION_SECRET: C, ENCRYPTION_KEY: B });

    db.close();
    for (const f of ['rot.db', 'rot.db-wal', 'rot.db-shm']) { try { fs.unlinkSync(path.join(ROOT, f)); } catch {} }
    console.log('PASS enc rotacion: se puede rotar SESSION_SECRET sin perder los datos cifrados');
    process.exit(0);
  })().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
}
