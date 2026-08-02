process.env.TURSO_DATABASE_URL = 'file:test.db';
// Verifica: datos sensibles se guardan CIFRADOS en la DB y se leen en claro por la API.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
for (const f of ['test.db', 'test.db-wal', 'test.db-shm']) { try { fs.unlinkSync(f); } catch {} }

const ROOT = path.join(__dirname, '..');
process.env.SESSION_SECRET  = 'test-secret';
process.env.APP_PASSWORD    = 'Demo!1234!';
process.env.ENCRYPTION_KEY  = 'clave-de-cifrado-estable-de-prueba-1234567890';
const app = require(path.join(ROOT, 'server.js'));
const { createClient } = require(path.join(ROOT, 'node_modules/@libsql/client'));

const login = (base) => fetch(base + '/login', {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=admin&password=Demo!1234!',
}).then(r => r.headers.get('set-cookie').split(';')[0]);
const get  = (base, ck) => fetch(base + '/api/data', { headers: { Cookie: ck } }).then(r => r.json());
const post = (base, ck, body) => fetch(base + '/api/data', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ck }, body: JSON.stringify(body),
}).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }));

(async () => {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const ck = await login(base);
  const init = await get(base, ck);

  const student = {
    id: 'S1', name: 'Ana', surname: 'Lopez',
    phone: '+595 981 111222', email: 'ana@correo.com',
    contact2Name: 'Madre Ana', contact2Phone: '+595 999 000',
    caracteristicas: 'Aprende rapido, dato sensible',
    estado: 'activo',
    payment: { type: 'mensual', amount: 300000, packageHours: null },
    payments: [{ date: '2026-03-01', concept: 'Marzo confidencial', amount: 300000, paid: true }],
    attendance: [], enrollments: [],
  };
  const r = await post(base, ck, { students: [student], courses: init.courses, companies: init.companies || [], clientVersion: init.version });
  assert.equal(r.status, 200, 'guardado OK');

  // 1. La API devuelve los datos EN CLARO (descifrados)
  const after = await get(base, ck);
  const s = after.students.find(x => x.id === 'S1');
  assert.equal(s.phone, '+595 981 111222', 'telefono descifrado en la API');
  assert.equal(s.email, 'ana@correo.com', 'email descifrado');
  assert.equal(s.caracteristicas, 'Aprende rapido, dato sensible', 'caracteristicas descifradas');
  assert.equal(s.payments[0].concept, 'Marzo confidencial', 'concepto de pago descifrado');
  assert.equal(s.payments[0].amount, 300000, 'monto descifrado a numero');

  // 2. En la DB los valores estan CIFRADOS (no legibles)
  const db = createClient({ url: 'file:' + path.join(ROOT, 'test.db') });
  const raw = await db.execute("SELECT telefono, email, caracteristicas FROM alumnos WHERE id='S1'");
  const rawPay = await db.execute("SELECT concepto, monto FROM pagos_alumno WHERE alumno_id='S1'");
  db.close();
  const rawPhone = String(raw.rows[0].telefono);
  console.log('DB telefono (crudo):', rawPhone.slice(0, 24) + '...');
  assert.ok(rawPhone.startsWith('enc:v1:'), 'telefono guardado cifrado');
  assert.ok(!rawPhone.includes('595'), 'el telefono NO aparece en claro en la DB');
  assert.ok(!String(raw.rows[0].caracteristicas).includes('sensible'), 'caracteristicas NO en claro en DB');
  assert.ok(String(rawPay.rows[0].concepto).startsWith('enc:v1:'), 'concepto de pago cifrado en DB');
  assert.ok(!String(rawPay.rows[0].monto).includes('300000'), 'monto NO en claro en DB');

  // los nombres SI quedan en claro (para poder buscar)
  const db2 = createClient({ url: 'file:' + path.join(ROOT, 'test.db') });
  const nm = await db2.execute("SELECT nombre FROM alumnos WHERE id='S1'");
  db2.close();
  assert.equal(nm.rows[0].nombre, 'Ana', 'nombre en claro (buscable)');

  server.close();
  console.log('PASS: datos sensibles cifrados en reposo, en claro solo via API autenticada');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
