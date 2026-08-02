process.env.TURSO_DATABASE_URL = 'file:test.db';
// El usuario comun no puede crear, editar (temas/notas) ni eliminar cursos.
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

  // Admin crea un curso con temas y notas
  const init = await getData(base, ckA);
  const curso = { id: 'c-test', name: 'Curso Test', topics: ['T1', 'T2'], hasHomework: false, allowManual: false, notes: 'Material original' };
  let r = await post(base, ckA, { students: [], courses: [...init.courses, curso], companies: [], clientVersion: init.version });
  assert.equal(r.status, 200, 'admin crea curso');

  // Usuario comun
  await fetch(base + '/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ckA },
    body: JSON.stringify({ username: 'profe', password: 'profe123', nombre: 'Profe', role: 'usuario' }) });
  const ckP = cookieOf(await login(base, 'profe', 'profe123'));

  const dP = await getData(base, ckP);
  const before = dP.courses.find(c => c.id === 'c-test');
  assert.ok(before, 'el no-admin ve el curso');
  const cursosAntes = dP.courses.length;

  // 1. No puede EDITAR el curso (nombre, temas, notas, flags)
  const hackeado = { ...before, name: 'HACKEADO', topics: ['X'], notes: 'pisado', hasHomework: true, allowManual: true };
  r = await post(base, ckP, { students: dP.students, courses: dP.courses.map(c => c.id === 'c-test' ? hackeado : c), companies: dP.companies || [], clientVersion: dP.version });
  assert.ok(r.status === 200, 'el guardado del no-admin no falla');

  let check = (await getData(base, ckA)).courses.find(c => c.id === 'c-test');
  assert.equal(check.name, 'Curso Test', 'nombre del curso intacto');
  assert.deepEqual(check.topics, ['T1', 'T2'], 'temas intactos');
  assert.equal(check.notes, 'Material original', 'notas intactas');
  assert.equal(!!check.hasHomework, false, 'flag homework intacto');

  // 2. No puede ELIMINAR el curso (modo completo: omitirlo del array)
  const d2 = await getData(base, ckP);
  r = await post(base, ckP, { students: d2.students, courses: d2.courses.filter(c => c.id !== 'c-test'), companies: d2.companies || [], clientVersion: d2.version });
  assert.ok(r.status === 200, 'guardado sin el curso no falla');
  assert.ok((await getData(base, ckA)).courses.find(c => c.id === 'c-test'), 'el curso NO fue eliminado');

  // 3. No puede ELIMINAR el curso (modo parcial: deletions explicito)
  const d3 = await getData(base, ckP);
  r = await post(base, ckP, { students: [], courses: [], companies: [], deletions: { students: [], courses: ['c-test'], companies: [] }, partial: true, clientVersion: d3.version });
  assert.ok(r.status === 200, 'parcial no falla');
  assert.ok((await getData(base, ckA)).courses.find(c => c.id === 'c-test'), 'el curso NO fue eliminado (parcial)');

  // 4. No puede CREAR un curso nuevo
  const d4 = await getData(base, ckP);
  r = await post(base, ckP, { students: [], courses: [{ id: 'c-nuevo', name: 'Colado', topics: [], notes: '' }], companies: [], deletions: { students: [], courses: [], companies: [] }, partial: true, clientVersion: d4.version });
  assert.ok(r.status === 200, 'alta por no-admin no falla');
  const fin = (await getData(base, ckA)).courses;
  assert.ok(!fin.find(c => c.id === 'c-nuevo'), 'el curso nuevo NO se creo');
  assert.equal(fin.length, cursosAntes, 'cantidad de cursos sin cambios');

  // 5. El admin SI puede editar y eliminar
  const dA = await getData(base, ckA);
  r = await post(base, ckA, { students: dA.students, courses: dA.courses.map(c => c.id === 'c-test' ? { ...c, name: 'Renombrado', topics: ['T1', 'T2', 'T3'] } : c), companies: dA.companies || [], clientVersion: dA.version });
  assert.equal(r.status, 200);
  check = (await getData(base, ckA)).courses.find(c => c.id === 'c-test');
  assert.equal(check.name, 'Renombrado', 'admin renombra');
  assert.deepEqual(check.topics, ['T1', 'T2', 'T3'], 'admin agrega tema');

  const dA2 = await getData(base, ckA);
  r = await post(base, ckA, { students: dA2.students, courses: dA2.courses.filter(c => c.id !== 'c-test'), companies: dA2.companies || [], clientVersion: dA2.version });
  assert.equal(r.status, 200);
  assert.ok(!(await getData(base, ckA)).courses.find(c => c.id === 'c-test'), 'admin elimina el curso');

  server.close();
  console.log('PASS cursos: usuario comun no crea/edita/elimina; admin si');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
