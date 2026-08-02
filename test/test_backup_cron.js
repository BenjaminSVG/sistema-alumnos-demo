process.env.TURSO_DATABASE_URL = 'file:test.db';
const assert = require('assert');
const fs = require('fs'); const path = require('path');
for (const f of ['test.db','test.db-wal','test.db-shm']) { try { fs.unlinkSync(f); } catch {} }
process.env.SESSION_SECRET = 'test-secret';
process.env.APP_PASSWORD = 'Demo!1234!';
process.env.CRON_SECRET = 'cron-xyz';
// Sin RESEND_API_KEY: el backup se genera pero no envía correo (sent:false)
const app = require(path.join(__dirname, '..', 'server.js'));

const login = (b,u,p) => fetch(b+'/login',{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:`username=${u}&password=${encodeURIComponent(p)}`});
const ckOf = r => { const s=r.headers.get('set-cookie'); return s?s.split(';')[0]:null; };
const post = (b,ck,body) => fetch(b+'/api/data',{method:'POST',headers:{'Content-Type':'application/json',Cookie:ck},body:JSON.stringify(body)}).then(async r=>({status:r.status,json:await r.json()}));
const getData = (b,ck) => fetch(b+'/api/data',{headers:{Cookie:ck}}).then(r=>r.json());
const cron = (b,auth) => fetch(b+'/api/cron/backup', auth ? { headers:{ Authorization: auth } } : {});
const mk = (id,name) => ({ id, name, surname:'X', estado:'activo', payment:{type:'mensual',amount:100,packageHours:null}, payments:[{date:'2026-03-01',concept:'Marzo',amount:100,paid:true}], attendance:[], enrollments:[] });

(async () => {
  const server = app.listen(0); await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:'+server.address().port;
  const ck = ckOf(await login(base,'admin','Demo!1234!'));
  const init = await getData(base, ck);
  await post(base, ck, { students:[mk('A','Ana')], courses:init.courses, companies:[{id:'E1',name:'Emp',pagosEmpresa:[]}], clientVersion:init.version });

  // Sin auth → 401
  assert.equal((await cron(base, null)).status, 401, 'sin bearer = 401');
  // Bearer incorrecto → 401
  assert.equal((await cron(base, 'Bearer malo')).status, 401, 'bearer malo = 401');

  // Bearer correcto → 200 + backup generado (sin correo, sent:false)
  const r = await cron(base, 'Bearer cron-xyz');
  assert.equal(r.status, 200, 'bearer ok = 200');
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.students, 1, 'cuenta alumnos');
  assert.equal(j.companies, 1, 'cuenta empresas');
  assert.equal(j.sent, false, 'sin RESEND_API_KEY no envía correo');

  server.close(); console.log('PASS backup cron: auth Bearer + genera backup admin-complete'); process.exit(0);
})().catch(e => { console.error('FAIL:',e.message); process.exit(1); });
