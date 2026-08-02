process.env.TURSO_DATABASE_URL = 'file:test.db';
// 2FA TOTP end-to-end: setup -> enable con codigo valido -> login exige codigo.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
for (const f of ['test.db', 'test.db-wal', 'test.db-shm']) { try { fs.unlinkSync(f); } catch {} }
const ROOT = path.join(__dirname, '..');
process.env.SESSION_SECRET = 'test-secret';
process.env.APP_PASSWORD   = 'Demo!1234!';
process.env.ENCRYPTION_KEY = 'clave-fija-2fa-000';
const app = require(path.join(ROOT, 'server.js'));

function base32Decode(str) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, val = 0; const out = [];
  for (const c of String(str).replace(/=+$/, '').toUpperCase()) { const i = A.indexOf(c); if (i < 0) continue; val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xff); bits -= 8; } }
  return Buffer.from(out);
}
function totp(secret, t = Math.floor(Date.now() / 1000)) {
  const counter = Math.floor(t / 30); const buf = Buffer.alloc(8); buf.writeBigInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  const bin = ((h[o] & 0x7f) << 24) | ((h[o + 1] & 0xff) << 16) | ((h[o + 2] & 0xff) << 8) | (h[o + 3] & 0xff);
  return String(bin % 1000000).padStart(6, '0');
}
const login = (base, u, p, code) => fetch(base + '/login', { method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: `username=${encodeURIComponent(u)}&password=${encodeURIComponent(p)}${code ? '&code=' + code : ''}` });
const cookieOf = res => { const sc = res.headers.get('set-cookie'); return sc ? sc.split(';')[0] : null; };
const jpost = (base, ck, url, body) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ck }, body: JSON.stringify(body || {}) }).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }));

(async () => {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const ck = cookieOf(await login(base, 'admin', 'Demo!1234!'));
  assert.ok(ck, 'login admin');

  // setup
  const setup = await jpost(base, ck, '/api/me/2fa/setup');
  assert.equal(setup.status, 200, 'setup 2fa'); assert.ok(setup.json.secret, 'devuelve secreto');

  // enable con codigo malo -> 400
  const bad = await jpost(base, ck, '/api/me/2fa/enable', { code: '000000' });
  assert.equal(bad.status, 400, 'codigo malo rechazado');

  // enable con codigo valido
  const good = await jpost(base, ck, '/api/me/2fa/enable', { code: totp(setup.json.secret) });
  assert.equal(good.status, 200, 'activa 2fa con codigo valido');

  const me = await fetch(base + '/api/me', { headers: { Cookie: ck } }).then(r => r.json());
  assert.equal(me.twofaEnabled, true, '/api/me refleja 2fa activo');

  // login SIN codigo -> redirige a error=3, sin cookie
  const noCode = await login(base, 'admin', 'Demo!1234!');
  assert.ok(!cookieOf(noCode), 'login sin codigo no da cookie');
  assert.ok((noCode.headers.get('location') || '').includes('error=3'), 'pide codigo (error=3)');

  // login con codigo malo -> error=4
  const wrong = await login(base, 'admin', 'Demo!1234!', '123123');
  assert.ok(!cookieOf(wrong), 'codigo malo no da cookie');
  assert.ok((wrong.headers.get('location') || '').includes('error=4'), 'codigo malo (error=4)');

  // login con codigo valido -> cookie
  const okLogin = await login(base, 'admin', 'Demo!1234!', totp(setup.json.secret));
  assert.ok(cookieOf(okLogin), 'login con codigo valido funciona');

  // disable con password mala -> 403; con correcta -> 200
  const disBad = await jpost(base, ck, '/api/me/2fa/disable', { currentPassword: 'mala' });
  assert.equal(disBad.status, 403, 'disable exige password correcta');
  const disOk = await jpost(base, ck, '/api/me/2fa/disable', { currentPassword: 'Demo!1234!' });
  assert.equal(disOk.status, 200, 'desactiva 2fa');
  // ya sin 2fa, login normal sin codigo
  assert.ok(cookieOf(await login(base, 'admin', 'Demo!1234!')), 'sin 2fa login normal');

  server.close();
  console.log('PASS: 2FA TOTP setup/enable/login/disable');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
