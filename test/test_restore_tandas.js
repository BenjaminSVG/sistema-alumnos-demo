// El boton "Restaurar desde backup" no manda el archivo entero: lo parte en
// tandas de 25 alumnos, porque un backup real ronda 1,2 MB y el servidor corta
// en 2 MB. Este test reproduce ese protocolo exacto contra el servidor:
// borrados y cursos en la primera tanda, encadenando clientVersion.
process.env.TURSO_DATABASE_URL = 'file:test.db';
const assert = require('assert');
const path = require('path');
process.env.SESSION_SECRET = 'test-secret';
process.env.APP_PASSWORD = 'Demo!1234!';
const app = require(path.join(__dirname, '..', 'server.js'));

const login = (b, u, p) => fetch(b + '/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `username=${u}&password=${encodeURIComponent(p)}` });
const ckOf = r => { const s = r.headers.get('set-cookie'); return s ? s.split(';')[0] : null; };
const post = (b, ck, body) => fetch(b + '/api/data', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ck }, body: JSON.stringify(body) });
const getData = (b, ck) => fetch(b + '/api/data', { headers: { Cookie: ck } }).then(r => r.json());

const mk = i => ({
  id: 'TND-' + i, name: 'Alumno' + i, surname: 'Apellido' + i,
  phone: '0981-' + i, email: 'a' + i + '@ejemplo.com', modality: 'presencial',
  diasClase: [], horario: '', empresaId: '', estado: 'activo',
  contact2Name: '', contact2Relation: '', contact2Phone: '',
  caracteristicas: 'nota ' + i, alertasDismissed: {},
  payment: { type: 'mensual', amount: 1000 + i, packageHours: null },
  payments: [{ date: '2026-06-01', concept: 'Junio', amount: 1000 + i, paid: true }],
  attendance: [{ date: '2026-06-03', present: true, hours: 2, observations: 'obs ' + i }],
  enrollments: [],
});
const mios = d => (d.students || []).filter(s => String(s.id).startsWith('TND-'))
                                     .sort((a, b) => a.id.localeCompare(b.id));

// Replica de restoreBackup() de data.js: tandas de 25, borrados y cursos en la
// primera, encadenando la version que devuelve el servidor.
const TANDA = 25;
async function restaurarEnTandas(base, ck, backup, actuales) {
  const idS = new Set(backup.students.map(x => x.id));
  const deletions = { students: actuales.filter(x => !idS.has(x.id)).map(x => x.id), courses: [], companies: [] };
  let v = (await getData(base, ck)).version || 0;

  const tandas = [];
  for (let i = 0; i < backup.students.length; i += TANDA) tandas.push(backup.students.slice(i, i + TANDA));
  if (!tandas.length) tandas.push([]);

  for (let i = 0; i < tandas.length; i++) {
    const primera = i === 0;
    const res = await post(base, ck, {
      students: tandas[i],
      courses:   primera ? backup.courses : [],
      companies: primera ? (backup.companies || []) : [],
      deletions: primera ? deletions : { students: [], courses: [], companies: [] },
      partial: true, clientVersion: v,
    });
    assert.equal(res.status, 200, `tanda ${i + 1}/${tandas.length} respondio ${res.status}`);
    const j = await res.json();
    if (j.newVersion) v = j.newVersion;
  }
  return tandas.length;
}

(async () => {
  const server = app.listen(0); await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const ck = ckOf(await login(base, 'admin', 'Demo!1234!'));

  // ── 30 alumnos: obliga a mas de una tanda ────────────────
  const treinta = Array.from({ length: 30 }, (_, i) => mk(i));
  let v = (await getData(base, ck)).version;
  assert.equal((await post(base, ck, { students: treinta, courses: [], companies: [], clientVersion: v, partial: true })).status, 200);

  const backup = { exportedAt: new Date().toISOString(), students: mios(await getData(base, ck)), courses: [], companies: [] };
  assert.equal(backup.students.length, 30, 'el backup tiene los 30');

  // ── Desastre + ademas un alumno que el backup NO conoce ──
  v = (await getData(base, ck)).version;
  await post(base, ck, { students: [mk(999)], courses: [], companies: [],
    deletions: { students: treinta.slice(0, 10).map(s => s.id) }, clientVersion: v, partial: true });
  let ahora = mios(await getData(base, ck));
  assert.equal(ahora.length, 21, 'quedaron 20 originales + 1 intruso');
  assert.ok(ahora.some(s => s.id === 'TND-999'), 'el intruso existe antes de restaurar');

  // ── Restaurar en tandas ──────────────────────────────────
  const nTandas = await restaurarEnTandas(base, ck, backup, ahora);
  assert.equal(nTandas, 2, '30 alumnos = 2 tandas de 25');

  // ── El estado tiene que quedar identico al backup ────────
  const final = mios(await getData(base, ck));
  assert.equal(final.length, 30, 'volvieron los 30');
  assert.ok(!final.some(s => s.id === 'TND-999'), 'el intruso fue eliminado');
  assert.deepStrictEqual(final, backup.students, 'el estado final es identico al backup');

  // ── Un backup sin alumnos igual aplica sus borrados ──────
  v = (await getData(base, ck)).version;
  const vacio = { exportedAt: new Date().toISOString(), students: [], courses: [], companies: [] };
  await restaurarEnTandas(base, ck, vacio, mios(await getData(base, ck)));
  assert.equal(mios(await getData(base, ck)).length, 0, 'backup vacio deja la lista vacia');

  server.close();
  console.log('PASS restore tandas: restaura por partes, aplica borrados y queda identico al backup');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
