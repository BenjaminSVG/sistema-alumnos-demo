process.env.TURSO_DATABASE_URL = 'file:test.db';
// Sistema multiusuario end-to-end:
//  1. seed admin, login por usuario/contraseña
//  2. admin crea un segundo usuario (profe)
//  3. permisos: profe (no-admin) no puede listar usuarios
//  4. DOS usuarios distintos cargan registros distintos A LA VEZ -> ambos se guardan
const assert = require('assert');
const fs = require('fs');
const path = require('path');
for (const f of ['test.db', 'test.db-wal', 'test.db-shm']) { try { fs.unlinkSync(f); } catch {} }

const ROOT = path.join(__dirname, '..');
process.env.SESSION_SECRET = 'test-secret';
process.env.APP_PASSWORD   = 'Demo!1234!';
const app = require(path.join(ROOT, 'server.js'));

function loginRaw(base, username, password) {
  return fetch(base + '/login', {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
  });
}
const cookieOf = res => { const sc = res.headers.get('set-cookie'); return sc ? sc.split(';')[0] : null; };
const getJSON = (base, ck, url) => fetch(base + url, { headers: { Cookie: ck } }).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }));
const post = (base, ck, url, body) => fetch(base + url, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ck }, body: JSON.stringify(body),
}).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }));

// Replica el merge del cliente (data.js) ante un 409: unir mi alumno nuevo al estado del servidor
function mergeStudents(mine, server) {
  const ids = new Set(server.map(s => s.id));
  return [...server, ...mine.filter(s => !ids.has(s.id))];
}

(async () => {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  // 1. login admin con la contraseña actual
  const badLogin = await loginRaw(base, 'admin', 'clave-incorrecta');
  assert.ok(!cookieOf(badLogin), 'login con clave mala NO da cookie');
  const adminLogin = await loginRaw(base, 'admin', 'Demo!1234!');
  const ckAdmin = cookieOf(adminLogin);
  assert.ok(ckAdmin, 'admin logueado -> cookie');

  const me = await getJSON(base, ckAdmin, '/api/me');
  assert.equal(me.json.role, 'admin', 'admin tiene rol admin');

  // 2. admin crea segundo usuario
  const create = await post(base, ckAdmin, '/api/users', { username: 'profe', password: 'profe123', nombre: 'Profe Uno', role: 'usuario' });
  assert.equal(create.status, 200, 'admin crea usuario');
  const dup = await post(base, ckAdmin, '/api/users', { username: 'profe', password: 'otra123', nombre: 'x', role: 'usuario' });
  assert.equal(dup.status, 409, 'username duplicado rechazado');

  const profeLogin = await loginRaw(base, 'profe', 'profe123');
  const ckProfe = cookieOf(profeLogin);
  assert.ok(ckProfe, 'profe logueado -> cookie');
  const meProfe = await getJSON(base, ckProfe, '/api/me');
  assert.equal(meProfe.json.role, 'usuario', 'profe es usuario normal');

  // 3. permisos: profe no puede administrar usuarios
  const forbidden = await getJSON(base, ckProfe, '/api/users');
  assert.equal(forbidden.status, 403, 'no-admin NO puede listar usuarios');

  // preparar datos base compartidos
  const init = await getJSON(base, ckAdmin, '/api/data');
  const courses = init.json.courses, companies = init.json.companies || [];
  const seed = await post(base, ckAdmin, '/api/data', {
    students: [{ id: 'S1', name: 'Base', surname: 'Uno' }], courses, companies, clientVersion: init.json.version,
  });
  assert.equal(seed.status, 200, 'seed base');
  const v = seed.json.newVersion; // ambos usuarios parten de esta version

  // 3b. el no-admin no puede dar de alta alumnos (se ignora, sin error)
  const altaProfe = await post(base, ckProfe, '/api/data', {
    students: [{ id: 'S1', name: 'Base', surname: 'Uno' }, { id: 'S-PROFE', name: 'AltaProfe', surname: 'Y' }],
    courses, companies, clientVersion: v,
  });
  assert.equal(altaProfe.status, 200, 'el POST del no-admin no falla');
  const trasProfe = await getJSON(base, ckAdmin, '/api/data');
  assert.ok(!trasProfe.json.students.some(s => s.id === 'S-PROFE'), 'alumno creado por no-admin NO persiste');

  // 4. DOS ADMINS DISTINTOS CARGAN REGISTROS DISTINTOS A LA VEZ
  await post(base, ckAdmin, '/api/users', { username: 'admin2', password: 'admin2123', nombre: 'Admin Dos', role: 'admin' });
  const ckAdmin2 = cookieOf(await loginRaw(base, 'admin2', 'admin2123'));
  const adminStudents = [{ id: 'S1', name: 'Base', surname: 'Uno' }, { id: 'S-ADMIN', name: 'AltaAdmin', surname: 'X' }];
  const profeStudents = [{ id: 'S1', name: 'Base', surname: 'Uno' }, { id: 'S-PROFE', name: 'AltaProfe', surname: 'Y' }];
  const [rA, rB] = await Promise.all([
    post(base, ckAdmin, '/api/data', { students: adminStudents, courses, companies, clientVersion: v }),
    post(base, ckAdmin2, '/api/data', { students: profeStudents, courses, companies, clientVersion: v }),
  ]);
  const statuses = [rA.status, rB.status].sort();
  console.log('guardado concurrente (2 usuarios):', statuses);
  assert.deepEqual(statuses, [200, 409], 'uno gana (200), el otro recibe 409 (no pisa datos)');

  // el que recibió 409 hace merge + reintento (como el cliente real)
  const loser = rA.status === 409 ? { ck: ckAdmin, mine: adminStudents } : { ck: ckAdmin2, mine: profeStudents };
  const cur = await getJSON(base, loser.ck, '/api/data');
  const merged = mergeStudents(loser.mine, cur.json.students);
  const retry = await post(base, loser.ck, '/api/data', { students: merged, courses, companies, clientVersion: cur.json.version });
  assert.equal(retry.status, 200, 'reintento tras merge se guarda');

  // comprobar: AMBOS registros quedaron guardados
  const final = await getJSON(base, ckAdmin, '/api/data');
  const ids = final.json.students.map(s => s.id).sort();
  console.log('alumnos finales en DB:', ids);
  assert.ok(ids.includes('S-ADMIN'), 'alumno cargado por admin persiste');
  assert.ok(ids.includes('S-PROFE'), 'alumno cargado por el segundo admin persiste');
  assert.ok(ids.includes('S1'), 'base intacta');

  // 5. guard: no se puede borrar el ultimo admin ni a uno mismo
  const delSelf = await fetch(base + '/api/users/admin', { method: 'DELETE', headers: { Cookie: ckAdmin } });
  assert.equal(delSelf.status, 400, 'no se puede borrar el ultimo admin / uno mismo');

  server.close();
  console.log('PASS: multiusuario + permisos + guardado concurrente sin perdida');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
