// Un backup que nunca se restauro no es un backup: es un archivo adjunto.
// Este test agarra el JSON EXACTO que sale por correo, borra toda la base y lo
// carga de vuelta, verificando que no se pierda nada en el viaje.
process.env.TURSO_DATABASE_URL = 'file:test.db';
const assert = require('assert');
const path = require('path');
process.env.SESSION_SECRET = 'test-secret';
process.env.APP_PASSWORD = 'Demo!1234!';
process.env.CRON_SECRET = 'cron-xyz';
process.env.RESEND_API_KEY = 'test-key';
const app = require(path.join(__dirname, '..', 'server.js'));
const { createClient } = require('@libsql/client');
const db = createClient({ url: 'file:test.db' });

// Captura el adjunto del correo de backup sin mandar nada afuera
const realFetch = global.fetch;
let adjuntos = [];
global.fetch = (url, opts) => {
  if (String(url).includes('api.resend.com')) {
    const b = JSON.parse(opts.body);
    if (b.attachments) adjuntos.push(...b.attachments);
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('') });
  }
  return realFetch(url, opts);
};

const login = (b, u, p) => fetch(b + '/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `username=${u}&password=${encodeURIComponent(p)}` });
const ckOf = r => { const s = r.headers.get('set-cookie'); return s ? s.split(';')[0] : null; };
const post = (b, ck, body) => fetch(b + '/api/data', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ck }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, json: await r.json() }));
const getData = (b, ck) => fetch(b + '/api/data', { headers: { Cookie: ck } }).then(r => r.json());
const cron = b => fetch(b + '/api/cron/backup', { headers: { Authorization: 'Bearer cron-xyz' } }).then(r => r.json());

// Un alumno con TODO lo que el sistema guarda: inscripcion, clases, tarea,
// asistencia y pagos. Si algo no sobrevive al viaje, se ve acá.
const alumnoCompleto = {
  id: 'RST-1', name: 'Zoraida', surname: 'Benitez',
  phone: '0981-123456', email: 'zoraida@ejemplo.com',
  modality: 'presencial', diasClase: ['lunes', 'miercoles'], horario: '18:00',
  empresaId: 'RST-EMP', estado: 'activo',
  contact2Name: 'Marta Benitez', contact2Relation: 'madre', contact2Phone: '0981-999888',
  caracteristicas: 'Necesita refuerzo en tablas dinamicas',
  payment: { type: 'mensual', amount: 350000, packageHours: null },
  payments: [
    { date: '2026-06-01', concept: 'Junio', amount: 350000, paid: true },
    { date: '2026-07-01', concept: 'Julio', amount: 350000, paid: false },
  ],
  attendance: [
    { date: '2026-06-03', present: true,  hours: 2, observations: 'Muy participativa' },
    { date: '2026-06-05', present: false, hours: 0, observations: 'Aviso por WhatsApp' },
  ],
  alertasDismissed: {},
  enrollments: [{
    enrollId: 'RST-1-E1', courseId: 'excel-avanzado',
    tutors: ['Prof. Lopez'], startDate: '2026-06-01', estimatedEnd: '2026-08-30', completed: false,
    classes: [
      { date: '2026-06-03', startTime: '18:00', endTime: '20:00', modality: 'presencial',
        topic: 'Tablas dinamicas', professor: 'Prof. Lopez', observations: 'Avanzo bien',
        homework: { task: 'Ejercicio 4', done: true } },
      { date: '2026-06-05', startTime: '18:00', endTime: '20:00', modality: 'virtual',
        topic: 'Macros', professor: 'Prof. Lopez', observations: '', homework: { task: '', done: false } },
    ],
  }],
};
const empresaCompleta = {
  id: 'RST-EMP', name: 'Acme SA', ruc: '80012345-6',
  phone: '021-555000', email: 'rrhh@acme.com', address: 'Av. Siempreviva 742',
  modality: 'presencial', diasClase: ['martes'], horario: '08:00',
  contactName: 'Ana Torres', contactRole: 'RRHH', contactPhone: '0981-777666',
  pagosEmpresa: [{ id: 'RST-EP-1', studentId: 'RST-1', date: '2026-06-01', concept: 'Junio Acme', amount: 700000, paid: true }],
};

const sinRuido = d => ({
  students:  (d.students  || []).filter(s => String(s.id).startsWith('RST')),
  companies: (d.companies || []).filter(c => String(c.id).startsWith('RST')),
});

(async () => {
  const server = app.listen(0); await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const ck = ckOf(await login(base, 'admin', 'Demo!1234!'));

  // ── 1. Cargar datos reales ───────────────────────────────
  let v = (await getData(base, ck)).version;
  const w = await post(base, ck, { students: [alumnoCompleto], courses: [], companies: [empresaCompleta], clientVersion: v, partial: true });
  assert.equal(w.status, 200, 'se cargaron los datos de prueba');
  const original = sinRuido(await getData(base, ck));
  assert.equal(original.students.length, 1);
  assert.equal(original.companies.length, 1);

  // ── 2. Tomar el JSON EXACTO que sale por correo ──────────
  adjuntos = [];
  await cron(base);
  const adj = adjuntos.find(a => /^sga-backup-\d{4}-\d{2}-\d{2}\.json$/.test(a.filename));
  assert.ok(adj, 'el correo de backup lleva su adjunto JSON');
  const backup = JSON.parse(Buffer.from(adj.content, 'base64').toString('utf8'));
  assert.ok(backup.exportedAt, 'el backup trae fecha de exportacion');
  assert.ok(Array.isArray(backup.students) && Array.isArray(backup.courses), 'trae students y courses');

  // El backup debe venir DESCIFRADO: si no, sin ENCRYPTION_KEY no sirve de nada
  const crudo = JSON.stringify(backup);
  assert.ok(crudo.includes('zoraida@ejemplo.com'), 'el backup guarda el email en claro');
  assert.ok(crudo.includes('Muy participativa'), 'guarda las observaciones de asistencia');
  assert.ok(crudo.includes('Tablas dinamicas'), 'guarda los temas de clase');
  assert.ok(!crudo.includes('enc:v1:'), 'nada quedo cifrado dentro del backup');

  // ── 3. Desastre: borrar todo ─────────────────────────────
  for (const t of ['clases', 'inscripciones', 'asistencias_generales', 'pagos_alumno', 'pagos_empresa', 'alumnos', 'empresas']) {
    await db.execute(`DELETE FROM ${t}`);
  }
  const vacio = sinRuido(await getData(base, ck));
  assert.equal(vacio.students.length, 0, 'la base quedo vacia');
  assert.equal(vacio.companies.length, 0, 'sin empresas');

  // ── 4. Restaurar desde el archivo del correo ─────────────
  // clientVersion 0 = restauracion, se salta el control de concurrencia.
  const r = await post(base, ck, {
    students: backup.students, courses: backup.courses, companies: backup.companies, clientVersion: 0,
  });
  assert.equal(r.status, 200, `la restauracion respondio ${r.status}`);

  // ── 5. Comparar contra el original, campo por campo ──────
  const post_ = sinRuido(await getData(base, ck));
  assert.equal(post_.students.length, 1, 'volvio el alumno');
  assert.equal(post_.companies.length, 1, 'volvio la empresa');

  const a0 = original.students[0], a1 = post_.students[0];
  for (const k of ['name', 'surname', 'phone', 'email', 'modality', 'horario', 'empresaId',
                   'estado', 'contact2Name', 'contact2Relation', 'contact2Phone', 'caracteristicas']) {
    assert.deepStrictEqual(a1[k], a0[k], `alumno.${k} sobrevivio`);
  }
  assert.deepStrictEqual(a1.payment,    a0.payment,    'config de pago');
  assert.deepStrictEqual(a1.payments,   a0.payments,   'pagos (montos y estado)');
  assert.deepStrictEqual(a1.attendance, a0.attendance, 'asistencias con observaciones');
  assert.deepStrictEqual(a1.enrollments, a0.enrollments, 'inscripciones, clases y tareas');

  const e0 = original.companies[0], e1 = post_.companies[0];
  for (const k of ['name', 'ruc', 'phone', 'email', 'address', 'contactName', 'contactRole', 'contactPhone']) {
    assert.deepStrictEqual(e1[k], e0[k], `empresa.${k} sobrevivio`);
  }
  assert.deepStrictEqual(e1.pagosEmpresa, e0.pagosEmpresa, 'pagos de empresa');

  // Comparacion total, por si algo se escapo de la lista de arriba
  assert.deepStrictEqual(post_, original, 'el estado restaurado es identico al original');

  for (const t of ['clases', 'inscripciones', 'asistencias_generales', 'pagos_alumno', 'pagos_empresa']) {
    await db.execute(`DELETE FROM ${t}`);
  }
  await db.execute("DELETE FROM alumnos WHERE id LIKE 'RST%'");
  await db.execute("DELETE FROM empresas WHERE id LIKE 'RST%'");
  delete process.env.RESEND_API_KEY;
  server.close();
  console.log('PASS backup restore: el JSON del correo restaura la base completa sin perder nada');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
