process.env.TURSO_DATABASE_URL = 'file:test.db';
const assert = require('assert');
const fs = require('fs'); const path = require('path');
for (const f of ['test.db','test.db-wal','test.db-shm']) { try { fs.unlinkSync(f); } catch {} }
const ROOT = path.join(__dirname, '..');
process.env.SESSION_SECRET = 'test-secret';
process.env.APP_PASSWORD = 'Demo!1234!';
const app = require(path.join(ROOT, 'server.js'));

const login = (b,u,p) => fetch(b+'/login',{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:`username=${u}&password=${encodeURIComponent(p)}`});
const ckOf = r => { const s=r.headers.get('set-cookie'); return s?s.split(';')[0]:null; };

(async () => {
  const server = app.listen(0); await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:'+server.address().port;
  const ck = ckOf(await login(base,'admin','Demo!1234!'));
  assert.ok(ck, 'login ok');

  // ── 1. El código fuente NO se sirve, ni siquiera autenticado ──
  for (const p of ['/server.js','/package.json','/seed.js','/schema.sql','/test/test_seguridad.js','/cert-pptx-data.js']) {
    const r = await fetch(base+p, { headers:{Cookie:ck}, redirect:'manual' });
    assert.notEqual(r.status, 200, `${p} NO debe servirse (fue ${r.status})`);
  }
  // Lo que la app sí necesita sigue funcionando
  for (const p of ['/', '/app.js', '/styles.css', '/data.js']) {
    const r = await fetch(base+p, { headers:{Cookie:ck}, redirect:'manual' });
    assert.equal(r.status, 200, `${p} debe seguir sirviéndose`);
  }

  // ── 2. Sesión: vencimiento y firma ligada al hash de contraseña ──
  const crypto = require('crypto');
  const mac = (id,exp,pw) => crypto.createHmac('sha256','test-secret').update(`${id}.${exp}.${pw}`).digest('hex');
  const row = await require('@libsql/client').createClient({url:'file:test.db'})
    .execute("SELECT password_hash FROM usuarios WHERE id='admin'");
  const pw = row.rows[0].password_hash;

  const ahora = Math.floor(Date.now()/1000);
  const vencido = `sga_auth=admin.${ahora-10}.${mac('admin',ahora-10,pw)}`;
  let r = await fetch(base+'/api/me', { headers:{Cookie:vencido}, redirect:'manual' });
  assert.equal(r.status, 401, 'una cookie vencida no autentica');

  // Una API NUNCA debe redirigir al login: fetch() seguiría la redirección,
  // recibiría el HTML con status 200 y la app quedaría a medias con datos viejos.
  const conRedir = await fetch(base+'/api/me', { headers:{Cookie:'sga_auth=basura'} });
  assert.equal(conRedir.status, 401, 'sesión inválida → 401, no el HTML del login');
  assert.ok(!conRedir.redirected, '/api/* no redirige');
  assert.ok((conRedir.headers.get('content-type')||'').includes('json'), 'responde JSON, no HTML');
  // Las páginas sí siguen redirigiendo
  const pag = await fetch(base+'/', { headers:{Cookie:'sga_auth=basura'}, redirect:'manual' });
  assert.equal(pag.status, 302, 'las páginas sí redirigen al login');

  const vigente = `sga_auth=admin.${ahora+3600}.${mac('admin',ahora+3600,pw)}`;
  r = await fetch(base+'/api/me', { headers:{Cookie:vigente}, redirect:'manual' });
  assert.equal(r.status, 200, 'una cookie vigente sí autentica');

  // Firmada con OTRO hash (simula contraseña cambiada) → ya no vale
  const otroPw = `sga_auth=admin.${ahora+3600}.${mac('admin',ahora+3600,'hash-viejo')}`;
  r = await fetch(base+'/api/me', { headers:{Cookie:otroPw}, redirect:'manual' });
  assert.equal(r.status, 401, 'cambiar la contraseña invalida las sesiones abiertas');

  // Token viejo (formato userId.HMAC sin exp) tampoco pasa
  const viejo = `sga_auth=admin.${crypto.createHmac('sha256','test-secret').update('admin').digest('hex')}`;
  r = await fetch(base+'/api/me', { headers:{Cookie:viejo}, redirect:'manual' });
  assert.equal(r.status, 401, 'el token del formato anterior queda invalidado');

  server.close(); console.log('PASS seguridad: sin exposicion de fuente + sesiones que vencen y se revocan'); process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
