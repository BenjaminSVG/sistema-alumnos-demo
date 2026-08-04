process.env.TURSO_DATABASE_URL = 'file:test.db';
// Cada usuario edita su propia cuenta (nombre/usuario/contraseña) con verificación.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
for (const f of ['test.db', 'test.db-wal', 'test.db-shm']) { try { fs.unlinkSync(f); } catch {} }
const ROOT = path.join(__dirname, '..');
process.env.SESSION_SECRET = 'test-secret';
process.env.APP_PASSWORD   = 'Demo!1234!';
const app = require(path.join(ROOT, 'server.js'));

const login = (base, u, p) => fetch(base + '/login', { method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: `username=${encodeURIComponent(u)}&password=${encodeURIComponent(p)}` });
const cookieOf = res => { const sc = res.headers.get('set-cookie'); return sc ? sc.split(';')[0] : null; };
const patchMe = (base, ck, body) => fetch(base + '/api/me', { method: 'PATCH',
  headers: { 'Content-Type': 'application/json', Cookie: ck }, body: JSON.stringify(body) })
  .then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }));

(async () => {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const ck = cookieOf(await login(base, 'admin', 'Demo!1234!'));
  assert.ok(ck, 'admin logueado');

  // cambiar solo nombre (no requiere contraseña actual)
  const r1 = await patchMe(base, ck, { nombre: 'Jefe Administrativo', username: 'admin' });
  assert.equal(r1.status, 200, 'cambia nombre sin password');

  // cambiar contraseña con actual INCORRECTA -> 403
  const r2 = await patchMe(base, ck, { username: 'admin', password: 'nuevaclave1', currentPassword: 'mala' });
  assert.equal(r2.status, 403, 'rechaza sin la contraseña actual correcta');

  // cambiar contraseña con actual correcta -> 200
  const r3 = await patchMe(base, ck, { username: 'admin', password: 'nuevaclave1', currentPassword: 'Demo!1234!' });
  assert.equal(r3.status, 200, 'cambia contraseña con la actual correcta');

  // login con la contraseña vieja falla, con la nueva funciona
  assert.ok(!cookieOf(await login(base, 'admin', 'Demo!1234!')), 'clave vieja ya no sirve');
  const ck2 = cookieOf(await login(base, 'admin', 'nuevaclave1'));
  assert.ok(ck2, 'clave nueva funciona');

  // cambiar username y volver a entrar con el nuevo
  const r4 = await patchMe(base, ck2, { username: 'jefe', currentPassword: 'nuevaclave1' });
  assert.equal(r4.status, 200, 'cambia username');
  assert.ok(cookieOf(await login(base, 'jefe', 'nuevaclave1')), 'login con username nuevo');

  server.close();
  console.log('PASS: self-service de cuenta con verificación de contraseña');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
