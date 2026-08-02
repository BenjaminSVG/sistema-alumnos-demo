process.env.TURSO_DATABASE_URL = 'file:test.db';
// Los no-admin no ven pagos y su guardado NO los borra.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
for (const f of ['test.db', 'test.db-wal', 'test.db-shm']) { try { fs.unlinkSync(f); } catch {} }
const ROOT = path.join(__dirname, '..');
process.env.SESSION_SECRET = 'test-secret';
process.env.APP_PASSWORD   = 'Demo!1234!';
const app = require(path.join(ROOT, 'server.js'));

const login = (base, u, p) => fetch(base + '/login', { method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `username=${u}&password=${encodeURIComponent(p)}` });
const cookieOf = res => { const sc = res.headers.get('set-cookie'); return sc ? sc.split(';')[0] : null; };
const getData = (base, ck) => fetch(base + '/api/data', { headers: { Cookie: ck } }).then(r => r.json());
const post = (base, ck, body) => fetch(base + '/api/data', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ck }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }));

(async () => {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const ckA = cookieOf(await login(base, 'admin', 'Demo!1234!'));

  const init = await getData(base, ckA);
  const student = {
    id: 'S1', name: 'Ana', surname: 'Lopez', estado: 'activo',
    payment: { type: 'mensual', amount: 300000, packageHours: null },
    payments: [{ date: '2026-03-01', concept: 'Marzo', amount: 300000, paid: true }],
    attendance: [], enrollments: [],
  };
  let r = await post(base, ckA, { students: [student], courses: init.courses, companies: init.companies || [], clientVersion: init.version });
  assert.equal(r.status, 200, 'admin guarda alumno con pago');

  // crear usuario normal
  await fetch(base + '/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ckA },
    body: JSON.stringify({ username: 'profe', password: 'profe123', nombre: 'Profe', role: 'usuario' }) });
  const ckP = cookieOf(await login(base, 'profe', 'profe123'));

  // 1. el no-admin NO ve pagos
  const dP = await getData(base, ckP);
  const sP = dP.students.find(x => x.id === 'S1');
  assert.deepEqual(sP.payments, [], 'no-admin no recibe payments');
  assert.equal(sP.payment.amount, 0, 'no-admin no ve el monto');

  // 2. el no-admin intenta renombrar al alumno y agregar asistencia; guarda con payments vacio
  sP.name = 'Ana Maria';
  sP.attendance = [{ date: '2026-03-05', present: true, hours: 2 }];
  const dpVer = dP.version;
  r = await post(base, ckP, { students: dP.students, courses: dP.courses, companies: dP.companies || [], clientVersion: dpVer });
  assert.equal(r.status, 200, 'no-admin guarda');

  // 3. la ficha no cambio, la asistencia si, y los pagos siguen intactos
  const dA = await getData(base, ckA);
  const sA = dA.students.find(x => x.id === 'S1');
  assert.equal(sA.name, 'Ana', 'el no-admin NO puede renombrar al alumno');
  assert.equal(sA.attendance.length, 1, 'el no-admin SI puede registrar asistencia');
  assert.equal(sA.payments.length, 1, 'los pagos NO se borraron con el guardado del no-admin');
  assert.equal(sA.payments[0].amount, 300000, 'monto del pago intacto');
  assert.equal(sA.payment.amount, 300000, 'config de pago intacta');

  // 4. el no-admin no puede crear ni eliminar alumnos/empresas
  r = await post(base, ckP, {
    students: [{ id: 'S2', name: 'Nuevo', surname: 'X', attendance: [], enrollments: [] }],
    courses: [], companies: [{ id: 'E1', name: 'ACME' }],
    deletions: { students: ['S1'], courses: [], companies: [] }, partial: true, clientVersion: dA.version,
  });
  assert.equal(r.status, 200, 'el POST no falla, solo ignora lo prohibido');
  const dA2 = await getData(base, ckA);
  assert.ok(dA2.students.find(x => x.id === 'S1'), 'S1 no fue eliminado por el no-admin');
  assert.ok(!dA2.students.find(x => x.id === 'S2'), 'S2 no fue creado por el no-admin');
  assert.ok(!(dA2.companies || []).find(x => x.id === 'E1'), 'la empresa no fue creada por el no-admin');

  server.close();
  console.log('PASS: pagos ocultos y ficha de alumno/empresa solo editable por admin');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
