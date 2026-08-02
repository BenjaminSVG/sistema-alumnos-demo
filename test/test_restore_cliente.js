// Prueba la funcion restoreBackup() REAL de data.js -no una copia- cargando el
// archivo del cliente en un contexto con los globals del navegador simulados y
// apuntando su fetch al servidor de verdad. Si el boton de restaurar se rompe,
// este test se entera.
process.env.TURSO_DATABASE_URL = 'file:test.db';
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
process.env.SESSION_SECRET = 'test-secret';
process.env.APP_PASSWORD = 'Demo!1234!';
const ROOT = path.join(__dirname, '..');
const app = require(path.join(ROOT, 'server.js'));

const mk = i => ({
  id: 'CLI-' + i, name: 'Alumno' + i, surname: 'Ap' + i,
  phone: '0981-' + i, email: 'a' + i + '@ejemplo.com', modality: 'presencial',
  diasClase: [], horario: '', empresaId: '', estado: 'activo',
  contact2Name: '', contact2Relation: '', contact2Phone: '',
  caracteristicas: 'nota ' + i, alertasDismissed: {},
  payment: { type: 'mensual', amount: 1000 + i, packageHours: null },
  payments: [{ date: '2026-06-01', concept: 'Junio', amount: 1000 + i, paid: true }],
  attendance: [{ date: '2026-06-03', present: true, hours: 2, observations: 'obs ' + i }],
  enrollments: [],
});
const mios = arr => arr.filter(s => String(s.id).startsWith('CLI-')).sort((a, b) => a.id.localeCompare(b.id));

(async () => {
  const server = app.listen(0); await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const ck = await fetch(base + '/login', { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=admin&password=' + encodeURIComponent('Demo!1234!'),
  }).then(r => (r.headers.get('set-cookie') || '').split(';')[0]);
  assert.ok(ck, 'login OK');

  // ── Navegador simulado, con el fetch apuntando al servidor real ──
  const almacen = {};
  const ctx = {
    console,
    fetch: (url, opts = {}) => fetch(base + url, { ...opts, headers: { ...(opts.headers || {}), Cookie: ck } }),
    localStorage: {
      getItem: k => (k in almacen ? almacen[k] : null),
      setItem: (k, v) => { almacen[k] = String(v); },
      removeItem: k => { delete almacen[k]; },
    },
    document: { dispatchEvent: () => {} },
    CustomEvent: class { constructor(n, o) { this.type = n; this.detail = o && o.detail; } },
  };
  vm.createContext(ctx);
  // data.js declara su estado con `let`, que en un contexto de vm queda en un
  // ambito lexico invisible desde afuera: `ctx.STUDENTS` seria una propiedad
  // nuestra, no la del archivo. Este epilogo corre en ESE mismo ambito, asi que
  // captura los bindings de verdad. Sin esto el test se probaria a si mismo.
  const EPILOGO = `;globalThis.__api = {
    get STUDENTS(){ return STUDENTS }, set STUDENTS(v){ STUDENTS = v },
    get COURSES(){ return COURSES },   set COURSES(v){ COURSES = v },
    get COMPANIES(){ return COMPANIES }, set COMPANIES(v){ COMPANIES = v },
    get version(){ return _dataVersion },
    loadData, saveData, restoreBackup, validarBackup,
  };`;
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'data.js'), 'utf8') + EPILOGO, ctx, { filename: 'data.js' });
  const cli = ctx.__api;
  assert.equal(typeof cli.restoreBackup, 'function', 'data.js expone restoreBackup');
  assert.equal(typeof cli.validarBackup, 'function', 'data.js expone validarBackup');

  // ── Archivos invalidos: rechazados con mensaje, sin tocar nada ──
  assert.ok(cli.validarBackup(null), 'null se rechaza');
  assert.ok(cli.validarBackup({}), 'objeto vacio se rechaza');
  assert.ok(cli.validarBackup({ students: [] }), 'sin courses se rechaza');
  assert.ok(cli.validarBackup({ students: [{ name: 'x' }], courses: [] }), 'alumno sin id se rechaza');
  assert.equal(cli.validarBackup({ students: [], courses: [] }), null, 'backup vacio pero valido se acepta');

  await assert.rejects(() => cli.restoreBackup({ students: 'no soy un array' }),
    /no parece un backup|no es un JSON/i, 'restoreBackup rechaza basura antes de escribir');

  // ── Cargar 30 alumnos y hacer el backup ──────────────────
  await cli.loadData();
  cli.STUDENTS = Array.from({ length: 30 }, (_, i) => mk(i));
  await new Promise(r => { cli.saveData(); setTimeout(r, 400); });
  await cli.loadData();
  assert.equal(mios(cli.STUDENTS).length, 30, 'quedaron los 30 cargados');
  const backup = { exportedAt: new Date().toISOString(),
                   students: JSON.parse(JSON.stringify(mios(cli.STUDENTS))), courses: [], companies: [] };

  // ── Desastre: borrar 12 y meter un intruso ───────────────
  cli.STUDENTS = cli.STUDENTS.filter(s => !['CLI-0','CLI-1','CLI-2','CLI-3','CLI-4','CLI-5','CLI-6','CLI-7','CLI-8','CLI-9','CLI-10','CLI-11'].includes(s.id));
  cli.STUDENTS.push(mk(999));
  await new Promise(r => { cli.saveData(); setTimeout(r, 400); });
  await cli.loadData();
  assert.equal(mios(cli.STUDENTS).length, 19, '18 sobrevivientes + 1 intruso');

  // ── Restaurar con la funcion real, mirando el progreso ───
  const progreso = [];
  await cli.restoreBackup(backup, (hecho, total) => progreso.push(`${hecho}/${total}`));
  assert.deepStrictEqual(progreso, ['1/2', '2/2'], 'reporto las 2 tandas en orden');

  // ── Estado final identico al backup ──────────────────────
  const final = mios(cli.STUDENTS);
  assert.equal(final.length, 30, 'volvieron los 30');
  assert.ok(!final.some(s => s.id === 'CLI-999'), 'el intruso fue eliminado');
  assert.deepStrictEqual(final, backup.students, 'el estado en memoria es identico al backup');

  // ── Y el servidor coincide con lo que quedo en memoria ───
  const enServidor = mios((await ctx.fetch('/api/data').then(r => r.json())).students);
  assert.deepStrictEqual(enServidor, backup.students, 'el servidor tambien quedo identico');

  // ── La cache local se actualizo (si no, el proximo boot pinta lo viejo) ──
  const cache = mios(JSON.parse(almacen['keynes_students'] || '[]'));
  assert.equal(cache.length, 30, 'localStorage quedo al dia tras restaurar');

  server.close();
  console.log('PASS restore cliente: restoreBackup() real restaura, borra sobrantes y deja cache y servidor iguales');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
