process.env.TURSO_DATABASE_URL = 'file:test.db';
const assert = require('assert');
const fs = require('fs'); const path = require('path');
for (const f of ['test.db','test.db-wal','test.db-shm']) { try { fs.unlinkSync(f); } catch {} }
const ROOT = path.join(__dirname, '..');
process.env.SESSION_SECRET = 'test-secret';
process.env.APP_PASSWORD = 'Demo!1234!';
const app = require(path.join(ROOT, 'server.js'));
const { createClient } = require('@libsql/client');

const login = (b,u,p) => fetch(b+'/login',{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:`username=${u}&password=${encodeURIComponent(p)}`});
const ckOf = r => { const s=r.headers.get('set-cookie'); return s?s.split(';')[0]:null; };
const getData = (b,ck) => fetch(b+'/api/data',{headers:{Cookie:ck}}).then(r=>r.json());
const post = (b,ck,body) => fetch(b+'/api/data',{method:'POST',headers:{'Content-Type':'application/json',Cookie:ck},body:JSON.stringify(body)}).then(async r=>({status:r.status,json:await r.json()}));

(async () => {
  const server = app.listen(0); await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:'+server.address().port;
  const raw = createClient({ url: 'file:test.db' });
  // Fila centinela: el payload nunca la incluye. Sobrevive si NO se reescriben las
  // clases (skip); desaparece si SI se reescriben (DELETE FROM clases WHERE insc=E1).
  const putSentinel = () => raw.execute("INSERT INTO clases (id, inscripcion_id, fecha, tema) VALUES ('SENT','E1','','centinela')");
  const sentinelVive = async () => (await raw.execute("SELECT 1 FROM clases WHERE id='SENT'")).rows.length === 1;
  const asistCount   = async () => Number((await raw.execute("SELECT COUNT(*) n FROM asistencias_generales WHERE alumno_id='S1'")).rows[0].n);

  const ck = ckOf(await login(base,'admin','Demo!1234!'));
  const init = await getData(base, ck);
  const course = { id:'C1', name:'Excel', topics:[], hasHomework:false, allowManual:true, notes:'' };
  const student = { id:'S1', name:'Ana', surname:'Lopez', estado:'activo',
    payment:{type:'mensual',amount:300000,packageHours:null}, payments:[],
    attendance:[{date:'2026-03-01',present:true,hours:2,observations:''}],
    enrollments:[{ enrollId:'E1', courseId:'C1', tutors:[], startDate:'2026-03-01', estimatedEnd:'', completed:false,
      classes:[
        {date:'2026-03-01',startTime:'08:00',endTime:'10:00',modality:'presencial',topic:'Intro',professor:'Ben',observations:''},
        {date:'2026-03-03',startTime:'08:00',endTime:'10:00',modality:'presencial',topic:'Formulas',professor:'Ben',observations:''},
      ] }] };
  const send = (ver) => post(base, ck, { students:[student], courses:[course], companies:[], clientVersion:ver, partial:true, deletions:{} });

  // Guardado inicial: fija clases_hash = entityHash(student.classes)
  let r = await send(init.version);
  assert.equal(r.status,200,'guardado inicial ok'); let ver = r.json.newVersion;
  await putSentinel();
  assert.ok(await sentinelVive(), 'centinela puesto');

  // ── Cambiar SOLO asistencia: clases NO se reescriben (centinela vive) ──
  student.attendance.push({date:'2026-03-05',present:false,hours:0,observations:'falto'});
  r = await send(ver);
  assert.equal(r.status,200,'guardado de asistencia ok');
  assert.ok(r.json.newVersion > ver, 'cambio real sube version'); ver = r.json.newVersion;
  assert.ok(await sentinelVive(), 'clases NO reescritas al tocar asistencia (centinela vive)');
  assert.equal(await asistCount(), 2, 'asistencia SI se reescribio (ahora 2)');

  // ── Cambiar una clase: SI se reescriben (centinela borrado) ──
  student.enrollments[0].classes[0].topic = 'Introduccion Excel';
  r = await send(ver);
  assert.equal(r.status,200,'guardado de clase ok');
  assert.ok(r.json.newVersion > ver, 'cambio de clase sube version'); ver = r.json.newVersion;
  assert.ok(!(await sentinelVive()), 'cambiar una clase SI reescribe las clases (centinela borrado)');

  // Integridad final via API
  const d = await getData(base, ck);
  const sf = d.students.find(x=>x.id==='S1');
  assert.equal(sf.enrollments[0].classes.length, 2, 'siguen 2 clases');
  assert.equal(sf.enrollments[0].classes.find(c=>c.date==='2026-03-01').topic, 'Introduccion Excel', 'el cambio de clase persiste');
  assert.equal(sf.attendance.length, 2, 'siguen 2 asistencias');

  server.close(); console.log('PASS writeopt: asistencia no reescribe clases; cambio de clase si; integridad'); process.exit(0);
})().catch(e => { console.error('FAIL:',e.message); process.exit(1); });
