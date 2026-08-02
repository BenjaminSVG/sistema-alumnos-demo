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
const getData = (b,ck) => fetch(b+'/api/data',{headers:{Cookie:ck}}).then(r=>r.json());
const getVer = (b,ck) => fetch(b+'/api/version',{headers:{Cookie:ck}}).then(r=>r.json());
const post = (b,ck,body) => fetch(b+'/api/data',{method:'POST',headers:{'Content-Type':'application/json',Cookie:ck},body:JSON.stringify(body)}).then(async r=>({status:r.status,json:await r.json()}));
(async () => {
  const server = app.listen(0); await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:'+server.address().port;
  const ck = ckOf(await login(base,'admin','Demo!1234!'));
  const init = await getData(base, ck);
  const student = { id:'S1', name:'Ana', surname:'Lopez', estado:'activo', payment:{type:'mensual',amount:300000,packageHours:null}, payments:[{date:'2026-03-01',concept:'Marzo',amount:300000,paid:true}], attendance:[], enrollments:[] };

  // 1. Primer guardado: cambia -> sube versión
  let r = await post(base, ck, { students:[student], courses:init.courses, companies:init.companies||[], clientVersion:init.version });
  assert.equal(r.status,200); assert.ok(r.json.newVersion > init.version, 'primer guardado sube version');
  const v1 = r.json.newVersion;
  assert.equal((await getVer(base,ck)).version, v1, '/api/version refleja la version');

  // 2a. Reload + resave: normaliza el hash a la forma que devuelve GET
  const dn = await getData(base, ck);
  r = await post(base, ck, { students:dn.students, courses:dn.courses, companies:dn.companies||[], clientVersion:dn.version });
  assert.equal(r.status,200);
  const vNorm = r.json.newVersion;

  // 2b. Reload + resave IDENTICO -> unchanged, sin subir version (skip real por hash)
  const d = await getData(base, ck);
  r = await post(base, ck, { students:d.students, courses:d.courses, companies:d.companies||[], clientVersion:d.version });
  assert.equal(r.status,200); assert.equal(r.json.unchanged, true, 'guardado identico = unchanged');
  assert.equal(r.json.newVersion, vNorm, 'version NO sube si no hay cambios');

  // 3. Cambiar un alumno -> sube version otra vez
  const d2 = await getData(base, ck);
  d2.students[0].name = 'Ana Maria';
  r = await post(base, ck, { students:d2.students, courses:d2.courses, companies:d2.companies||[], clientVersion:d2.version });
  assert.equal(r.status,200); assert.ok(r.json.newVersion > v1, 'cambio real sube version');

  // 4. Datos intactos tras todo
  const d3 = await getData(base, ck);
  const s = d3.students.find(x=>x.id==='S1');
  assert.equal(s.name,'Ana Maria'); assert.equal(s.payments.length,1); assert.equal(s.payments[0].amount,300000);

  server.close(); console.log('PASS optimizacion: skip sin cambios + /api/version + integridad'); process.exit(0);
})().catch(e => { console.error('FAIL:',e.message); process.exit(1); });
