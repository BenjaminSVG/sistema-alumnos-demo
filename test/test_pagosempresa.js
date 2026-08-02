process.env.TURSO_DATABASE_URL = 'file:test.db';
// Pagos de empresa: se persisten y round-trip via pagos_empresa.
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
  const company = { id: 'E1', name: 'Copetrol', pagosEmpresa: [
    { id: 'ep1', studentId: 'S1', date: '2026-04-01', concept: 'Abril alumno', amount: 500000, paid: true },
    { id: 'ep2', studentId: null, date: '2026-04-05', concept: 'General empresa', amount: 900000, paid: true },
  ] };
  const student = { id: 'S1', name: 'Beto', surname: 'Gomez', estado: 'activo', empresaId: 'E1',
    payment: { type: 'mensual', amount: 0, packageHours: null }, payments: [], attendance: [], enrollments: [] };

  let r = await post(base, ckA, { students: [student], courses: init.courses, companies: [company], clientVersion: init.version });
  assert.equal(r.status, 200, 'admin guarda empresa con pagos');

  // round-trip: los pagos de empresa persisten
  const dA = await getData(base, ckA);
  const c = dA.companies.find(x => x.id === 'E1');
  assert.equal(c.pagosEmpresa.length, 2, 'dos pagos de empresa persistidos');
  const pAlum = c.pagosEmpresa.find(p => p.studentId === 'S1');
  assert.ok(pAlum, 'pago ligado al alumno S1 existe');
  assert.equal(pAlum.amount, 500000, 'monto del pago del alumno intacto');
  assert.equal(pAlum.concept, 'Abril alumno', 'concepto descifrado ok');
  const pGen = c.pagosEmpresa.find(p => p.studentId === null);
  assert.equal(pGen.amount, 900000, 'pago general empresa intacto');

  // el alumno de empresa NO tiene pagos propios (planilla = solo pago empresa)
  const sA = dA.students.find(x => x.id === 'S1');
  assert.deepEqual(sA.payments, [], 'alumno de empresa sin pagos individuales');

  server.close();
  console.log('PASS: pagos de empresa persisten y alumno de empresa usa solo el pago de la empresa');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
