process.env.TURSO_DATABASE_URL = 'file:test.db';
const assert = require('assert');
const fs = require('fs'); const path = require('path');
for (const f of ['test.db','test.db-wal','test.db-shm']) { try { fs.unlinkSync(f); } catch {} }
process.env.SESSION_SECRET = 'test-secret';
process.env.APP_PASSWORD = 'Demo!1234!';
const app = require(path.join(__dirname, '..', 'server.js'));

const login = (b,u,p) => fetch(b+'/login',{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:`username=${u}&password=${encodeURIComponent(p)}`});
const ckOf = r => { const s=r.headers.get('set-cookie'); return s?s.split(';')[0]:null; };
const getData = (b,ck) => fetch(b+'/api/data',{headers:{Cookie:ck}}).then(r=>r.json());
const post = (b,ck,body) => fetch(b+'/api/data',{method:'POST',headers:{'Content-Type':'application/json',Cookie:ck},body:JSON.stringify(body)}).then(async r=>({status:r.status,json:await r.json()}));
const mk = (id,name) => ({ id, name, surname:'X', estado:'activo', payment:{type:'mensual',amount:100,packageHours:null}, payments:[], attendance:[], enrollments:[] });

(async () => {
  const server = app.listen(0); await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:'+server.address().port;
  const ck = ckOf(await login(base,'admin','Demo!1234!'));
  const init = await getData(base, ck);

  // Baseline (full): A, B + una empresa
  const emp = { id:'E1', name:'Empresa Uno', pagosEmpresa:[] };
  let r = await post(base, ck, { students:[mk('A','Ana'),mk('B','Beto')], courses:init.courses, companies:[emp], clientVersion:init.version });
  assert.equal(r.status,200);
  let v = r.json.newVersion;

  // PARCIAL: editar A, borrar B. NO se mandan cursos ni empresa → deben quedar intactos.
  const Aedit = mk('A','Ana Maria');
  r = await post(base, ck, { students:[Aedit], courses:[], companies:[], deletions:{students:['B'],courses:[],companies:[]}, partial:true, clientVersion:v });
  assert.equal(r.status,200,'parcial ok'); assert.ok(r.json.newVersion > v);
  v = r.json.newVersion;

  let d = await getData(base, ck);
  const ids = d.students.map(s=>s.id).sort();
  assert.deepEqual(ids, ['A'], 'B borrado, A queda');
  assert.equal(d.students.find(s=>s.id==='A').name, 'Ana Maria', 'A editado');
  assert.ok(d.companies.find(c=>c.id==='E1'), 'empresa NO enviada sigue viva');
  assert.equal(d.courses.length, init.courses.length, 'cursos no enviados intactos');

  // PARCIAL: agregar C (no mandar A) → A no debe borrarse
  r = await post(base, ck, { students:[mk('C','Caro')], courses:[], companies:[], deletions:{students:[],courses:[],companies:[]}, partial:true, clientVersion:v });
  assert.equal(r.status,200); v = r.json.newVersion;
  d = await getData(base, ck);
  assert.deepEqual(d.students.map(s=>s.id).sort(), ['A','C'], 'A intacto, C agregado');

  // PARCIAL vacío (sin cambios) → unchanged, sin subir version
  r = await post(base, ck, { students:[], courses:[], companies:[], deletions:{students:[],courses:[],companies:[]}, partial:true, clientVersion:v });
  assert.equal(r.status,200); assert.equal(r.json.unchanged, true, 'parcial vacio = unchanged');
  assert.equal(r.json.newVersion, v, 'version no sube');

  server.close(); console.log('PASS partial: upsert/borrado selectivo, no toca lo no enviado'); process.exit(0);
})().catch(e => { console.error('FAIL:',e.message); process.exit(1); });
