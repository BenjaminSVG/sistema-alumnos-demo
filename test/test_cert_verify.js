process.env.TURSO_DATABASE_URL = 'file:test.db';
const assert = require('assert');
const fs = require('fs'); const path = require('path');
for (const f of ['test.db','test.db-wal','test.db-shm']) { try { fs.unlinkSync(f); } catch {} }
process.env.SESSION_SECRET = 'test-secret';
process.env.APP_PASSWORD = 'Demo!1234!';
const app = require(path.join(__dirname, '..', 'server.js'));

const login = (b,u,p) => fetch(b+'/login',{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:`username=${u}&password=${encodeURIComponent(p)}`});
const ckOf = r => { const s=r.headers.get('set-cookie'); return s?s.split(';')[0]:null; };
const b64url = obj => Buffer.from(JSON.stringify(obj),'utf8').toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');

(async () => {
  const server = app.listen(0); await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:'+server.address().port;

  // Firmar requiere auth (sin cookie → redirige a /login, nunca firma)
  const d = b64url({ n:'Lucia Aguero', k:'ingles', c:'Full Conversation', l:'High Intermediate', h:150, f:'2026-05-06' });
  const noAuth = await fetch(base+`/api/cert-firma?d=${encodeURIComponent(d)}`, { redirect:'manual' });
  assert.equal(noAuth.status, 401, 'firmar sin login da 401 (las APIs no redirigen)');

  const ck = ckOf(await login(base,'admin','Demo!1234!'));
  const fr = await fetch(base+`/api/cert-firma?d=${encodeURIComponent(d)}`, { headers:{Cookie:ck} });
  assert.equal(fr.status, 200, 'firmar con login ok');
  const sig = (await fr.json()).s;
  assert.ok(sig && sig.length === 32, 'firma de 32 hex');

  // Verificar es publico y valida la firma
  let html = await (await fetch(base+`/verificar?d=${encodeURIComponent(d)}&s=${sig}`)).text();
  assert.ok(html.includes('Certificado válido'), 'firma correcta = válido');
  assert.ok(html.includes('Lucia Aguero') && html.includes('High Intermediate') && html.includes('Inglés'), 'muestra datos');

  // Firma alterada = no válido
  html = await (await fetch(base+`/verificar?d=${encodeURIComponent(d)}&s=${'0'.repeat(32)}`)).text();
  assert.ok(html.includes('Certificado no válido'), 'firma mala = no válido');

  // Payload alterado (misma firma) = no válido
  const d2 = b64url({ n:'Otro Nombre', k:'ingles', c:'x', l:'', h:'', f:'2026-05-06' });
  html = await (await fetch(base+`/verificar?d=${encodeURIComponent(d2)}&s=${sig}`)).text();
  assert.ok(html.includes('Certificado no válido'), 'payload cambiado invalida la firma');

  server.close(); console.log('PASS cert verify: firma autenticada + verificacion publica HMAC'); process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
