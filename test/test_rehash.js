process.env.TURSO_DATABASE_URL = 'file:test.db';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs'); const path = require('path');
const { createClient } = require('@libsql/client');
for (const f of ['test.db','test.db-wal','test.db-shm']) { try { fs.unlinkSync(f); } catch {} }
process.env.SESSION_SECRET = 'test-secret';
process.env.APP_PASSWORD = 'Demo!1234!';
const app = require(path.join(__dirname, '..', 'server.js'));

const login = (b,u,p) => fetch(b+'/login',{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:`username=${u}&password=${encodeURIComponent(p)}`});
const ckOf = r => { const s=r.headers.get('set-cookie'); return s?s.split(';')[0]:null; };

// Hash con el formato viejo (sin N embebido → verify usa N=16384)
function oldHash(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return `${salt}:${hash}`;
}

(async () => {
  const server = app.listen(0); await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:'+server.address().port;

  // Un login previo asegura que la DB ya está inicializada y el admin sembrado
  assert.ok(ckOf(await login(base,'admin','Demo!1234!')), 'login admin inicial ok');

  const db = createClient({ url: 'file:test.db' });

  // Inyectar un hash con formato viejo para el admin (misma contraseña)
  const injected = oldHash('Demo!1234!');
  await db.execute({ sql: "UPDATE usuarios SET password_hash = ? WHERE username = 'admin'", args: [injected] });
  assert.equal((await db.execute("SELECT password_hash h FROM usuarios WHERE username='admin'")).rows[0].h.split(':').length, 2, 'hash viejo = 2 partes');

  // Login con la contraseña correcta: debe funcionar Y re-hashear
  assert.ok(ckOf(await login(base,'admin','Demo!1234!')), 'login con hash viejo ok');

  const after = (await db.execute("SELECT password_hash h FROM usuarios WHERE username='admin'")).rows[0].h;
  assert.equal(after.split(':').length, 3, 'tras login: hash re-hasheado a formato versionado');
  assert.equal(after.split(':')[2], String(1 << 17), 'nuevo costo N=2^17');
  assert.notEqual(after, injected, 'el hash cambió');

  // Contraseña incorrecta sigue rechazada
  assert.ok(!ckOf(await login(base,'admin','incorrecta')), 'pw incorrecta rechazada');

  server.close(); console.log('PASS rehash: login upgradea hash viejo a N=2^17'); process.exit(0);
})().catch(e => { console.error('FAIL:',e.message); process.exit(1); });
