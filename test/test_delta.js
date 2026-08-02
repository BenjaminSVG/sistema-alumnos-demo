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
const getData = (b,ck,since) => fetch(b+'/api/data'+(since!=null?`?since=${since}`:''),{headers:{Cookie:ck}}).then(r=>r.json());
const post = (b,ck,body) => fetch(b+'/api/data',{method:'POST',headers:{'Content-Type':'application/json',Cookie:ck},body:JSON.stringify(body)}).then(async r=>({status:r.status,json:await r.json()}));
const mk = (id,name) => ({ id, name, surname:'X', estado:'activo', payment:{type:'mensual',amount:100,packageHours:null}, payments:[], attendance:[], enrollments:[] });

(async () => {
  const server = app.listen(0); await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:'+server.address().port;
  const ck = ckOf(await login(base,'admin','Demo!1234!'));
  const init = await getData(base, ck);

  // Estado base: dos alumnos
  let r = await post(base, ck, { students:[mk('A','Ana'),mk('B','Beto')], courses:init.courses, companies:[], clientVersion:init.version });
  assert.equal(r.status,200);
  const vBase = r.json.newVersion;

  // full-load con since=0 -> NO partial, trae todo
  const full = await getData(base, ck, 0);
  assert.ok(!full.partial, 'since=0 = full load');
  assert.equal(full.students.length, 2);

  // delta sin cambios: partial, arrays vacios, misma version
  const d0 = await getData(base, ck, vBase);
  assert.equal(d0.partial, true, 'since=version = delta');
  assert.equal(d0.students.length, 0, 'sin cambios: 0 students');
  assert.equal(d0.version, vBase);

  // Editar A, borrar B, agregar C
  r = await post(base, ck, { students:[mk('A','Ana Maria'),mk('C','Caro')], courses:init.courses, companies:[], clientVersion:vBase });
  assert.equal(r.status,200);
  const vNew = r.json.newVersion;
  assert.ok(vNew > vBase);

  // delta desde vBase: debe traer A (editado) y C (nuevo), y B en deleted
  const d = await getData(base, ck, vBase);
  assert.equal(d.partial, true);
  const ids = d.students.map(s=>s.id).sort();
  assert.deepEqual(ids, ['A','C'], 'delta trae solo A y C');
  assert.ok(d.students.find(s=>s.id==='A').name==='Ana Maria', 'A editado');
  assert.deepEqual(d.deleted.students, ['B'], 'B en deleted');
  assert.equal(d.version, vNew);

  // Aplicar delta manualmente (replica cliente) sobre el estado full previo
  const state = full.students.slice();
  const upsert = (arr,items)=>{ for(const it of items){ const i=arr.findIndex(x=>x.id===it.id); if(i>=0)arr[i]=it; else arr.push(it);} };
  upsert(state, d.students);
  const after = state.filter(x=>!d.deleted.students.includes(x.id));
  const finalIds = after.map(s=>s.id).sort();
  assert.deepEqual(finalIds, ['A','C'], 'estado tras delta = A,C (B borrado)');
  assert.equal(after.find(s=>s.id==='A').name, 'Ana Maria');

  server.close(); console.log('PASS delta: full/since, upsert cambios, tombstone borrado, version'); process.exit(0);
})().catch(e => { console.error('FAIL:',e.message); process.exit(1); });
