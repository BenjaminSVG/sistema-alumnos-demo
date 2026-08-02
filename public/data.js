// =============================================================
//  CAPA DE DATOS — Sistema Keynes
//
//  Fuente primaria: API REST → SQLite (server.js)
//  Fallback:        localStorage (cuando el servidor no está disponible)
//
//  Las variables STUDENTS y COURSES son el estado en memoria.
//  La forma de los objetos es la que espera app.js (sin cambios).
// =============================================================

let STUDENTS  = [];
let COURSES   = [];
let COMPANIES = [];

// Versión local del servidor — se actualiza en cada carga o guardado exitoso.
// Permite detectar si el tab tiene datos más viejos que el servidor.
let _dataVersion = 0;

// ── Snapshot para POST por-entidad (mandar solo lo que cambió) ──
// _snap guarda id → hash de contenido de cada entidad tal como está en el
// servidor. Al guardar, se diffea el estado actual contra _snap para enviar
// solo entidades cambiadas + IDs borrados, en vez de todo el estado.
let _snap = null;
let _forceFull = false;   // fuerza un guardado completo (tras merge por conflicto)

function _hash(o) {
  const s = JSON.stringify(o);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h;
}
function _rebuildSnap() {
  _snap = {
    students:  new Map(STUDENTS.map(x => [x.id, _hash(x)])),
    courses:   new Map(COURSES.map(x => [x.id, _hash(x)])),
    companies: new Map(COMPANIES.map(x => [x.id, _hash(x)])),
  };
}

// ── Carga datos desde la API (o localStorage como fallback) ──
async function loadData() {
  let cargadoDesdeApi = false;

  // ¿El servidor ya tuvo datos alguna vez? Si es así, el localStorage es obsoleto.
  const everSynced = !!localStorage.getItem('keynes_server_synced');

  try {
    const res = await fetch('/api/data');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // Si la API responde correctamente, usamos sus datos (incluso arrays vacíos)
    if (Array.isArray(data.students)) {
      STUDENTS     = data.students  || [];
      COURSES      = data.courses   || [];
      COMPANIES    = data.companies || [];
      _dataVersion = data.version   || 0;
      cargadoDesdeApi = true;
      // Marcar que el servidor es la fuente de verdad — nunca más usar localStorage como origen
      localStorage.setItem('keynes_server_synced', '1');
      _persistCache();   // refrescar cache para el pintado instantáneo del próximo boot
    }
  } catch {
    // Servidor no disponible — sin aviso al usuario
  }

  // Si la API devolvió vacío o falló, intentamos localStorage
  // SOLO si el servidor nunca tuvo datos (migración inicial, no para tabs viejos)
  if (!cargadoDesdeApi && !everSynced) {
    try {
      const s = localStorage.getItem('keynes_students');
      const c = localStorage.getItem('keynes_courses');
      if (s) STUDENTS = JSON.parse(s);
      if (c) COURSES  = JSON.parse(c);

      // Migración inicial: subir datos de localStorage al servidor
      if (STUDENTS.length || COURSES.length) {
        saveData();
      }
    } catch {}
  }

  _normalizeLoaded();
}

// ── Sincronización incremental: solo trae lo cambiado desde `since` ──
// Si el servidor responde un delta (partial), aplica upserts/borrados en memoria;
// si responde full (fuera de ventana o error), reemplaza todo el estado.
async function loadDelta(since) {
  try {
    const res = await fetch(`/api/data?since=${encodeURIComponent(since || 0)}`);
    if (!res.ok) return loadData();
    const data = await res.json();
    if (!Array.isArray(data.students)) return;

    if (data.partial) {
      _upsertById(STUDENTS,  data.students,  'id');
      _upsertById(COURSES,   data.courses,   'id');
      _upsertById(COMPANIES, data.companies, 'id');
      const del = data.deleted || {};
      if (del.students?.length)  STUDENTS  = STUDENTS.filter(x => !del.students.includes(x.id));
      if (del.courses?.length)   COURSES   = COURSES.filter(x => !del.courses.includes(x.id));
      if (del.companies?.length) COMPANIES = COMPANIES.filter(x => !del.companies.includes(x.id));
    } else {
      STUDENTS  = data.students  || [];
      COURSES   = data.courses   || [];
      COMPANIES = data.companies || [];
    }
    _dataVersion = data.version || 0;
    localStorage.setItem('keynes_server_synced', '1');
    _persistCache();
  } catch {
    return;
  }

  _normalizeLoaded();
}

// Pinta al instante desde localStorage (sin red). Devuelve true si había algo cacheado.
// Se usa en el boot para mostrar datos de inmediato mientras loadData refresca del servidor.
function loadFromCache() {
  try {
    const s  = localStorage.getItem('keynes_students');
    const c  = localStorage.getItem('keynes_courses');
    const co = localStorage.getItem('keynes_companies');
    if (s)  STUDENTS  = JSON.parse(s);
    if (c)  COURSES   = JSON.parse(c);
    if (co) COMPANIES = JSON.parse(co);
    _normalizeLoaded();
    return !!(STUDENTS.length || COURSES.length || COMPANIES.length);
  } catch { return false; }
}

// Reemplaza (por id) los elementos existentes con los nuevos, agregando los que falten.
function _upsertById(arr, items, idKey) {
  for (const it of (items || [])) {
    const i = arr.findIndex(x => x[idKey] === it[idKey]);
    if (i >= 0) arr[i] = it; else arr.push(it);
  }
}

// ── Migración de campos + normalización sobre el estado ya cargado ──
function _normalizeLoaded() {
  // Migración de campos: garantizar que existan en registros antiguos
  STUDENTS.forEach(st => {
    if (!st.diasClase)                   st.diasClase       = [];
    if (st.horario === undefined)        st.horario         = "";
    if (st.empresaId === undefined)      st.empresaId       = "";
    if (st.caracteristicas === undefined) st.caracteristicas = "";
    (st.enrollments || []).forEach(e => {
      if (!e.attendance)              e.attendance = [];
      if (e.completed === undefined)  e.completed  = false;
    });

    // Estado manual del alumno (activo/pausado/finalizado). Preservar el
    // "finalizado" que antes se derivaba de todas las inscripciones completadas.
    if (st.estado === undefined) {
      st.estado = ((st.enrollments || []).length && st.enrollments.every(e => e.completed)) ? "finalizado" : "activo";
    }

    // Unificación de pagos por curso → un único registro por alumno.
    if (!st.payment) {
      const src = (st.enrollments || []).find(e => e.payment);
      st.payment = src?.payment ? { ...src.payment } : { type: "mensual", amount: 0, packageHours: null };
    }
    if (!st.payments) {
      st.payments = [];
      (st.enrollments || []).forEach(e => (e.payments || []).forEach(p => st.payments.push(p)));
      st.payments.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    }
    // Limpiar datos de pago viejos a nivel inscripción para que no se re-guarden ni se dupliquen
    (st.enrollments || []).forEach(e => { delete e.payment; delete e.payments; });
  });

  // Migración única: mover asistencias de inscripciones → asistencia general del alumno
  let attendanceMigrated = false;
  STUDENTS.forEach(st => {
    if (!st.attendance) {
      st.attendance = [];
      (st.enrollments || []).forEach(enr => {
        (enr.attendance || []).forEach(a => {
          if (!st.attendance.some(g => g.date === a.date)) {
            st.attendance.push({ date: a.date, present: a.present, hours: a.hours });
          }
        });
        enr.attendance = [];
      });
      st.attendance.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
      attendanceMigrated = true;
    }
  });
  if (attendanceMigrated) saveData();

  // Snapshot base para el diff de guardados por-entidad (estado = el del servidor)
  _rebuildSnap();
}

// ── Merge helpers para resolución de conflictos multi-usuario ─
function _mergeById(clientArr, serverArr, idKey, mergeItem) {
  const serverMap = new Map((serverArr || []).map(x => [x[idKey], x]));
  const result = [];
  const seen = new Set();
  for (const c of (clientArr || [])) {
    const s = serverMap.get(c[idKey]);
    result.push(s ? mergeItem(c, s) : c);
    seen.add(c[idKey]);
  }
  for (const s of (serverArr || [])) {
    if (!seen.has(s[idKey])) result.push(s);
  }
  return result;
}

function _mergeByDate(clientArr, serverArr) {
  const seen = new Set((clientArr || []).map(x => x.date));
  const result = [...(clientArr || [])];
  for (const x of (serverArr || [])) {
    if (!seen.has(x.date)) result.push(x);
  }
  return result.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
}

function _mergeClasses(c, s) {
  const key = cl => `${cl.date}|${cl.startTime || ''}|${cl.professor || ''}`;
  const seen = new Set((c || []).map(key));
  const result = [...(c || [])];
  for (const cl of (s || [])) {
    if (!seen.has(key(cl))) result.push(cl);
  }
  return result.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
}

function _mergePayments(c, s) {
  const key = p => `${p.date}|${p.concept}|${p.amount}`;
  const seen = new Set((c || []).map(key));
  const result = [...(c || [])];
  for (const p of (s || [])) {
    if (!seen.has(key(p))) result.push(p);
  }
  return result;
}

function _mergeWithServer(serverData) {
  STUDENTS = _mergeById(STUDENTS, serverData.students || [], 'id', (c, s) => ({
    ...s, ...c,
    alertasDismissed: { ...(s.alertasDismissed || {}), ...(c.alertasDismissed || {}) },
    payments:    _mergePayments(c.payments, s.payments), // pagos unificados por alumno
    attendance:  _mergeByDate(c.attendance, s.attendance),
    enrollments: _mergeById(c.enrollments, s.enrollments, 'enrollId', (ce, se) => ({
      ...se, ...ce,
      classes:    _mergeClasses(ce.classes,    se.classes),
      attendance: _mergeByDate(ce.attendance,  se.attendance),
    })),
  }));
  COURSES   = _mergeById(COURSES,   serverData.courses   || [], 'id', (c, _s) => c);
  COMPANIES = _mergeById(COMPANIES, serverData.companies || [], 'id', (c, s) => ({
    ...s, ...c,
    pagosEmpresa: _mergePayments(c.pagosEmpresa, s.pagosEmpresa),
  }));
  _dataVersion = serverData.version || 0;
}

// Flag para evitar que syncData sobreescriba datos mientras se guarda
let _saving = false;
// Si se llama saveData() mientras ya hay un guardado en vuelo, se encola para
// ejecutarse al terminar — así dos clases registradas rápido no se pierden.
let _pendingSave = false;

function isSaving() { return _saving; }

// Notifica el estado de guardado a la UI: 'saving' | 'saved' | 'offline'.
function _emitSave(status) {
  try { document.dispatchEvent(new CustomEvent('keynes:save', { detail: status })); } catch {}
}

// ── Guarda datos en API + localStorage ───────────────────────
// Guarda el estado actual en localStorage (cache para el pintado instantáneo del próximo boot).
function _persistCache() {
  try {
    localStorage.setItem('keynes_students',  JSON.stringify(STUDENTS));
    localStorage.setItem('keynes_courses',   JSON.stringify(COURSES));
    localStorage.setItem('keynes_companies', JSON.stringify(COMPANIES));
  } catch {}
}

// Construye el cuerpo del POST: parcial (solo cambios + borrados) si hay
// snapshot base; completo si no lo hay o si se forzó (tras un merge por conflicto).
function _buildSavePayload() {
  if (!_snap || _forceFull) {
    return { students: STUDENTS, courses: COURSES, companies: COMPANIES, clientVersion: _dataVersion };
  }
  const dS = STUDENTS.filter(x => _snap.students.get(x.id)  !== _hash(x));
  const dC = COURSES.filter(x  => _snap.courses.get(x.id)   !== _hash(x));
  const dK = COMPANIES.filter(x => _snap.companies.get(x.id) !== _hash(x));
  const idsS = new Set(STUDENTS.map(x => x.id));
  const idsC = new Set(COURSES.map(x => x.id));
  const idsK = new Set(COMPANIES.map(x => x.id));
  const deletions = {
    students:  [..._snap.students.keys()].filter(id  => !idsS.has(id)),
    courses:   [..._snap.courses.keys()].filter(id   => !idsC.has(id)),
    companies: [..._snap.companies.keys()].filter(id => !idsK.has(id)),
  };
  return { students: dS, courses: dC, companies: dK, deletions, partial: true, clientVersion: _dataVersion };
}

function saveData() {
  // localStorage como respaldo offline (siempre inmediato)
  _persistCache();

  if (_saving) {
    // Ya hay un POST en vuelo: encolar para ejecutar cuando termine
    _pendingSave = true;
    return;
  }

  _doSave();
}

async function _doSave() {
  _saving = true;
  _pendingSave = false;
  _emitSave('saving');

  let offline = false, ok = false;
  try {
    const res = await fetch('/api/data', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(_buildSavePayload()),
    });

    if (res.status === 409) {
      // Otro usuario guardó primero — hacer merge y reintentar (con guardado completo)
      try {
        const serverRes = await fetch('/api/data');
        if (serverRes.ok) {
          _mergeWithServer(await serverRes.json());
          _forceFull = true;   // tras el merge, el próximo intento manda todo
          _pendingSave = true; // va a reintentar al final de _doSave
        }
      } catch { offline = true; }
    } else if (res.ok) {
      try {
        const json = await res.json();
        if (json.newVersion) _dataVersion = json.newVersion;
      } catch {}
      ok = true;
    } else {
      // Error del servidor (400/500): los datos quedaron en localStorage sin persistir
      offline = true;
    }
  } catch {
    // Error de red — los datos ya están en localStorage, se reintentará en el próximo save
    offline = true;
  }

  // Guardado exitoso: el servidor ya tiene nuestro estado → rebasar el snapshot
  if (ok) { _forceFull = false; _rebuildSnap(); }

  _saving = false;

  // Si mientras guardaba hubo otro cambio (o se hizo merge), guardar con el estado más reciente
  if (_pendingSave) {
    _doSave();
    return;   // el estado final lo emite la ejecución encolada
  }

  _emitSave(offline ? 'offline' : 'saved');
}

// ── Restaurar desde un backup JSON ───────────────────────────
// Reemplaza alumnos, cursos y empresas por los del archivo: lo que existe hoy
// y no está en el backup, se borra.
//
// Se manda en tandas y no de una: un backup de 128 alumnos con su historial
// ronda 1,2 MB y el servidor corta en 2 MB. Mandarlo entero funcionaría hoy y
// fallaría dentro de un año, justo el día que hace falta.
const RESTORE_TANDA = 25;

function validarBackup(b) {
  if (!b || typeof b !== 'object')   return 'El archivo no es un JSON válido.';
  if (!Array.isArray(b.students))    return 'Al archivo le falta la lista de alumnos: no parece un backup de Keynes.';
  if (!Array.isArray(b.courses))     return 'Al archivo le falta la lista de cursos: no parece un backup de Keynes.';
  if (b.students.some(s => !s || !s.id)) return 'El archivo tiene alumnos sin id. Está corrupto.';
  return null;
}

async function restoreBackup(backup, onProgreso) {
  const err = validarBackup(backup);
  if (err) throw new Error(err);

  const students  = backup.students;
  const courses   = backup.courses;
  const companies = Array.isArray(backup.companies) ? backup.companies : [];

  // Lo que hay ahora y no viene en el backup se elimina
  const idS = new Set(students.map(x => x.id));
  const idC = new Set(courses.map(x => x.id));
  const idK = new Set(companies.map(x => x.id));
  const deletions = {
    students:  STUDENTS.filter(x  => !idS.has(x.id)).map(x => x.id),
    courses:   COURSES.filter(x   => !idC.has(x.id)).map(x => x.id),
    companies: COMPANIES.filter(x => !idK.has(x.id)).map(x => x.id),
  };

  // Versión fresca del servidor: puede haber cambiado desde que se cargó la página
  let v = 0;
  try { v = (await (await fetch('/api/data')).json()).version || 0; } catch { v = _dataVersion; }

  const tandas = [];
  for (let i = 0; i < students.length; i += RESTORE_TANDA) tandas.push(students.slice(i, i + RESTORE_TANDA));
  if (!tandas.length) tandas.push([]);   // backup sin alumnos: igual hay que aplicar cursos y borrados

  for (let i = 0; i < tandas.length; i++) {
    // Cursos, empresas y borrados van en la primera tanda; el resto son solo alumnos
    const primera = i === 0;
    const res = await fetch('/api/data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        students:  tandas[i],
        courses:   primera ? courses   : [],
        companies: primera ? companies : [],
        deletions: primera ? deletions : { students: [], courses: [], companies: [] },
        partial: true,
        clientVersion: v,
      }),
    });
    if (!res.ok) {
      throw new Error(`El servidor rechazó la tanda ${i + 1} de ${tandas.length} (código ${res.status}). ` +
                      `Lo restaurado hasta ahí quedó guardado; podés reintentar con el mismo archivo.`);
    }
    const j = await res.json().catch(() => ({}));
    if (j.newVersion) v = j.newVersion;
    if (onProgreso) onProgreso(i + 1, tandas.length);
  }

  // Releer todo del servidor: deja memoria, snapshot y caché local coherentes
  _snap = null;
  _forceFull = false;
  await loadData();
  _rebuildSnap();
}
