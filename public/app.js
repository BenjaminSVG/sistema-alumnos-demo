// ====== Sesión caducada ======
// Si el servidor responde 401 en cualquier /api/, la sesión ya no vale: hay que
// ir al login. Sin esto la app seguía andando a medias con los datos del caché
// (sin nombre de usuario, sin menú de admin, sin "Mi cuenta") y sin avisar nada.
// Se envuelve fetch una sola vez para cubrir todas las llamadas, actuales y futuras.
(function () {
  const _fetch = window.fetch;
  let saliendo = false;
  window.fetch = async function (...args) {
    const res = await _fetch.apply(this, args);
    if (res.status === 401 && String(res.url || "").includes("/api/") && !saliendo) {
      saliendo = true;
      // El caché es de la sesión anterior: borrarlo evita mostrar datos de otro
      // usuario si en esta computadora entra alguien distinto.
      try {
        ["keynes_students", "keynes_courses", "keynes_companies", "keynes_server_synced"]
          .forEach(k => localStorage.removeItem(k));
      } catch {}
      location.href = "/login";
    }
    return res;
  };
})();

// ====== Escape de HTML ======
// TODA la interfaz se arma con template literals que terminan en innerHTML, así
// que cualquier dato de usuario sin escapar es XSS almacenado. Y los usuarios
// comunes pueden escribir observaciones, temas, profesor y tareas: sin esto, un
// profesor puede ejecutar código en la sesión del administrador que abra la ficha.
// Regla: todo valor que venga de la base pasa por esc() antes de entrar al HTML.
const _ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function esc(v) {
  return v == null ? "" : String(v).replace(/[&<>"']/g, c => _ESC[c]);
}
// Texto de varias líneas → HTML: primero escapar, después convertir los saltos.
function escBr(v) { return esc(v).replace(/\n/g, "<br>"); }

// ====== Estado ======
const state = {
  view: "dashboard",
  search: "",
  courseFilter: "",
  dayFilter: "",
  empresaFilter: "",
  currentStudentId: null,
  currentEnrollIdx: 0,
  currentCompanyId: null,
  empresaTab: "alumnos",
  dashRange: "12",   // 6 | 12 | all  (rango del gráfico de ingresos)
  pagosSearch: "",
  empresaSearch: "",
  searchType: "alumno",     // "alumno" | "empresa" (buscador global)
  pagosCourse: "",
  pagosEmpresa: "",
  pagosSort: "reciente",   // reciente | antiguo | az | za
  pagosTab: "alumnos",     // alumnos | empresas
  pagosEstado: "",         // "" | activo | pausado | finalizado
  pagosOpen: {},           // id → true (grupos desplegados, persistente entre renders)
  soporteTab: "tutorial",  // tutorial | contacto
};

const DIAS = ["Lunes","Martes","Miércoles","Jueves","Viernes","Sábado","Domingo"];

// ====== Usuarios / sesión ======
let CURRENT_USER = null;   // { id, username, nombre, role }
let USERS = [];            // lista de cuentas (solo se llena para admins)
function isAdmin() { return CURRENT_USER && CURRENT_USER.role === "admin"; }

// ====== DOM ======
const content = document.getElementById("content");
const toastEl = document.getElementById("toast");
const modalOverlay = document.getElementById("modalOverlay");
const modalBox = document.getElementById("modalBox");

// ====== Helpers ======
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  requestAnimationFrame(() => toastEl.classList.add("show"));
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    toastEl.classList.remove("show");
    setTimeout(() => (toastEl.hidden = true), 250);
  }, 2800);
}

function fmt(n) {
  return new Intl.NumberFormat("es-PY", {
    style: "currency", currency: "PYG", minimumFractionDigits: 0
  }).format(n);
}

function fmtDate(d) {
  if (!d) return "—";
  const [y, m, day] = d.split("-");
  return `${day}/${m}/${y}`;
}

function payTypeLabel(t) {
  return { mensual: "Mensual", "por clase": "Por clase", "curso completo": "Curso completo", paquete: "Paquete de horas" }[t] || t;
}

// Estado manual del alumno: activo | pausado | finalizado
const ESTADOS = ["activo", "pausado", "finalizado"];
function estadoLabel(e) { return { activo: "Activo", pausado: "Pausado", finalizado: "Finalizado" }[e] || "Activo"; }
function estadoClass(e) { return { activo: "status-active", pausado: "status-paused", finalizado: "status-done" }[e] || "status-active"; }
function estadoBadge(s) {
  const e = s.estado || "activo";
  return `<span class="status-badge ${estadoClass(e)}">${estadoLabel(e)}</span>`;
}

// ¿El alumno pertenece a una empresa (existente)?
function isEmpresaStudent(s) { return !!s.empresaId && !!getCompany(s.empresaId); }

// Fecha de la primera clase registrada en cualquiera de los cursos del alumno ('' si no hay)
function firstClassDate(s) {
  let min = "";
  (s.enrollments || []).forEach(e => (e.classes || []).forEach(cl => {
    if (cl.date && (!min || cl.date < min)) min = cl.date;
  }));
  return min;
}
// Pagos efectivos del alumno: si es de empresa, los que abonó la empresa por él; si no, los suyos.
function effectivePayments(s) {
  if (s.empresaId) {
    const c = getCompany(s.empresaId);
    return (c && c.pagosEmpresa ? c.pagosEmpresa : []).filter(p => p.studentId === s.id);
  }
  return s.payments || [];
}

// Sección de pagos unificada a nivel alumno (paga por todos sus cursos juntos)
function renderPaySection(s) {
  const empresa = isEmpresaStudent(s) ? getCompany(s.empresaId) : null;
  const payments = effectivePayments(s);
  const totalPaid = payments.filter(p => p.paid).reduce((a, p) => a + (p.amount || 0), 0);
  const totalPend = payments.filter(p => !p.paid).reduce((a, p) => a + (p.amount || 0), 0);

  // Los alumnos de empresa: los pagos los abona la empresa → solo lectura acá.
  if (empresa) {
    const rows = payments.map(p => `
      <tr>
        <td>${fmtDate(p.date)}</td>
        <td>${esc(p.concept || "—")}</td>
        <td>${fmt(p.amount)}</td>
        <td><span class="pay-badge ${p.paid ? "paid" : "unpaid"}">${p.paid ? "Pagado" : "Pendiente"}</span></td>
      </tr>`).join("");
    return `
    <div class="section-card">
      <div class="section-head">
        <h3>Registro de Pagos <span style="font-size:12px;color:var(--ink-3);font-weight:500">(abonado por la empresa)</span></h3>
        <button class="btn btn-ghost btn-sm" data-add-pago-empresa="${empresa.id}">+ Registrar pago de empresa</button>
      </div>
      <p style="font-size:12.5px;color:var(--ink-3);margin:-4px 0 12px">Este alumno forma parte de <b>${esc(empresa.name)}</b>. Los pagos los realiza la empresa y se gestionan desde la sección Empresas.</p>
      <div class="pay-summary">
        <div class="pay-stat"><div class="k">Empresa</div><div class="val">${esc(empresa.name)}</div></div>
        <div class="pay-stat green"><div class="k">Total pagado</div><div class="val">${fmt(totalPaid)}</div></div>
        <div class="pay-stat amber"><div class="k">Total pendiente</div><div class="val">${fmt(totalPend)}</div></div>
      </div>
      ${payments.length ? `
      <div class="class-table-wrap">
        <table class="class-table">
          <thead><tr><th>Fecha</th><th>Concepto</th><th>Monto</th><th>Estado</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>` : '<div class="empty-sm">La empresa todavía no registró pagos para este alumno.</div>'}
    </div>`;
  }

  // Alumno particular: pagos propios (editables)
  const pay = s.payment || { type: "mensual", amount: 0, packageHours: null };
  const payModalidad = pay.type === "paquete"
    ? `Paquete${pay.packageHours ? " (" + pay.packageHours + " hs/sem.)" : ""}`
    : payTypeLabel(pay.type);
  const payRows = payments.map((p, idx) => `
    <tr>
      <td>${fmtDate(p.date)}</td>
      <td>${esc(p.concept)}</td>
      <td>${fmt(p.amount)}</td>
      <td><span class="pay-badge ${p.paid ? "paid" : "unpaid"}">${p.paid ? "Pagado" : "Pendiente"}</span></td>
      <td style="display:flex;gap:4px;align-items:center">
        ${!p.paid ? `<button class="btn-outline" data-mark-paid="${s.id}" data-pay-idx="${idx}">Marcar pagado</button>` : ""}
        <button class="btn-icon" data-edit-pay="${s.id}" data-pay-idx="${idx}" title="Editar pago">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="btn-icon danger" data-del-pay="${s.id}" data-pay-idx="${idx}" title="Eliminar">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </td>
    </tr>`).join("");
  return `
  <div class="section-card">
    <div class="section-head">
      <h3>Registro de Pagos</h3>
      <button class="btn btn-ghost btn-sm" data-add-pay="${s.id}">+ Agregar Pago</button>
    </div>
    <div class="pay-summary">
      <div class="pay-stat">
        <div class="k">Modalidad</div>
        <div class="val enr-date-row">
          ${payModalidad}
          <button class="btn-icon" data-edit-pay-config="${s.id}" title="Editar configuración de pago" style="margin-left:6px;vertical-align:middle">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
        </div>
      </div>
      <div class="pay-stat"><div class="k">Monto base</div><div class="val">${fmt(pay.amount)}</div></div>
      <div class="pay-stat green"><div class="k">Total pagado</div><div class="val">${fmt(totalPaid)}</div></div>
      <div class="pay-stat amber"><div class="k">Total pendiente</div><div class="val">${fmt(totalPend)}</div></div>
    </div>
    ${payments.length ? `
    <div class="class-table-wrap">
      <table class="class-table">
        <thead><tr><th>Fecha</th><th>Concepto</th><th>Monto</th><th>Estado</th><th></th></tr></thead>
        <tbody>${payRows}</tbody>
      </table>
    </div>` : '<div class="empty-sm">No hay pagos registrados.</div>'}
  </div>`;
}

function getCourse(id)  { return COURSES.find(c => c.id === id); }
function getStudent(id) { return STUDENTS.find(s => s.id === id); }
function getCompany(id) { return COMPANIES.find(c => c.id === id); }

function isHomeworkTopic(t) { return typeof t === "string" && t.startsWith("HOMEWORK\n"); }
function renderTopicHtml(t) {
  if (isHomeworkTopic(t)) {
    const task = t.slice(9);
    return `<strong>HOMEWORK</strong>${task ? `<br><span class="hw-task">${esc(task)}</span>` : ""}`;
  }
  return esc(t);
}
function renderTopicText(t) {
  if (isHomeworkTopic(t)) {
    const task = t.slice(9);
    return task ? `HOMEWORK: ${task}` : "HOMEWORK";
  }
  return t;
}

function initials(name, surname) {
  return ((name[0] || "") + (surname[0] || "")).toUpperCase();
}

const PALETTE = ["#2563eb", "#7c3aed", "#059669", "#d97706", "#dc2626", "#0891b2", "#be185d"];
function colorFor(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

function openModal(html) {
  modalBox.innerHTML = html;
  modalOverlay.hidden = false;
  document.body.style.overflow = "hidden";
}

function closeModal() {
  modalOverlay.hidden = true;
  modalBox.innerHTML = "";
  document.body.style.overflow = "";
}

function buildInformeText(s, date) {
  const allClasses = [];
  s.enrollments.forEach(enr => {
    const course = getCourse(enr.courseId);
    enr.classes.filter(cl => cl.date === date).forEach(cl => {
      allClasses.push({ cl, course, enr });
    });
  });
  if (allClasses.length === 0) return "";

  const professorUpper = (allClasses[0].cl.professor || "").toUpperCase();
  const courseNames = [...new Set(allClasses.map(i => i.course ? i.course.name : "").filter(Boolean))];
  const courseLine = courseNames.join("/");

  const withTime = allClasses.find(i => i.cl.startTime && i.cl.endTime);
  const startTime = withTime ? withTime.cl.startTime : "";
  const endTime   = withTime ? withTime.cl.endTime   : "";
  const modality  = (allClasses[0].cl.modality || s.modality || "").toLowerCase();

  const diasStr = (s.diasClase || [])
    .map(d => d.charAt(0).toUpperCase() + d.slice(1))
    .join("/");
  const schedParts = [];
  if (diasStr) schedParts.push(diasStr);
  if (startTime && endTime) schedParts.push(`de ${startTime}hs a ${endTime}hs`);
  if (modality) schedParts.push(modality);
  const schedLine = schedParts.join(" ");

  const enr = allClasses[0].enr;
  const topics = allClasses.map(i => `- ${renderTopicText(i.cl.topic)}`).join("\n");

  const hwLines = [];
  allClasses.forEach(i => {
    if (i.cl.homework?.task) hwLines.push(i.cl.homework.task.trim());
  });

  const obsLines = [];
  allClasses.forEach(i => {
    (i.cl.observations || "").split("\n").map(l => l.trim()).filter(Boolean)
      .forEach(l => { if (!obsLines.includes(l)) obsLines.push(l); });
  });

  const empresaInforme = s.empresaId ? getCompany(s.empresaId) : null;
  let text = `*Informe  ${professorUpper}*\n`;
  text += `*- ${s.name} ${s.surname}${empresaInforme ? " (" + empresaInforme.name + ")" : ""} | ${courseLine}*${schedLine ? " " + schedLine : ""}\n`;
  text += `\n`;
  if (enr.startDate)    text += `*FECHA DE INICIO:* ${fmtDate(enr.startDate)}\n`;
  if (enr.estimatedEnd) text += `*FECHA DE CULMINACIÓN ESTIMADA:* ${fmtDate(enr.estimatedEnd)}\n`;
  text += `\n`;
  text += `*Desarrollo:* \n`;
  text += topics;
  if (hwLines.length > 0) {
    text += `\n\n*HOMEWORK*\n`;
    text += hwLines.map(l => `- ${l}`).join("\n");
  }
  if (obsLines.length > 0) {
    text += `\n\n*Observaciones:* \n`;
    text += obsLines.map(l => `- ${l}`).join("\n");
  }
  return text;
}

function clipboardWrite(text) {
  const fallback = () => {
    const el = document.createElement("textarea");
    el.value = text; el.style.position = "fixed"; el.style.opacity = "0";
    document.body.appendChild(el); el.select();
    try { document.execCommand("copy"); toast("Informe copiado."); } catch { toast("No se pudo copiar."); }
    document.body.removeChild(el);
  };
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => toast("Informe copiado al portapapeles.")).catch(fallback);
  } else { fallback(); }
}

function findEnrollment(enrollId) {
  for (const s of STUDENTS) {
    const e = s.enrollments.find(e => e.enrollId === enrollId);
    if (e) return { student: s, enr: e };
  }
  return null;
}

// ====== Alert Helpers ======
function daysSince(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + "T00:00:00");
  const now = new Date(); now.setHours(0, 0, 0, 0);
  return Math.floor((now - d) / 86400000);
}

function getLastClassDate(s) {
  let last = "";
  (s.enrollments || []).forEach(enr => {
    (enr.classes || []).forEach(cl => { if (cl.date && cl.date > last) last = cl.date; });
  });
  return last;
}

function getLastPaidDateForMonthly(s) {
  // Pagos unificados por alumno. Solo alerta si la modalidad es mensual y el alumno
  // no está finalizado (ni por estado manual ni por tener todos los cursos completados).
  if (s.estado === "finalizado") return "";
  if ((s.payment?.type) !== "mensual") return "";
  const enrs = s.enrollments || [];
  if (enrs.length && enrs.every(e => e.completed)) return "";
  const paidDates = effectivePayments(s).filter(p => p.paid && p.date).map(p => p.date);
  if (paidDates.length) return paidDates.slice().sort().at(-1);
  // Sin pagos aún: usar la fecha de inicio más temprana de sus cursos como referencia
  let earliestStart = "";
  (s.enrollments || []).forEach(enr => {
    if (enr.startDate && (!earliestStart || enr.startDate < earliestStart)) earliestStart = enr.startDate;
  });
  return earliestStart;
}

function getStudentAlerts(s) {
  const alerts = [];
  const dismissed = s.alertasDismissed || {};
  const hasActiveEnrollments = (s.enrollments || []).some(e => !e.completed);

  if (hasActiveEnrollments) {
    const lastClass = getLastClassDate(s);
    const days = lastClass ? daysSince(lastClass) : null;
    if (days !== null && days > 14 && dismissed.inactividad !== lastClass) {
      alerts.push({ type: "inactividad", days, key: lastClass });
    }
  }

  // Las alertas de pago solo las ve el administrador (los pagos están ocultos para el resto)
  if (isAdmin()) {
    const tieneActivo = (s.enrollments || []).some(e => !e.completed);
    const eff = effectivePayments(s);
    if (eff.length === 0) {
      // Todavía no tiene ningún pago cargado (ni propio ni de la empresa)
      if (s.estado !== "finalizado" && tieneActivo && dismissed.sinpago !== "sinpago") {
        alerts.push({ type: "sinpago", days: null, key: "sinpago" });
      }
    } else {
      // Atrasado con el pago (mensual, no finalizado)
      const lastPaid = getLastPaidDateForMonthly(s);
      if (lastPaid) {
        const days = daysSince(lastPaid);
        if (days !== null && days > 40 && dismissed.pago !== lastPaid) {
          alerts.push({ type: "pago", days, key: lastPaid });
        }
      }
    }
  }

  return alerts;
}

// ====== Finanzas (dashboards de dinero — solo admin) ======
const MESES_ABR = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];
function monthLabel(ym) {
  const [y, m] = (ym || "").split("-");
  const idx = parseInt(m) - 1;
  return (MESES_ABR[idx] || m) + " " + (y || "");
}

function computeFinance() {
  let totalPaid = 0, totalPending = 0, currentMonthPaid = 0;
  const byCourse = {}, byMonth = {}, byCompany = {};
  const now = new Date();
  const curYM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  STUDENTS.forEach(s => {
    const eff = effectivePayments(s);        // alumnos de empresa: lo que pagó la empresa por ellos
    const paidList = eff.filter(p => p.paid);
    const paidTotal = paidList.reduce((a, p) => a + (p.amount || 0), 0);
    totalPaid += paidTotal;
    totalPending += eff.filter(p => !p.paid).reduce((a, p) => a + (p.amount || 0), 0);

    paidList.forEach(p => {
      const ym = (p.date || "").slice(0, 7);
      if (ym) byMonth[ym] = (byMonth[ym] || 0) + (p.amount || 0);
      if (ym === curYM) currentMonthPaid += (p.amount || 0);
    });

    // Repartir lo pagado por el alumno entre sus cursos (estimación, el pago es unificado)
    const courseIds = (s.enrollments || []).map(e => e.courseId).filter(Boolean);
    if (courseIds.length && paidTotal) {
      const share = paidTotal / courseIds.length;
      courseIds.forEach(cid => { byCourse[cid] = (byCourse[cid] || 0) + share; });
    }

    const key = s.empresaId || "__none__";
    byCompany[key] = (byCompany[key] || 0) + paidTotal;
  });

  // Pagos generales de empresa (sin alumno específico)
  COMPANIES.forEach(c => {
    (c.pagosEmpresa || []).filter(p => p.paid && !p.studentId).forEach(p => {
      totalPaid += (p.amount || 0);
      byCompany[c.id] = (byCompany[c.id] || 0) + (p.amount || 0);
      const ym = (p.date || "").slice(0, 7);
      if (ym) byMonth[ym] = (byMonth[ym] || 0) + (p.amount || 0);
      if (ym === curYM) currentMonthPaid += (p.amount || 0);
    });
    (c.pagosEmpresa || []).filter(p => !p.paid && !p.studentId).forEach(p => { totalPending += (p.amount || 0); });
  });

  const byCourseArr = Object.entries(byCourse)
    .map(([cid, amount]) => ({ name: (getCourse(cid)?.name) || cid, amount: Math.round(amount) }))
    .sort((a, b) => b.amount - a.amount);
  const byMonthArr = Object.keys(byMonth).sort().map(ym => ({ ym, amount: Math.round(byMonth[ym]) }));
  const byCompanyArr = Object.entries(byCompany)
    .map(([k, amount]) => ({ name: k === "__none__" ? "Sin empresa" : (getCompany(k)?.name || k), amount: Math.round(amount) }))
    .sort((a, b) => b.amount - a.amount);

  return { totalPaid, totalPending, currentMonthPaid, byCourse: byCourseArr, byMonth: byMonthArr, byCompany: byCompanyArr };
}

// ====== Vista: Dashboard ======
function viewDashboard() {
  const totalStudents = STUDENTS.length;
  const totalCourses = COURSES.length;
  const totalClasses = STUDENTS.reduce((s, st) => s + st.enrollments.reduce((es, e) => es + e.classes.length, 0), 0);
  const totalEnrollments = STUDENTS.reduce((s, st) => s + st.enrollments.length, 0);

  const predefinedCourses = COURSES.filter(c => c.topics.length > 0).map(c => {
    const enrs = STUDENTS.flatMap(s => s.enrollments.filter(e => e.courseId === c.id));
    const done = enrs.reduce((s, e) => s + e.classes.length, 0);
    const total = enrs.length * c.topics.length;
    return { name: c.name, done, total, pct: total > 0 ? Math.round(done / total * 100) : 0 };
  });

  const progressHTML = predefinedCourses.length > 0
    ? predefinedCourses.map(c => `
      <div class="progress-item">
        <div class="progress-label"><span>${esc(c.name)}</span><b>${c.done} / ${c.total} — ${c.pct}%</b></div>
        <div class="progress-bar-track"><div class="progress-bar-fill" style="width:${c.pct}%"></div></div>
      </div>`).join("")
    : '<div class="empty-sm">No hay cursos con temas predefinidos.</div>';

  const recentStudents = STUDENTS.slice(-5).reverse();
  const recentHTML = recentStudents.length > 0
    ? recentStudents.map(s => {
        const color = colorFor(s.id);
        const ini = initials(s.name, s.surname);
        const tags = s.enrollments.map(e => {
          const c = getCourse(e.courseId);
          return c ? `<span class="course-tag">${esc(c.name)}</span>` : "";
        }).join("");
        return `
        <div class="recent-row" data-open="${s.id}">
          <div class="t-student">
            <div class="t-avatar" style="background:${color};width:34px;height:34px;font-size:11px;border-radius:9px">${ini}</div>
            <div>
              <div class="name" style="font-size:13.5px">${esc(s.name)} ${esc(s.surname)}</div>
              <div class="mail">${esc(s.phone)}</div>
            </div>
          </div>
          <div class="t-courses">${tags || '<span class="no-course">Sin cursos</span>'}</div>
        </div>`;
      }).join("")
    : '<div class="empty-sm">No hay alumnos registrados.</div>';

  const fin = isAdmin() ? computeFinance() : null;
  const courseCounts = COURSES
    .map(c => ({ name: c.name, n: STUDENTS.filter(s => s.enrollments.some(e => e.courseId === c.id)).length }))
    .sort((a, b) => b.n - a.n);
  const topCourses = courseCounts.slice(0, 5);
  const lowCourses = courseCounts.slice().reverse().slice(0, 5);
  const rankRow = c => `<div class="rank-row"><span class="rank-name">${esc(c.name)}</span><span class="rank-bar-wrap"><span class="rank-bar" style="width:${courseCounts[0] && courseCounts[0].n ? Math.round((c.n / courseCounts[0].n) * 100) : 0}%"></span></span><span class="rank-n">${c.n}</span></div>`;
  const tips = fin ? buildGrowthTips(courseCounts, fin) : [];
  const cursosDash = fin ? `
  <div class="charts-row">
    <div class="chart-card">
      <h3>Cursos con más alumnos</h3>
      <div class="rank-list">${topCourses.length ? topCourses.map(rankRow).join("") : '<div class="empty-sm">Sin datos.</div>'}</div>
    </div>
    <div class="chart-card">
      <h3>Cursos con menos alumnos <span style="font-size:11px;color:var(--ink-3);font-weight:500">(oportunidades)</span></h3>
      <div class="rank-list">${lowCourses.length ? lowCourses.map(rankRow).join("") : '<div class="empty-sm">Sin datos.</div>'}</div>
    </div>
  </div>
  <div class="chart-card chart-card-full" style="margin-top:18px">
    <h3>Consejos para captar más alumnos</h3>
    <ul class="tips-list">${tips.map(t => `<li>${t}</li>`).join("")}</ul>
  </div>` : "";
  const financeSection = fin ? `
  <div class="page-head" style="margin-top:26px">
    <div><h2>Finanzas</h2><p>Recaudación y evolución de ingresos (solo administrador).</p></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn btn-ghost" data-export-dashboard-pdf>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        PDF
      </button>
      <button class="btn btn-primary" data-export-dashboard>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Panel interactivo
      </button>
    </div>
  </div>
  <div class="kpi-grid">
    <div class="kpi-card">
      <div class="kpi-icon" style="background:#dcfce7"><svg viewBox="0 0 24 24" fill="none" stroke="#059669" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg></div>
      <div class="kpi-body"><div class="kpi-value">${fmt(fin.totalPaid)}</div><div class="kpi-label">Total Recaudado</div><div class="kpi-sub">pagos cobrados</div></div>
    </div>
    <div class="kpi-card">
      <div class="kpi-icon" style="background:#fef3c7"><svg viewBox="0 0 24 24" fill="none" stroke="#b45309" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div>
      <div class="kpi-body"><div class="kpi-value">${fmt(fin.totalPending)}</div><div class="kpi-label">Pendiente de Cobro</div><div class="kpi-sub">pagos no cobrados</div></div>
    </div>
    <div class="kpi-card">
      <div class="kpi-icon" style="background:#eef4ff"><svg viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg></div>
      <div class="kpi-body"><div class="kpi-value">${fmt(fin.currentMonthPaid)}</div><div class="kpi-label">Recaudado este mes</div><div class="kpi-sub">${monthLabel(new Date().toISOString().slice(0,7))}</div></div>
    </div>
  </div>
  <div class="chart-card chart-card-full" style="margin-bottom:18px">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:14px">
      <h3 style="margin:0">Evolución de ingresos por mes</h3>
      <div class="seg-control">
        ${["6", "12", "all"].map(r => `<button class="seg-btn ${state.dashRange === r ? "active" : ""}" data-dash-range="${r}">${r === "all" ? "Todo" : r + "m"}</button>`).join("")}
      </div>
    </div>
    <div class="chart-canvas-wrap" style="height:260px"><canvas id="chartRevenueMonth"></canvas></div>
  </div>
  <div class="charts-row">
    <div class="chart-card">
      <h3>Recaudado por curso <span style="font-size:11px;color:var(--ink-3);font-weight:500">(estimado)</span></h3>
      <div class="chart-canvas-wrap" style="height:260px"><canvas id="chartRevenueCourse"></canvas></div>
    </div>
    <div class="chart-card">
      <h3>Recaudado por empresa</h3>
      <div class="chart-canvas-wrap" style="height:260px"><canvas id="chartRevenueCompany"></canvas></div>
    </div>
  </div>
  ${cursosDash}` : "";

  return `
  <div class="page-head">
    <div><h2>Panel de Control</h2><p>Resumen general de alumnos y cursos de Keynes.</p></div>
  </div>

  <div class="kpi-grid">
    <div class="kpi-card">
      <div class="kpi-icon" style="background:#eef4ff">
        <svg viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
      </div>
      <div class="kpi-body">
        <div class="kpi-value">${totalStudents}</div>
        <div class="kpi-label">Total Alumnos</div>
        <div class="kpi-sub">${totalEnrollments} inscripción${totalEnrollments !== 1 ? "es" : ""}</div>
      </div>
    </div>
    <div class="kpi-card">
      <div class="kpi-icon" style="background:#f3e8ff">
        <svg viewBox="0 0 24 24" fill="none" stroke="#7c3aed" stroke-width="2"><path d="M22 10L12 5 2 10l10 5 10-5z"/><path d="M6 12v5c0 1 2.7 3 6 3s6-2 6-3v-5"/></svg>
      </div>
      <div class="kpi-body">
        <div class="kpi-value">${totalCourses}</div>
        <div class="kpi-label">Cursos Disponibles</div>
        <div class="kpi-sub">${COURSES.filter(c => c.topics.length > 0).length} con temas predefinidos</div>
      </div>
    </div>
    <div class="kpi-card">
      <div class="kpi-icon" style="background:#dcfce7">
        <svg viewBox="0 0 24 24" fill="none" stroke="#059669" stroke-width="2"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
      </div>
      <div class="kpi-body">
        <div class="kpi-value">${totalClasses}</div>
        <div class="kpi-label">Clases Registradas</div>
        <div class="kpi-sub">En todos los cursos</div>
      </div>
    </div>
  </div>

  <div class="chart-card chart-card-full" style="margin-bottom:18px">
    <h3>Alumnos por Curso</h3>
    <div class="chart-canvas-wrap" style="height:260px"><canvas id="chartCourses"></canvas></div>
  </div>

  <div class="charts-row">
    <div class="chart-card">
      <h3>Progreso de Clases</h3>
      <div class="progress-list">${progressHTML}</div>
    </div>
    <div class="chart-card">
      <h3>Últimos Alumnos Registrados</h3>
      <div class="recent-list">${recentHTML}</div>
    </div>
  </div>
  ${financeSection}`;
}

// Consejos de captación de alumnos, en parte derivados de los datos actuales
function buildGrowthTips(courseCounts, fin) {
  const tips = [];
  const low = courseCounts.filter(c => c.n === 0);
  const fewest = courseCounts.slice().reverse().slice(0, 2).filter(c => c.n > 0).map(c => c.name);
  if (low.length) {
    tips.push(`Tenés ${low.length} curso${low.length !== 1 ? "s" : ""} sin alumnos (<b>${esc(low.slice(0, 3).map(c => c.name).join(", "))}</b>). Difundilos con una promoción de lanzamiento o un descuento por tiempo limitado.`);
  } else if (fewest.length) {
    tips.push(`Los cursos con menos alumnos (<b>${fewest.join(", ")}</b>) son buenos candidatos para promociones, paquetes combinados o difusión enfocada en redes.`);
  }

  const finalizados = STUDENTS.filter(s => (s.estado || "activo") === "finalizado").length;
  if (finalizados > 0) {
    tips.push(`Hay <b>${finalizados} alumno${finalizados !== 1 ? "s" : ""} que finalizó</b>. Ofreceles el curso de nivel siguiente o un plan de continuidad: retener es más barato que captar.`);
  }

  if (fin && fin.totalPending > 0) {
    tips.push(`Hay <b>${fmt(fin.totalPending)}</b> pendiente de cobro. Hacé seguimiento: los alumnos al día están más satisfechos y recomiendan más.`);
  }

  const nEmpresas = COMPANIES.length;
  tips.push(nEmpresas > 0
    ? `Ya trabajás con <b>${nEmpresas} empresa${nEmpresas !== 1 ? "s" : ""}</b>. Buscá nuevos convenios corporativos: cada empresa aporta varios alumnos de una sola vez.`
    : `Buscá <b>convenios con empresas</b>: capacitar a su personal suma varios alumnos de una sola vez y da ingresos estables.`);

  tips.push(`Implementá un <b>programa de referidos</b>: un descuento a quien traiga un alumno nuevo multiplica las inscripciones con bajo costo.`);
  tips.push(`Pedí <b>reseñas y testimonios</b> a los alumnos satisfechos y mostralos en redes: la prueba social es lo que más convierte.`);

  return tips;
}

function initDashboardCharts() {
  if (typeof Chart === "undefined") return;

  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  const font = { family: "'Inter', system-ui, sans-serif", size: 12 };
  const gridColor = dark ? "rgba(255,255,255,.09)" : "#eef1f6";
  Chart.defaults.color = dark ? "#adbccf" : "#475569";   // color de ticks/leyenda/tooltip
  const CHART_COLORS = ["#3b82f6", "#8b5cf6", "#10b981", "#f59e0b", "#ef4444", "#06b6d4", "#be185d"];

  function makeChart(id, config) {
    const canvas = document.getElementById(id);
    if (!canvas) return;
    const existing = Chart.getChart(canvas);
    if (existing) existing.destroy();
    return new Chart(canvas, config);
  }

  // 1. Alumnos por curso
  makeChart("chartCourses", {
    type: "bar",
    data: {
      labels: COURSES.map(c => c.name),
      datasets: [{
        label: "Alumnos",
        data: COURSES.map(c => STUDENTS.filter(s => s.enrollments.some(e => e.courseId === c.id)).length),
        backgroundColor: CHART_COLORS,
        borderRadius: 8,
        borderSkipped: false,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { font } },
        y: { grid: { color: gridColor }, ticks: { font, precision: 0, stepSize: 1 }, beginAtZero: true }
      }
    }
  });

  // ── Dashboards de dinero (solo admin; los canvases sólo existen si es admin) ──
  if (isAdmin() && document.getElementById("chartRevenueMonth")) {
    const fin = computeFinance();
    const moneyTip = { callbacks: { label: ctx => " " + fmt(ctx.parsed.y ?? ctx.parsed) } };
    const moneyY = { grid: { color: gridColor }, ticks: { font, callback: v => fmt(v) }, beginAtZero: true };
    const months = state.dashRange === "all" ? fin.byMonth : fin.byMonth.slice(-parseInt(state.dashRange));

    // 2. Evolución de ingresos por mes (línea)
    makeChart("chartRevenueMonth", {
      type: "line",
      data: {
        labels: months.map(m => monthLabel(m.ym)),
        datasets: [{
          label: "Ingresos", data: months.map(m => m.amount),
          borderColor: "#2563eb", backgroundColor: "rgba(37,99,235,.12)",
          fill: true, tension: .3, pointRadius: 3, pointBackgroundColor: "#2563eb",
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: moneyTip },
        scales: { x: { grid: { display: false }, ticks: { font } }, y: moneyY }
      }
    });

    // 3. Recaudado por curso (barras)
    makeChart("chartRevenueCourse", {
      type: "bar",
      data: {
        labels: fin.byCourse.map(c => c.name),
        datasets: [{ label: "Recaudado", data: fin.byCourse.map(c => c.amount), backgroundColor: CHART_COLORS, borderRadius: 8, borderSkipped: false }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: moneyTip },
        scales: { x: { grid: { display: false }, ticks: { font } }, y: moneyY }
      }
    });

    // 4. Recaudado por empresa (barras horizontales)
    makeChart("chartRevenueCompany", {
      type: "bar",
      data: {
        labels: fin.byCompany.map(c => c.name),
        datasets: [{ label: "Recaudado", data: fin.byCompany.map(c => c.amount), backgroundColor: "#8b5cf6", borderRadius: 8, borderSkipped: false }]
      },
      options: {
        indexAxis: "y",
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => " " + fmt(ctx.parsed.x) } } },
        scales: { x: { grid: { color: gridColor }, ticks: { font, callback: v => fmt(v) }, beginAtZero: true }, y: { grid: { display: false }, ticks: { font } } }
      }
    });
  }
}

// Exportar el panel de finanzas a un HTML interactivo autocontenido (solo admin).
// PDF no permite interactuar con los gráficos; un HTML con Chart.js embebido sí:
// se abre en el navegador y se puede hover/inspeccionar cada dato, incluso offline.
async function exportDashboardHTML() {
  if (!isAdmin()) return;
  toast("Generando panel interactivo…");
  const fin = computeFinance();
  const gen = new Date().toLocaleString("es");

  // Intentar embeber Chart.js para que funcione sin conexión; si falla, usar CDN.
  let chartTag = '<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"><\/script>';
  try {
    const src = await fetch("https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js").then(r => r.ok ? r.text() : null);
    if (src) chartTag = `<script>${src}<\/script>`;
  } catch {}

  const money = n => new Intl.NumberFormat("es-PY").format(Math.round(n || 0));
  const rowsTable = (arr, labelKey, mapLabel) => arr.map(x =>
    `<tr><td>${mapLabel ? mapLabel(x[labelKey]) : x[labelKey]}</td><td class="num">₲ ${money(x.amount)}</td></tr>`).join("");

  const data = {
    months: fin.byMonth.map(m => monthLabel(m.ym)),
    monthVals: fin.byMonth.map(m => m.amount),
    courses: fin.byCourse.map(c => c.name),
    courseVals: fin.byCourse.map(c => c.amount),
    companies: fin.byCompany.map(c => c.name),
    companyVals: fin.byCompany.map(c => c.amount),
  };

  const html = `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Keynes — Panel Financiero</title>
${chartTag}
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter',system-ui,-apple-system,sans-serif;background:#f3f5f9;color:#0f172a;padding:24px;max-width:1100px;margin:0 auto}
  h1{font-size:22px;margin-bottom:2px}.sub{color:#64748b;font-size:13px;margin-bottom:20px}
  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin-bottom:22px}
  .kpi{background:#fff;border:1px solid #e6e9f0;border-radius:14px;padding:16px 18px;box-shadow:0 4px 18px rgba(15,23,42,.06)}
  .kpi .v{font-size:24px;font-weight:800}.kpi .l{color:#64748b;font-size:13px;margin-top:2px}
  .card{background:#fff;border:1px solid #e6e9f0;border-radius:14px;padding:18px;margin-bottom:18px;box-shadow:0 4px 18px rgba(15,23,42,.06)}
  .card h3{font-size:15px;margin-bottom:12px}
  .wrap{position:relative;height:300px}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:18px}
  @media(max-width:760px){.grid2{grid-template-columns:1fr}}
  table{width:100%;border-collapse:collapse;font-size:13px;margin-top:14px}
  th,td{text-align:left;padding:7px 8px;border-bottom:1px solid #eef1f6}
  td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
  .foot{color:#94a3b8;font-size:11px;text-align:center;margin-top:20px}
</style></head><body>
  <h1>Keynes — Panel Financiero</h1>
  <div class="sub">Generado el ${gen} · pasá el mouse sobre los gráficos para ver el detalle</div>
  <div class="kpis">
    <div class="kpi"><div class="v">₲ ${money(fin.totalPaid)}</div><div class="l">Total recaudado</div></div>
    <div class="kpi"><div class="v">₲ ${money(fin.totalPending)}</div><div class="l">Pendiente de cobro</div></div>
    <div class="kpi"><div class="v">₲ ${money(fin.currentMonthPaid)}</div><div class="l">Recaudado este mes</div></div>
  </div>
  <div class="card"><h3>Evolución de ingresos por mes</h3><div class="wrap"><canvas id="cM"></canvas></div>
    <table><thead><tr><th>Mes</th><th class="num">Ingresos</th></tr></thead><tbody>${rowsTable(fin.byMonth, "ym", monthLabel)}</tbody></table>
  </div>
  <div class="grid2">
    <div class="card"><h3>Recaudado por curso <span style="font-weight:500;color:#94a3b8;font-size:11px">(estimado)</span></h3><div class="wrap"><canvas id="cC"></canvas></div></div>
    <div class="card"><h3>Recaudado por empresa</h3><div class="wrap"><canvas id="cE"></canvas></div></div>
  </div>
  <div class="foot">Keynes Education & Technology — Reporte interno confidencial</div>
<script>
  const D=${JSON.stringify(data)};
  const money=n=>'₲ '+new Intl.NumberFormat('es-PY').format(Math.round(n||0));
  const COL=["#3b82f6","#8b5cf6","#10b981","#f59e0b","#ef4444","#06b6d4","#be185d"];
  const moneyTip={callbacks:{label:c=>' '+money(c.parsed.y!=null?c.parsed.y:c.parsed.x!=null?c.parsed.x:c.parsed)}};
  new Chart(cM,{type:'line',data:{labels:D.months,datasets:[{label:'Ingresos',data:D.monthVals,borderColor:'#2563eb',backgroundColor:'rgba(37,99,235,.12)',fill:true,tension:.3,pointRadius:3}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:moneyTip},scales:{y:{ticks:{callback:money},beginAtZero:true}}}});
  new Chart(cC,{type:'bar',data:{labels:D.courses,datasets:[{data:D.courseVals,backgroundColor:COL,borderRadius:8}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:moneyTip},scales:{y:{ticks:{callback:money},beginAtZero:true}}}});
  new Chart(cE,{type:'bar',data:{labels:D.companies,datasets:[{data:D.companyVals,backgroundColor:'#8b5cf6',borderRadius:8}]},options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:moneyTip},scales:{x:{ticks:{callback:money},beginAtZero:true}}}});
<\/script>
</body></html>`;

  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `Keynes_Finanzas_${new Date().toISOString().slice(0, 10)}.html`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast("Panel interactivo descargado. Abrilo en tu navegador.");
}

// Carga diferida de librerías CDN pesadas: se bajan solo al usarlas (no en el boot).
const _libPromises = {};
function loadScript(src) {
  if (_libPromises[src]) return _libPromises[src];
  _libPromises[src] = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { delete _libPromises[src]; reject(new Error('No se pudo cargar ' + src)); };
    document.head.appendChild(s);
  });
  return _libPromises[src];
}
const ensureXLSX  = () => (typeof XLSX !== 'undefined' && XLSX.utils) ? Promise.resolve()
  : loadScript('https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js');

// Helper: obtener el constructor de jsPDF (cargándolo on-demand) o avisar si falta
async function _getJsPDF() {
  try {
    if (!(window.jspdf || window.jsPDF)) {
      await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
    }
  } catch {}
  const lib = window.jspdf || window.jsPDF;
  if (!lib) { toast("La librería de PDF no está disponible. Verificá tu conexión a internet."); return null; }
  return lib.jsPDF || lib;
}

// Exportar el panel de finanzas a PDF, con el mismo formato visual que el HTML.
async function exportDashboardPDF() {
  if (!isAdmin()) return;
  const JsPdf = await _getJsPDF(); if (!JsPdf) return;
  const doc = new JsPdf({ unit: "mm", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  const M = 14;
  let y = 16;
  const fin = computeFinance();
  const brk = (need) => { if (y + need > 285) { doc.addPage(); y = 16; } };

  // Encabezado
  doc.setFont("helvetica", "bold"); doc.setFontSize(17); doc.setTextColor(15, 23, 42);
  doc.text("Keynes — Panel Financiero", M, y); y += 6;
  doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.setTextColor(100, 116, 139);
  doc.text("Generado el " + new Date().toLocaleString("es"), M, y); y += 9;

  // KPIs como tarjetas
  const kpis = [
    { v: fmt(fin.totalPaid),        l: "Total recaudado",     c: [220, 252, 231], t: [21, 128, 61] },
    { v: fmt(fin.totalPending),     l: "Pendiente de cobro",  c: [254, 243, 199], t: [180, 83, 9] },
    { v: fmt(fin.currentMonthPaid), l: "Recaudado este mes",  c: [238, 244, 255], t: [37, 99, 235] },
  ];
  const gap = 4, cardW = (W - M * 2 - gap * 2) / 3, cardH = 22;
  kpis.forEach((k, i) => {
    const x = M + i * (cardW + gap);
    doc.setFillColor(...k.c); doc.roundedRect(x, y, cardW, cardH, 2.5, 2.5, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(12.5); doc.setTextColor(...k.t);
    doc.text(String(k.v), x + 5, y + 10);
    doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor(71, 85, 105);
    doc.text(k.l, x + 5, y + 17);
  });
  y += cardH + 10;

  // Gráficos (imagen del canvas)
  const addChart = (id, title) => {
    const canvas = document.getElementById(id);
    if (!canvas) return;
    brk(70);
    doc.setFont("helvetica", "bold"); doc.setFontSize(12); doc.setTextColor(15, 23, 42);
    doc.text(title, M, y); y += 4;
    try {
      const img = canvas.toDataURL("image/png", 1.0);
      const w = W - M * 2, h = Math.min(w * (canvas.height / canvas.width), 80);
      doc.addImage(img, "PNG", M, y, w, h); y += h + 9;
    } catch { y += 4; }
  };
  addChart("chartRevenueMonth", "Evolución de ingresos por mes");
  addChart("chartRevenueCourse", "Recaudado por curso (estimado)");
  addChart("chartRevenueCompany", "Recaudado por empresa");

  // Tabla auxiliar (dos columnas: etiqueta / monto)
  const drawKV = (title, arr, labelFn) => {
    if (!arr.length) return;
    brk(16);
    doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.setTextColor(15, 23, 42);
    doc.text(title, M, y); y += 6;
    doc.setFillColor(241, 245, 249); doc.rect(M, y - 4, W - M * 2, 6.5, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(100, 116, 139);
    doc.text("CONCEPTO", M + 2, y); doc.text("MONTO", W - M - 2, y, { align: "right" }); y += 4;
    doc.setFont("helvetica", "normal"); doc.setFontSize(9.5); doc.setTextColor(30, 41, 59);
    arr.forEach((x, i) => {
      brk(6);
      if (i % 2 === 1) { doc.setFillColor(249, 250, 252); doc.rect(M, y - 4, W - M * 2, 6, "F"); }
      doc.text(String(labelFn(x)), M + 2, y);
      doc.text(fmt(x.amount), W - M - 2, y, { align: "right" });
      y += 6;
    });
    y += 4;
  };
  drawKV("Detalle por mes", fin.byMonth, m => monthLabel(m.ym));
  drawKV("Recaudado por curso (estimado)", fin.byCourse, c => c.name);
  drawKV("Recaudado por empresa", fin.byCompany, c => c.name);

  doc.setFontSize(7.5); doc.setTextColor(148, 163, 184);
  doc.text("Keynes Education & Technology — Reporte interno confidencial", M, 292);
  doc.save(`Keynes_Finanzas_${new Date().toISOString().slice(0, 10)}.pdf`);
  toast("Panel exportado a PDF.");
}

// ¿El pago cae dentro del período elegido? (years/months como Set de strings; vacío = todos)
function _payInPeriod(p, years, months) {
  if (years.size === 0 && months.size === 0) return true;
  const ym = p.date || "";
  const okY = years.size === 0 || years.has(ym.slice(0, 4));
  const okM = months.size === 0 || months.has(ym.slice(5, 7));
  return okY && okM;
}

// Exportar registros de pagos a PDF, con filtros de alumnos y período.
// opts = { studentFilter: 'todos'|'pendiente'|'alDia', years:Set, months:Set, periodLabel, filterLabel }
async function exportPagosPDF(opts) {
  if (!isAdmin()) return;
  opts = opts || { studentFilter: "todos", years: new Set(), months: new Set(), periodLabel: "Todos los períodos", filterLabel: "Todos los alumnos" };
  const JsPdf = await _getJsPDF(); if (!JsPdf) return;
  const doc = new JsPdf({ unit: "mm", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  const M = 14;
  let y = 16;
  const brk = (need) => { if (y + need > 285) { doc.addPage(); y = 16; } };

  // Filtrar pagos por período y quedarnos con los alumnos según el filtro
  const items = STUDENTS
    .map(s => ({ s, pagos: effectivePayments(s).filter(p => _payInPeriod(p, opts.years, opts.months)) }))
    .filter(({ s, pagos }) => {
      if (opts.excludeEmpresa && isEmpresaStudent(s)) return false;
      if (opts.studentFilter === "especificos") return opts.studentIds && opts.studentIds.has(s.id);
      const hasPend = pagos.some(p => !p.paid);
      if (opts.studentFilter === "pendiente") return hasPend;
      if (opts.studentFilter === "alDia")     return !hasPend;
      return true; // todos
    })
    .sort((a, b) => (a.s.name + " " + a.s.surname).localeCompare(b.s.name + " " + b.s.surname));

  let totalPaid = 0, totalPend = 0, conPagos = 0;
  items.forEach(({ pagos }) => {
    totalPaid += pagos.filter(p => p.paid).reduce((a, p) => a + (p.amount || 0), 0);
    totalPend += pagos.filter(p => !p.paid).reduce((a, p) => a + (p.amount || 0), 0);
    if (pagos.length) conPagos++;
  });

  // Encabezado
  doc.setFont("helvetica", "bold"); doc.setFontSize(17); doc.setTextColor(15, 23, 42);
  doc.text("Keynes — Registro de Pagos de Alumnos", M, y); y += 6;
  doc.setFont("helvetica", "normal"); doc.setFontSize(9.5); doc.setTextColor(100, 116, 139);
  doc.text("Generado el " + new Date().toLocaleString("es"), M, y); y += 5;
  doc.text(`Filtro: ${opts.filterLabel}  ·  Período: ${opts.periodLabel}`, M, y); y += 8;

  // Resumen general
  doc.setFillColor(238, 244, 255); doc.roundedRect(M, y, W - M * 2, 20, 2.5, 2.5, "F");
  doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.setTextColor(30, 41, 59);
  doc.text(`Total recaudado: ${fmt(totalPaid)}`, M + 5, y + 8);
  doc.text(`Pendiente: ${fmt(totalPend)}`, M + 5, y + 15);
  doc.setFont("helvetica", "normal"); doc.setFontSize(9.5); doc.setTextColor(71, 85, 105);
  doc.text(`${items.length} alumnos · ${conPagos} con pagos · ${items.length - conPagos} sin pagos`, W - M - 5, y + 8, { align: "right" });
  y += 28;

  if (!items.length) {
    doc.setFont("helvetica", "italic"); doc.setFontSize(11); doc.setTextColor(100, 116, 139);
    doc.text("No hay alumnos que coincidan con los filtros seleccionados.", M, y);
    doc.save(`Keynes_Pagos_${new Date().toISOString().slice(0, 10)}.pdf`);
    toast("Registro de pagos exportado a PDF.");
    return;
  }

  const payTypeTxt = s => {
    const t = s.payment?.type || "mensual";
    return t === "paquete" ? `Paquete${s.payment?.packageHours ? " " + s.payment.packageHours + "hs" : ""}` : payTypeLabel(t);
  };

  items.forEach(({ s, pagos: pagosRaw }) => {
    brk(20);
    const pagos = pagosRaw.slice().sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    const paid = pagos.filter(p => p.paid).reduce((a, p) => a + (p.amount || 0), 0);
    const pend = pagos.filter(p => !p.paid).reduce((a, p) => a + (p.amount || 0), 0);
    const empresa = s.empresaId ? getCompany(s.empresaId) : null;

    // Encabezado del alumno
    doc.setFillColor(241, 245, 249); doc.rect(M, y - 4, W - M * 2, 7, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(10.5); doc.setTextColor(15, 23, 42);
    doc.text(`${s.name} ${s.surname}`, M + 2, y + 1);
    doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor(100, 116, 139);
    const meta = [estadoLabel(s.estado), payTypeTxt(s), empresa ? empresa.name : null].filter(Boolean).join("  ·  ");
    doc.text(meta, W - M - 2, y + 1, { align: "right" });
    y += 9;

    if (!pagos.length) {
      doc.setFont("helvetica", "italic"); doc.setFontSize(9); doc.setTextColor(180, 83, 9);
      doc.text("Sin pagos registrados", M + 2, y); y += 7;
    } else {
      // Columnas: Fecha | Concepto | Monto | Estado
      const cF = M + 2, cC = M + 32, cM = W - M - 45, cE = W - M - 22;
      doc.setFont("helvetica", "bold"); doc.setFontSize(7.5); doc.setTextColor(100, 116, 139);
      doc.text("FECHA", cF, y); doc.text("CONCEPTO", cC, y); doc.text("MONTO", cM, y); doc.text("ESTADO", cE, y);
      y += 4;
      doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(30, 41, 59);
      pagos.forEach((p, i) => {
        brk(6);
        if (i % 2 === 1) { doc.setFillColor(249, 250, 252); doc.rect(M, y - 4, W - M * 2, 6, "F"); }
        doc.setTextColor(30, 41, 59);
        doc.text(fmtDate(p.date) || "—", cF, y);
        doc.text(doc.splitTextToSize(p.concept || "—", cM - cC - 3)[0], cC, y);
        doc.text(fmt(p.amount), cM, y);
        if (p.paid) { doc.setTextColor(21, 128, 61); doc.text("Pagado", cE, y); }
        else { doc.setTextColor(185, 28, 28); doc.text("Pendiente", cE, y); }
        y += 6;
      });
      doc.setFont("helvetica", "bold"); doc.setFontSize(8.5); doc.setTextColor(71, 85, 105);
      doc.text(`Subtotal — Pagado: ${fmt(paid)}   Pendiente: ${fmt(pend)}`, W - M - 2, y + 1, { align: "right" });
      y += 8;
    }
  });

  doc.setFontSize(7.5); doc.setTextColor(148, 163, 184);
  doc.text("Keynes Education & Technology — Reporte interno confidencial", M, 292);
  doc.save(`Keynes_Pagos_${new Date().toISOString().slice(0, 10)}.pdf`);
  toast("Registro de pagos exportado a PDF.");
}

// Exporta el registro de pagos a CSV (Excel). Respeta los mismos filtros que el PDF.
function exportPagosCSV(opts) {
  if (!isAdmin()) return;
  opts = opts || { studentFilter: "todos", years: new Set(), months: new Set(), periodLabel: "Todos los períodos", filterLabel: "Todos los alumnos" };

  const items = STUDENTS
    .map(s => ({ s, pagos: effectivePayments(s).filter(p => _payInPeriod(p, opts.years, opts.months)) }))
    .filter(({ s, pagos }) => {
      if (opts.excludeEmpresa && isEmpresaStudent(s)) return false;
      if (opts.studentFilter === "especificos") return opts.studentIds && opts.studentIds.has(s.id);
      const hasPend = pagos.some(p => !p.paid);
      if (opts.studentFilter === "pendiente") return hasPend;
      if (opts.studentFilter === "alDia")     return !hasPend;
      return true;
    })
    .sort((a, b) => (a.s.name + " " + a.s.surname).localeCompare(b.s.name + " " + b.s.surname));

  const payTypeTxt = s => {
    const t = s.payment?.type || "mensual";
    return t === "paquete" ? `Paquete${s.payment?.packageHours ? " " + s.payment.packageHours + "hs" : ""}` : payTypeLabel(t);
  };

  const SEP = ";";
  const esc = v => {
    let str = v == null ? "" : String(v);
    // Evitar inyección de fórmulas en Excel (celdas que empiezan con = + @ o -texto)
    if (/^[=+@]/.test(str) || /^-[^\d]/.test(str)) str = "'" + str;
    return /[";\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const row = arr => arr.map(esc).join(SEP);
  const lines = [];

  // Encabezado del documento
  lines.push(row(["Keynes — Registro de Pagos de Alumnos"]));
  lines.push(row(["Generado el", new Date().toLocaleString("es")]));
  lines.push(row(["Filtro", opts.filterLabel, "Período", opts.periodLabel]));
  lines.push("");

  // Cabecera de la tabla
  lines.push(row(["Alumno", "Estado", "Empresa", "Tipo de pago", "Fecha", "Concepto", "Monto (Gs.)", "Estado del pago"]));

  let totalPaid = 0, totalPend = 0;
  items.forEach(({ s, pagos }) => {
    const empresa = s.empresaId ? getCompany(s.empresaId) : null;
    const nombre = `${s.name} ${s.surname}`;
    const sorted = pagos.slice().sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    if (!sorted.length) {
      lines.push(row([nombre, estadoLabel(s.estado), empresa ? empresa.name : "", payTypeTxt(s), "", "Sin pagos registrados", "", ""]));
      return;
    }
    sorted.forEach(p => {
      if (p.paid) totalPaid += p.amount || 0; else totalPend += p.amount || 0;
      lines.push(row([
        nombre, estadoLabel(s.estado), empresa ? empresa.name : "", payTypeTxt(s),
        fmtDate(p.date) || "", p.concept || "", p.amount || 0, p.paid ? "Pagado" : "Pendiente",
      ]));
    });
  });

  // Totales
  lines.push("");
  lines.push(row(["", "", "", "", "", "Total recaudado (Gs.)", totalPaid, ""]));
  lines.push(row(["", "", "", "", "", "Total pendiente (Gs.)", totalPend, ""]));
  lines.push(row(["", "", "", "", "", "Alumnos incluidos", items.length, ""]));

  // BOM UTF-8 para que Excel lea bien los acentos
  const csv = "﻿" + lines.join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `Keynes_Pagos_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast("Registro de pagos exportado a Excel (.csv).");
}

// Exporta el registro de pagos a XLSX con estilos (Excel). Mismos filtros que el PDF.
async function exportPagosXLSX(opts) {
  if (!isAdmin()) return;
  try { await ensureXLSX(); } catch {}
  if (typeof XLSX === "undefined" || !XLSX.utils) {
    toast("No se pudo cargar Excel; se descarga en .csv.");
    return exportPagosCSV(opts);
  }
  opts = opts || { studentFilter: "todos", years: new Set(), months: new Set(), periodLabel: "Todos los períodos", filterLabel: "Todos los alumnos" };

  const items = STUDENTS
    .map(s => ({ s, pagos: effectivePayments(s).filter(p => _payInPeriod(p, opts.years, opts.months)) }))
    .filter(({ s, pagos }) => {
      if (opts.excludeEmpresa && isEmpresaStudent(s)) return false;
      if (opts.studentFilter === "especificos") return opts.studentIds && opts.studentIds.has(s.id);
      const hasPend = pagos.some(p => !p.paid);
      if (opts.studentFilter === "pendiente") return hasPend;
      if (opts.studentFilter === "alDia")     return !hasPend;
      return true;
    })
    .sort((a, b) => (a.s.name + " " + a.s.surname).localeCompare(b.s.name + " " + b.s.surname));

  const payTypeTxt = s => {
    const t = s.payment?.type || "mensual";
    return t === "paquete" ? `Paquete${s.payment?.packageHours ? " " + s.payment.packageHours + "hs" : ""}` : payTypeLabel(t);
  };

  const HEADERS = ["Alumno", "Estado", "Empresa", "Tipo de pago", "Fecha", "Concepto", "Monto (Gs.)", "Estado del pago"];
  const NCOL = HEADERS.length;
  const aoa = [
    ["Keynes — Registro de Pagos de Alumnos"],
    ["Generado el " + new Date().toLocaleString("es")],
    [`Filtro: ${opts.filterLabel}   ·   Período: ${opts.periodLabel}`],
    [],
    HEADERS,
  ];
  const HEAD_R = 4, DATA_R = 5;
  const dataMeta = []; // { r, paid }

  let totalPaid = 0, totalPend = 0;
  items.forEach(({ s, pagos }) => {
    const empresa = s.empresaId ? getCompany(s.empresaId) : null;
    const nombre = `${s.name} ${s.surname}`;
    const sorted = pagos.slice().sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    if (!sorted.length) {
      aoa.push([nombre, estadoLabel(s.estado), empresa ? empresa.name : "", payTypeTxt(s), "", "Sin pagos registrados", "", ""]);
      dataMeta.push({ r: aoa.length - 1, paid: null });
      return;
    }
    sorted.forEach(p => {
      if (p.paid) totalPaid += p.amount || 0; else totalPend += p.amount || 0;
      aoa.push([nombre, estadoLabel(s.estado), empresa ? empresa.name : "", payTypeTxt(s),
        fmtDate(p.date) || "", p.concept || "", p.amount || 0, p.paid ? "Pagado" : "Pendiente"]);
      dataMeta.push({ r: aoa.length - 1, paid: !!p.paid });
    });
  });

  aoa.push([]);
  const totalPaidR = aoa.length; aoa.push(["", "", "", "", "", "Total recaudado (Gs.)", totalPaid, ""]);
  const totalPendR = aoa.length; aoa.push(["", "", "", "", "", "Total pendiente (Gs.)", totalPend, ""]);
  const countR = aoa.length;     aoa.push(["", "", "", "", "", "Alumnos incluidos", items.length, ""]);

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const ref = c => XLSX.utils.encode_cell(c);

  // Estilos base
  const BRAND = "2563EB", INK = "0F172A", MUTED = "64748B", LINE = "E2E8F0", ALT = "F1F5F9";
  const border = { style: "thin", color: { rgb: LINE } };
  const allBorders = { top: border, bottom: border, left: border, right: border };

  // Título
  ws[ref({ r: 0, c: 0 })].s = { font: { bold: true, sz: 15, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: BRAND } }, alignment: { vertical: "center" } };
  ws[ref({ r: 1, c: 0 })].s = { font: { sz: 10, color: { rgb: MUTED } } };
  ws[ref({ r: 2, c: 0 })].s = { font: { sz: 10, color: { rgb: MUTED } } };

  // Cabecera
  for (let c = 0; c < NCOL; c++) {
    const cell = ws[ref({ r: HEAD_R, c })];
    if (cell) cell.s = { font: { bold: true, sz: 11, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: BRAND } }, alignment: { horizontal: c === 6 ? "right" : "center", vertical: "center" }, border: allBorders };
  }

  // Filas de datos
  dataMeta.forEach(({ r, paid }, i) => {
    const alt = i % 2 === 1;
    for (let c = 0; c < NCOL; c++) {
      const cell = ws[ref({ r, c })];
      if (!cell) continue;
      const st = { font: { sz: 10, color: { rgb: INK } }, border: allBorders, alignment: { vertical: "center" } };
      if (alt) st.fill = { fgColor: { rgb: ALT } };
      if (c === 6) { st.alignment.horizontal = "right"; if (cell.t === "n") cell.z = "#,##0"; }
      if (c === 1 || c === 4) st.alignment.horizontal = "center";
      if (c === 7 && paid !== null) {
        st.font = { sz: 10, bold: true, color: { rgb: paid ? "15803D" : "B91C1C" } };
        st.alignment.horizontal = "center";
      }
      if (c === 5 && paid === null) st.font = { sz: 10, italic: true, color: { rgb: "B45309" } };
      cell.s = st;
    }
  });

  // Totales
  [totalPaidR, totalPendR, countR].forEach(r => {
    const label = ws[ref({ r, c: 5 })];
    const val = ws[ref({ r, c: 6 })];
    if (label) label.s = { font: { bold: true, sz: 10.5, color: { rgb: INK } }, alignment: { horizontal: "right" } };
    if (val) { val.s = { font: { bold: true, sz: 11, color: { rgb: BRAND } }, alignment: { horizontal: "right" } }; if (val.t === "n" && r !== countR) val.z = "#,##0"; }
  });

  ws["!cols"] = [{ wch: 24 }, { wch: 12 }, { wch: 20 }, { wch: 16 }, { wch: 12 }, { wch: 34 }, { wch: 14 }, { wch: 15 }];
  ws["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: NCOL - 1 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: NCOL - 1 } },
    { s: { r: 2, c: 0 }, e: { r: 2, c: NCOL - 1 } },
  ];
  ws["!rows"] = [{ hpt: 26 }];
  // Congelar título + cabecera
  ws["!freeze"] = { xSplit: 0, ySplit: DATA_R, topLeftCell: ref({ r: DATA_R, c: 0 }), activePane: "bottomLeft", state: "frozen" };

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Pagos");
  XLSX.writeFile(wb, `Keynes_Pagos_${new Date().toISOString().slice(0, 10)}.xlsx`);
  toast("Registro de pagos exportado a Excel (.xlsx).");
}

const MESES_PDF = [["01","Ene"],["02","Feb"],["03","Mar"],["04","Abr"],["05","May"],["06","Jun"],["07","Jul"],["08","Ago"],["09","Sep"],["10","Oct"],["11","Nov"],["12","Dic"]];

// Reúne los pagos de empresa según filtro de empresa + período
function _gatherEmpresas(opts) {
  return COMPANIES
    .map(c => ({ c, pagos: (c.pagosEmpresa || []).filter(p => _payInPeriod(p, opts.years, opts.months)) }))
    .filter(({ c }) => opts.companyFilter === "especificas" ? (opts.companyIds && opts.companyIds.has(c.id)) : true)
    .sort((a, b) => a.c.name.localeCompare(b.c.name));
}

async function exportEmpresasPDF(opts) {
  if (!isAdmin()) return;
  opts = opts || { companyFilter: "todas", years: new Set(), months: new Set(), periodLabel: "Todos los períodos", filterLabel: "Todas las empresas" };
  const JsPdf = await _getJsPDF(); if (!JsPdf) return;
  const doc = new JsPdf({ unit: "mm", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  const M = 14;
  let y = 16;
  const brk = (need) => { if (y + need > 285) { doc.addPage(); y = 16; } };

  const items = _gatherEmpresas(opts);
  let totalPaid = 0, totalPend = 0, conPagos = 0;
  items.forEach(({ pagos }) => {
    totalPaid += pagos.filter(p => p.paid).reduce((a, p) => a + (p.amount || 0), 0);
    totalPend += pagos.filter(p => !p.paid).reduce((a, p) => a + (p.amount || 0), 0);
    if (pagos.length) conPagos++;
  });

  doc.setFont("helvetica", "bold"); doc.setFontSize(17); doc.setTextColor(15, 23, 42);
  doc.text("Keynes — Registro de Pagos de Empresas", M, y); y += 6;
  doc.setFont("helvetica", "normal"); doc.setFontSize(9.5); doc.setTextColor(100, 116, 139);
  doc.text("Generado el " + new Date().toLocaleString("es"), M, y); y += 5;
  doc.text(`Filtro: ${opts.filterLabel}  ·  Período: ${opts.periodLabel}`, M, y); y += 8;

  doc.setFillColor(238, 244, 255); doc.roundedRect(M, y, W - M * 2, 20, 2.5, 2.5, "F");
  doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.setTextColor(30, 41, 59);
  doc.text(`Total recaudado: ${fmt(totalPaid)}`, M + 5, y + 8);
  doc.text(`Pendiente: ${fmt(totalPend)}`, M + 5, y + 15);
  doc.setFont("helvetica", "normal"); doc.setFontSize(9.5); doc.setTextColor(71, 85, 105);
  doc.text(`${items.length} empresas · ${conPagos} con pagos`, W - M - 5, y + 8, { align: "right" });
  y += 28;

  if (!items.length) {
    doc.setFont("helvetica", "italic"); doc.setFontSize(11); doc.setTextColor(100, 116, 139);
    doc.text("No hay empresas que coincidan con los filtros seleccionados.", M, y);
    doc.save(`Keynes_Pagos_Empresas_${new Date().toISOString().slice(0, 10)}.pdf`);
    toast("Registro de pagos de empresas exportado a PDF.");
    return;
  }

  items.forEach(({ c, pagos: pagosRaw }) => {
    brk(20);
    const pagos = pagosRaw.slice().sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    const paid = pagos.filter(p => p.paid).reduce((a, p) => a + (p.amount || 0), 0);
    const pend = pagos.filter(p => !p.paid).reduce((a, p) => a + (p.amount || 0), 0);
    const nAlum = STUDENTS.filter(s => s.empresaId === c.id).length;

    doc.setFillColor(241, 245, 249); doc.rect(M, y - 4, W - M * 2, 7, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(10.5); doc.setTextColor(15, 23, 42);
    doc.text(c.name, M + 2, y + 1);
    doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor(100, 116, 139);
    doc.text(`${nAlum} alumno${nAlum !== 1 ? "s" : ""}`, W - M - 2, y + 1, { align: "right" });
    y += 9;

    if (!pagos.length) {
      doc.setFont("helvetica", "italic"); doc.setFontSize(9); doc.setTextColor(180, 83, 9);
      doc.text("Sin pagos registrados", M + 2, y); y += 7;
    } else {
      const cAl = M + 2, cF = M + 55, cC = M + 82, cM = W - M - 45, cE = W - M - 22;
      doc.setFont("helvetica", "bold"); doc.setFontSize(7.5); doc.setTextColor(100, 116, 139);
      doc.text("ALUMNO", cAl, y); doc.text("FECHA", cF, y); doc.text("CONCEPTO", cC, y); doc.text("MONTO", cM, y); doc.text("ESTADO", cE, y);
      y += 4;
      doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(30, 41, 59);
      pagos.forEach((p, i) => {
        brk(6);
        if (i % 2 === 1) { doc.setFillColor(249, 250, 252); doc.rect(M, y - 4, W - M * 2, 6, "F"); }
        const st = p.studentId ? getStudent(p.studentId) : null;
        const alumnoTxt = st ? `${st.name} ${st.surname}` : "General";
        doc.setTextColor(30, 41, 59);
        doc.text(doc.splitTextToSize(alumnoTxt, cF - cAl - 3)[0], cAl, y);
        doc.text(fmtDate(p.date) || "—", cF, y);
        doc.text(doc.splitTextToSize(p.concept || "—", cM - cC - 3)[0], cC, y);
        doc.text(fmt(p.amount), cM, y);
        if (p.paid) { doc.setTextColor(21, 128, 61); doc.text("Pagado", cE, y); }
        else { doc.setTextColor(185, 28, 28); doc.text("Pendiente", cE, y); }
        y += 6;
      });
      doc.setFont("helvetica", "bold"); doc.setFontSize(8.5); doc.setTextColor(71, 85, 105);
      doc.text(`Subtotal — Pagado: ${fmt(paid)}   Pendiente: ${fmt(pend)}`, W - M - 2, y + 1, { align: "right" });
      y += 8;
    }
  });

  doc.setFontSize(7.5); doc.setTextColor(148, 163, 184);
  doc.text("Keynes Education & Technology — Reporte interno confidencial", M, 292);
  doc.save(`Keynes_Pagos_Empresas_${new Date().toISOString().slice(0, 10)}.pdf`);
  toast("Registro de pagos de empresas exportado a PDF.");
}

async function exportEmpresasXLSX(opts) {
  if (!isAdmin()) return;
  try { await ensureXLSX(); } catch {}
  if (typeof XLSX === "undefined" || !XLSX.utils) { toast("No se pudo cargar Excel."); return; }
  opts = opts || { companyFilter: "todas", years: new Set(), months: new Set(), periodLabel: "Todos los períodos", filterLabel: "Todas las empresas" };
  const items = _gatherEmpresas(opts);

  const HEADERS = ["Empresa", "Alumno", "Fecha", "Concepto", "Monto (Gs.)", "Estado del pago"];
  const NCOL = HEADERS.length;
  const aoa = [
    ["Keynes — Registro de Pagos de Empresas"],
    ["Generado el " + new Date().toLocaleString("es")],
    [`Filtro: ${opts.filterLabel}   ·   Período: ${opts.periodLabel}`],
    [],
    HEADERS,
  ];
  const HEAD_R = 4, DATA_R = 5;
  const dataMeta = [];

  let totalPaid = 0, totalPend = 0;
  items.forEach(({ c, pagos }) => {
    const sorted = pagos.slice().sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    if (!sorted.length) {
      aoa.push([c.name, "", "", "Sin pagos registrados", "", ""]);
      dataMeta.push({ r: aoa.length - 1, paid: null });
      return;
    }
    sorted.forEach(p => {
      if (p.paid) totalPaid += p.amount || 0; else totalPend += p.amount || 0;
      const st = p.studentId ? getStudent(p.studentId) : null;
      aoa.push([c.name, st ? `${st.name} ${st.surname}` : "General", fmtDate(p.date) || "", p.concept || "", p.amount || 0, p.paid ? "Pagado" : "Pendiente"]);
      dataMeta.push({ r: aoa.length - 1, paid: !!p.paid });
    });
  });

  aoa.push([]);
  const totalPaidR = aoa.length; aoa.push(["", "", "", "Total recaudado (Gs.)", totalPaid, ""]);
  const totalPendR = aoa.length; aoa.push(["", "", "", "Total pendiente (Gs.)", totalPend, ""]);
  const countR = aoa.length;     aoa.push(["", "", "", "Empresas incluidas", items.length, ""]);

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const ref = c => XLSX.utils.encode_cell(c);
  const BRAND = "2563EB", INK = "0F172A", MUTED = "64748B", LINE = "E2E8F0", ALT = "F1F5F9";
  const border = { style: "thin", color: { rgb: LINE } };
  const allBorders = { top: border, bottom: border, left: border, right: border };
  const MONTO_C = 4;

  ws[ref({ r: 0, c: 0 })].s = { font: { bold: true, sz: 15, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: BRAND } }, alignment: { vertical: "center" } };
  ws[ref({ r: 1, c: 0 })].s = { font: { sz: 10, color: { rgb: MUTED } } };
  ws[ref({ r: 2, c: 0 })].s = { font: { sz: 10, color: { rgb: MUTED } } };

  for (let cc = 0; cc < NCOL; cc++) {
    const cell = ws[ref({ r: HEAD_R, c: cc })];
    if (cell) cell.s = { font: { bold: true, sz: 11, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: BRAND } }, alignment: { horizontal: cc === MONTO_C ? "right" : "center", vertical: "center" }, border: allBorders };
  }

  dataMeta.forEach(({ r, paid }, i) => {
    const alt = i % 2 === 1;
    for (let cc = 0; cc < NCOL; cc++) {
      const cell = ws[ref({ r, c: cc })];
      if (!cell) continue;
      const st = { font: { sz: 10, color: { rgb: INK } }, border: allBorders, alignment: { vertical: "center" } };
      if (alt) st.fill = { fgColor: { rgb: ALT } };
      if (cc === MONTO_C) { st.alignment.horizontal = "right"; if (cell.t === "n") cell.z = "#,##0"; }
      if (cc === 2) st.alignment.horizontal = "center";
      if (cc === 5 && paid !== null) { st.font = { sz: 10, bold: true, color: { rgb: paid ? "15803D" : "B91C1C" } }; st.alignment.horizontal = "center"; }
      if (cc === 3 && paid === null) st.font = { sz: 10, italic: true, color: { rgb: "B45309" } };
      cell.s = st;
    }
  });

  [totalPaidR, totalPendR, countR].forEach(r => {
    const label = ws[ref({ r, c: 3 })];
    const val = ws[ref({ r, c: MONTO_C })];
    if (label) label.s = { font: { bold: true, sz: 10.5, color: { rgb: INK } }, alignment: { horizontal: "right" } };
    if (val) { val.s = { font: { bold: true, sz: 11, color: { rgb: BRAND } }, alignment: { horizontal: "right" } }; if (val.t === "n" && r !== countR) val.z = "#,##0"; }
  });

  ws["!cols"] = [{ wch: 24 }, { wch: 24 }, { wch: 12 }, { wch: 34 }, { wch: 14 }, { wch: 15 }];
  ws["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: NCOL - 1 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: NCOL - 1 } },
    { s: { r: 2, c: 0 }, e: { r: 2, c: NCOL - 1 } },
  ];
  ws["!rows"] = [{ hpt: 26 }];
  ws["!freeze"] = { xSplit: 0, ySplit: DATA_R, topLeftCell: ref({ r: DATA_R, c: 0 }), activePane: "bottomLeft", state: "frozen" };

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Pagos Empresas");
  XLSX.writeFile(wb, `Keynes_Pagos_Empresas_${new Date().toISOString().slice(0, 10)}.xlsx`);
  toast("Registro de pagos de empresas exportado a Excel (.xlsx).");
}

// Modal de opciones para exportar: se adapta al tab actual (alumnos o empresas)
function modalExportPagos() {
  const scope = state.pagosTab === "empresas" ? "empresas" : "alumnos";

  // Años y meses realmente presentes en los pagos del ámbito
  const yearsSet = new Set(), monthsSet = new Set();
  const collect = p => {
    const y = (p.date || "").slice(0, 4); if (y) yearsSet.add(y);
    const m = (p.date || "").slice(5, 7); if (m) monthsSet.add(m);
  };
  if (scope === "empresas") COMPANIES.forEach(c => (c.pagosEmpresa || []).forEach(collect));
  else STUDENTS.forEach(s => effectivePayments(s).forEach(collect));

  const years = [...yearsSet].sort().reverse();
  const yearChecks = years.length
    ? years.map(y => `<label class="chk-pill"><input type="checkbox" class="exp-year" value="${y}"> ${y}</label>`).join("")
    : `<span style="font-size:12.5px;color:var(--ink-3)">No hay pagos registrados aún.</span>`;
  const usedMonths = MESES_PDF.filter(([v]) => monthsSet.has(v));
  const monthChecks = usedMonths.length
    ? usedMonths.map(([v, l]) => `<label class="chk-pill"><input type="checkbox" class="exp-month" value="${v}"> ${l}</label>`).join("")
    : `<span style="font-size:12.5px;color:var(--ink-3)">No hay pagos registrados aún.</span>`;

  const studentChecks = STUDENTS.slice()
    .sort((a, b) => (a.name + " " + a.surname).localeCompare(b.name + " " + b.surname))
    .map(s => {
      const emp = s.empresaId ? getCompany(s.empresaId) : null;
      const badge = emp ? ` <span class="emp-badge">🏢 ${esc(emp.name)}</span>` : "";
      return `<label class="chk-pill${emp ? " has-emp" : ""}"><input type="checkbox" class="exp-student" value="${s.id}"> ${esc(s.name)} ${esc(s.surname)}${badge}</label>`;
    }).join("");

  const companyChecks = COMPANIES.slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(c => `<label class="chk-pill"><input type="checkbox" class="exp-company" value="${c.id}"> ${esc(c.name)}</label>`).join("");

  const alumnosBlock = `
    <div class="field" style="margin-top:14px">
      <label>¿Qué alumnos incluir?</label>
      <div style="display:flex;flex-direction:column;gap:8px;margin-top:4px">
        <label class="radio-row"><input type="radio" name="studentFilter" value="todos" checked> Todos los alumnos</label>
        <label class="radio-row"><input type="radio" name="studentFilter" value="pendiente"> Solo con pago pendiente</label>
        <label class="radio-row"><input type="radio" name="studentFilter" value="alDia"> Solo sin pendientes (al día)</label>
        <label class="radio-row"><input type="radio" name="studentFilter" value="especificos"> Alumnos específicos</label>
      </div>
      <div id="expStudentList" style="display:none;margin-top:10px">
        <input type="text" id="expStudSearch" placeholder="Buscar alumno…" autocomplete="off" style="width:100%;margin-bottom:8px">
        <div style="display:flex;gap:10px;margin-bottom:8px">
          <button type="button" class="btn btn-ghost btn-sm" id="expStudSelAll">Seleccionar todos</button>
          <button type="button" class="btn btn-ghost btn-sm" id="expStudNone">Ninguno</button>
        </div>
        <div class="chk-pill-row" id="expStudPills" style="max-height:180px;overflow-y:auto">${studentChecks || '<span style="font-size:12.5px;color:var(--ink-3)">No hay alumnos.</span>'}</div>
      </div>
      <label class="check-field" style="display:flex;align-items:center;gap:8px;margin-top:12px;font-size:13.5px;color:var(--ink-1);cursor:pointer">
        <input type="checkbox" id="expExcludeEmpresa"> Excluir alumnos que pertenecen a empresas
      </label>
    </div>`;

  const empresasBlock = `
    <div class="field" style="margin-top:14px">
      <label>¿Qué empresas incluir?</label>
      <div style="display:flex;flex-direction:column;gap:8px;margin-top:4px">
        <label class="radio-row"><input type="radio" name="companyFilter" value="todas" checked> Todas las empresas</label>
        <label class="radio-row"><input type="radio" name="companyFilter" value="especificas"> Empresas específicas</label>
      </div>
      <div id="expCompanyList" style="display:none;margin-top:10px">
        <input type="text" id="expCompSearch" placeholder="Buscar empresa…" autocomplete="off" style="width:100%;margin-bottom:8px">
        <div style="display:flex;gap:10px;margin-bottom:8px">
          <button type="button" class="btn btn-ghost btn-sm" id="expCompSelAll">Seleccionar todas</button>
          <button type="button" class="btn btn-ghost btn-sm" id="expCompNone">Ninguna</button>
        </div>
        <div class="chk-pill-row" id="expCompPills" style="max-height:180px;overflow-y:auto">${companyChecks || '<span style="font-size:12.5px;color:var(--ink-3)">No hay empresas.</span>'}</div>
      </div>
    </div>`;

  openModal(`
  <div class="modal-head">
    <h3>Descargar pagos de ${scope === "empresas" ? "empresas" : "alumnos"}</h3>
    <button class="modal-close" data-modal-close>&times;</button>
  </div>
  <form id="exportPagosForm" data-scope="${scope}">
    <div class="field">
      <label>Formato</label>
      <div class="fmt-toggle">
        <label class="fmt-opt">
          <input type="radio" name="expFormato" value="pdf" checked>
          <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>PDF</span>
        </label>
        <label class="fmt-opt">
          <input type="radio" name="expFormato" value="xlsx">
          <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/></svg>Excel (.xlsx)</span>
        </label>
      </div>
    </div>
    ${scope === "empresas" ? empresasBlock : alumnosBlock}
    <div class="field" style="margin-top:14px">
      <label>Año(s) <span class="optional">(vacío = todos)</span></label>
      <div class="chk-pill-row">${yearChecks}</div>
    </div>
    <div class="field" style="margin-top:12px">
      <label>Mes(es) <span class="optional">(vacío = todos)</span></label>
      <div class="chk-pill-row">${monthChecks}</div>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" data-modal-close>Cancelar</button>
      <button type="submit" class="btn btn-primary">Descargar</button>
    </div>
  </form>`);

  // Wiring genérico para una lista específica con búsqueda (alumnos o empresas)
  const wireSpecificList = (radioName, especValue, listId, pillsId, searchId, cbClass, selAllId, noneId) => {
    const listEl = document.getElementById(listId);
    modalBox.querySelectorAll(`input[name="${radioName}"]`).forEach(r => r.addEventListener("change", () => {
      const on = modalBox.querySelector(`input[name="${radioName}"]:checked`)?.value === especValue;
      if (listEl) listEl.style.display = on ? "" : "none";
    }));
    const visible = () => [...modalBox.querySelectorAll(`#${pillsId} .chk-pill`)].filter(l => l.style.display !== "none");
    document.getElementById(selAllId)?.addEventListener("click", () => visible().forEach(l => { const c = l.querySelector(`.${cbClass}`); if (c) c.checked = true; }));
    document.getElementById(noneId)?.addEventListener("click", () => visible().forEach(l => { const c = l.querySelector(`.${cbClass}`); if (c) c.checked = false; }));
    document.getElementById(searchId)?.addEventListener("input", e => {
      const q = e.target.value.trim().toLowerCase();
      modalBox.querySelectorAll(`#${pillsId} .chk-pill`).forEach(l => {
        l.style.display = !q || l.textContent.trim().toLowerCase().includes(q) ? "" : "none";
      });
    });
  };

  if (scope === "empresas") {
    wireSpecificList("companyFilter", "especificas", "expCompanyList", "expCompPills", "expCompSearch", "exp-company", "expCompSelAll", "expCompNone");
  } else {
    wireSpecificList("studentFilter", "especificos", "expStudentList", "expStudPills", "expStudSearch", "exp-student", "expStudSelAll", "expStudNone");
  }
}

// ====== Vista: Lista ======
function viewLista() {
  const q = state.search.toLowerCase();
  const list = STUDENTS.filter(s => {
    const full = (s.name + " " + s.surname).toLowerCase();
    const matchSearch  = !q || full.includes(q) || s.name.toLowerCase().includes(q) || s.surname.toLowerCase().includes(q);
    const matchCourse  = !state.courseFilter  || s.enrollments.some(e => e.courseId === state.courseFilter);
    const matchDay     = !state.dayFilter     || (s.diasClase || []).includes(state.dayFilter);
    const matchEmpresa = !state.empresaFilter || (
      state.empresaFilter === "__sin__" ? !s.empresaId : s.empresaId === state.empresaFilter
    );
    return matchSearch && matchCourse && matchDay && matchEmpresa;
  });

  const alertMap = {};
  list.forEach(s => { alertMap[s.id] = getStudentAlerts(s); });
  list.sort((a, b) => alertMap[b.id].length - alertMap[a.id].length);

  const courseOptions = COURSES.map(c =>
    `<option value="${c.id}" ${state.courseFilter === c.id ? "selected" : ""}>${esc(c.name)}</option>`
  ).join("");
  const dayOptions = DIAS.map(d =>
    `<option value="${d}" ${state.dayFilter === d ? "selected" : ""}>${d}</option>`
  ).join("");
  const empresaOptions = COMPANIES.map(c =>
    `<option value="${c.id}" ${state.empresaFilter === c.id ? "selected" : ""}>${esc(c.name)}</option>`
  ).join("");

  const rows = list.map(s => {
    const color = colorFor(s.id);
    const ini = initials(s.name, s.surname);
    const tags = s.enrollments.map(e => {
      const c = getCourse(e.courseId);
      return c ? `<span class="course-tag">${esc(c.name)}</span>` : "";
    }).join("");
    const statusBadge = estadoBadge(s);
    const empresa = s.empresaId ? getCompany(s.empresaId) : null;
    const alerts = alertMap[s.id];
    const alertPills = alerts.map(a => {
      const label = a.type === "inactividad" ? `Sin clase hace ${a.days} días`
        : a.type === "sinpago" ? "Sin pago cargado"
        : `Sin pago hace ${a.days} días`;
      return `<span class="alert-pill${(a.type === "pago" || a.type === "sinpago") ? " alert-pill-pago" : ""}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:10px;height:10px;flex-shrink:0"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> ${label}<button class="alert-pill-dismiss" data-dismiss-alert="${s.id}" data-alert-type="${a.type}" data-alert-key="${a.key}" title="Descartar alerta">×</button></span>`;
    }).join("");
    return `
    <div class="t-row${alerts.length ? " has-alert" : ""}" data-open="${s.id}">
      <div class="t-student">
        <div class="t-avatar" style="background:${color}">${ini}</div>
        <div>
          <div class="name">${esc(s.name)} ${esc(s.surname)}${empresa ? ` <span style="font-size:11px;font-weight:500;color:var(--ink-3);background:var(--brand-50);border-radius:4px;padding:1px 6px;margin-left:4px">${esc(empresa.name)}</span>` : ""}</div>
          <div class="mail">${esc(s.phone)}</div>
          ${alerts.length ? `<div style="margin-top:5px;display:flex;flex-wrap:wrap;gap:4px">${alertPills}</div>` : ""}
        </div>
      </div>
      <div class="t-courses">${tags || '<span class="no-course">Sin cursos</span>'} ${statusBadge}</div>
      <div class="t-contact">${esc(s.email || "—")}</div>
      <div class="t-actions">
        <button class="btn-icon" data-open="${s.id}" title="Ver detalle">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
        ${isAdmin() ? `<button class="btn-icon danger" data-delete="${s.id}" title="Eliminar">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
        </button>` : ""}
      </div>
    </div>`;
  }).join("");

  return `
  <div class="page-head">
    <div>
      <h2>Lista de Alumnos</h2>
      <p>Visualizá y gestioná todos los alumnos registrados en Keynes.</p>
    </div>
    ${isAdmin() ? `<button class="btn btn-primary" data-go="registro">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      Nuevo Alumno
    </button>` : ""}
  </div>

  <div class="filter-bar">
    <div class="filter-group">
      <label>Filtrar por curso</label>
      <div class="select-wrap">
        <select id="courseFilterSelect" style="min-width:200px">
          <option value="">Todos los cursos</option>
          ${courseOptions}
        </select>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
    </div>
    <div class="filter-group">
      <label>Filtrar por día</label>
      <div class="select-wrap">
        <select id="dayFilterSelect" style="min-width:160px">
          <option value="">Todos los días</option>
          ${dayOptions}
        </select>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
    </div>
    ${COMPANIES.length ? `<div class="filter-group">
      <label>Filtrar por empresa</label>
      <div class="select-wrap">
        <select id="empresaFilterSelect" style="min-width:180px">
          <option value="">Todas</option>
          <option value="__sin__" ${state.empresaFilter === "__sin__" ? "selected" : ""}>Sin empresa</option>
          ${empresaOptions}
        </select>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
    </div>` : ""}
    <div class="result-count">${list.length} alumno${list.length !== 1 ? "s" : ""}</div>
  </div>

  <div class="table-card">
    <div class="t-head">
      <div>Alumno</div>
      <div>Cursos</div>
      <div>Email</div>
      <div class="right">Acciones</div>
    </div>
    ${list.length ? rows : '<div class="empty">No se encontraron alumnos.</div>'}
  </div>`;
}

// ====== Vista: Detalle ======
function viewDetalle() {
  const s = getStudent(state.currentStudentId);
  if (!s) { go("lista"); return ""; }

  const color = colorFor(s.id);
  const ini = initials(s.name, s.surname);
  const planillaActive = state.currentEnrollIdx === -1;

  const planillaTabBtn = `<button class="course-tab ${planillaActive ? "active" : ""}" data-tab="planilla">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:13px;height:13px;margin-right:4px;vertical-align:-2px"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1" ry="1"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/></svg>
    Planilla
  </button>`;

  const enrollTabs = s.enrollments.map((e, i) => {
    const c = getCourse(e.courseId);
    return `<button class="course-tab ${!planillaActive && i === state.currentEnrollIdx ? "active" : ""}" data-tab="${i}">${esc(c ? c.name : "Curso")}</button>`;
  }).join("");

  let mainContent = "";

  if (planillaActive) {
    const attendance = (s.attendance || []).slice().sort((a, b) => (a.date || '').localeCompare(b.date || ''));

    const totPres = attendance.filter(a => a.present).length;
    const totAus = attendance.filter(a => !a.present).length;
    const totHrs = attendance.reduce((sum, a) => sum + (parseFloat(a.hours) || 0), 0);

    const attendRows = attendance.map((a, idx) => `
      <tr>
        <td>${fmtDate(a.date)}</td>
        <td><span class="attend-badge ${a.present ? 'present' : 'absent'}">${a.present ? 'Presente (P)' : 'Ausente (A)'}</span></td>
        <td>${(a.hours !== undefined && a.hours !== '' && a.hours !== null) ? a.hours + ' hs' : '—'}</td>
        <td style="color:var(--ink-2);font-size:13px">${esc(a.observations || '')}</td>
        <td style="display:flex;gap:4px">
          <button class="btn-icon" data-edit-attend-gen="${s.id}" data-attend-idx="${idx}" title="Editar">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="btn-icon danger" data-del-attend-gen="${s.id}" data-attend-idx="${idx}" title="Eliminar">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </td>
      </tr>`).join("");

    mainContent = `
    <div class="section-card">
      <div class="section-head">
        <h3>Planilla de Asistencia</h3>
        <button class="btn btn-ghost btn-sm" data-add-attend-gen="${s.id}">+ Registrar Asistencia</button>
      </div>
      <div class="attend-summary">
        <div class="attend-stat"><span class="attend-num present-num">${totPres}</span><span class="attend-lbl">Presentes</span></div>
        <div class="attend-stat"><span class="attend-num absent-num">${totAus}</span><span class="attend-lbl">Ausentes</span></div>
        <div class="attend-stat"><span class="attend-num">${totHrs}</span><span class="attend-lbl">Total horas</span></div>
      </div>
      ${attendance.length ? `
      <div class="class-table-wrap">
        <table class="class-table">
          <thead><tr><th>Fecha</th><th>Estado</th><th>Horas</th><th></th><th></th></tr></thead>
          <tbody>${attendRows}</tbody>
        </table>
      </div>` : '<div class="empty-sm">No hay registros de asistencia. Se agregan automáticamente al registrar una clase, o usá "+ Registrar Asistencia".</div>'}
    </div>` + (isAdmin() ? renderPaySection(s) : "");

  } else {
    // --- Course tab content ---
    const enr = s.enrollments[state.currentEnrollIdx];
    if (!enr) { state.currentEnrollIdx = -1; return viewDetalle(); }
    const course = getCourse(enr.courseId);

    // Enrollment info bar
    const enrInfo = `
    <div class="enr-info">
      <div class="enr-stat">
        <div class="k">Curso</div>
        <div class="val enr-date-row">
          ${esc(course ? course.name : "—")}
          <button class="btn-icon" data-edit-enr-course="${enr.enrollId}" title="Cambiar curso" style="margin-left:6px;vertical-align:middle"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
        </div>
      </div>
      <div class="enr-stat">
        <div class="k">Inicio</div>
        <div class="val enr-date-row">
          ${fmtDate(enr.startDate)}
          <button class="btn-icon" data-edit-enr-dates="${enr.enrollId}" title="Editar fechas del curso" style="margin-left:6px;vertical-align:middle">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
        </div>
      </div>
      <div class="enr-stat"><div class="k">Fin estimado</div><div class="val">${fmtDate(enr.estimatedEnd)}</div></div>
      <div class="enr-stat">
        <div class="k">Tutor(es)</div>
        <div class="val enr-date-row">
          ${esc(enr.tutors.join(", ") || "—")}
          <button class="btn-icon" data-edit-enr-tutors="${enr.enrollId}" title="Editar tutores" style="margin-left:6px;vertical-align:middle">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
        </div>
      </div>
      <div class="enr-stat"><div class="k">Clases dadas</div><div class="val">${enr.classes.length}</div></div>
    </div>`;

    // Completion section
    const completionSection = `
    <div class="section-card completion-section">
      <div class="section-head">
        <h3>Estado del Curso</h3>
        ${enr.completed ? '<span class="status-badge status-done" style="font-size:13px;padding:6px 16px">✓ Finalizado</span>' : ''}
      </div>
      ${enr.completed
        ? `<p style="font-size:13.5px;color:var(--ink-2);margin-bottom:14px">El alumno ha finalizado este curso.</p>
           <button class="btn btn-ghost btn-sm" data-unmark-complete="${enr.enrollId}">Desmarcar Finalización</button>`
        : `<p style="font-size:13.5px;color:var(--ink-2);margin-bottom:14px">Marcá el curso como finalizado cuando el alumno haya completado todos los requisitos.</p>
           <button class="btn btn-primary btn-sm" data-mark-complete="${enr.enrollId}">Marcar como Finalizado</button>`
      }
    </div>`;

    // Class section
    let classSection = "";
    if (course && course.topics.length > 0) {
      const classMap = {};
      enr.classes.forEach(cl => { classMap[cl.topic] = cl; });
      const topicRows = course.topics.map(topic => {
        const cl = classMap[topic];
        if (cl) {
          const clIdx = enr.classes.indexOf(cl);
          return `
          <tr class="cl-done">
            <td>${fmtDate(cl.date)}${cl.startTime ? `<br><span class="cl-time">${cl.startTime}${cl.endTime ? " – " + cl.endTime : ""}</span>` : ""}</td>
            <td>${esc(topic)}${cl.modality ? `<br><span class="cl-modality">${esc(cl.modality)}</span>` : ""}</td>
            <td>${esc(cl.professor)}</td>
            <td>${esc(cl.observations || "—")}</td>
            <td style="display:flex;gap:4px">
              <button class="btn-icon" data-edit-class="${enr.enrollId}" data-class-idx="${clIdx}" title="Editar clase">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              </button>
              <button class="btn-icon danger" data-del-class="${enr.enrollId}" data-class-idx="${clIdx}" title="Eliminar clase">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </td>
          </tr>`;
        }
        return `
          <tr class="cl-pending">
            <td>—</td>
            <td>${esc(topic)}</td>
            <td>—</td>
            <td>—</td>
            <td><button class="btn-outline" data-add-class="${enr.enrollId}" data-topic="${esc(topic)}">Registrar</button></td>
          </tr>`;
      }).join("");
      // Clases cargadas manualmente (tema fuera de la lista predefinida)
      const extraRows = course.allowManual
        ? enr.classes.map((cl, idx) => ({ cl, idx })).filter(({ cl }) => !course.topics.includes(cl.topic)).map(({ cl, idx }) => `
          <tr>
            <td>${fmtDate(cl.date)}${cl.startTime ? `<br><span class="cl-time">${cl.startTime}${cl.endTime ? " – " + cl.endTime : ""}</span>` : ""}</td>
            <td>${renderTopicHtml(cl.topic)}${cl.modality ? `<br><span class="cl-modality">${esc(cl.modality)}</span>` : ""} <span class="cl-manual-tag">manual</span></td>
            <td>${esc(cl.professor)}</td>
            <td>${esc(cl.observations || "—")}</td>
            <td style="display:flex;gap:4px">
              <button class="btn-icon" data-edit-class="${enr.enrollId}" data-class-idx="${idx}" title="Editar clase">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              </button>
              <button class="btn-icon danger" data-del-class="${enr.enrollId}" data-class-idx="${idx}" title="Eliminar clase">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </td>
          </tr>`).join("")
        : "";
      classSection = `
      <div class="section-card">
        <div class="section-head">
          <h3>Clases del Curso</h3>
          <div style="display:flex;align-items:center;gap:10px">
            <span class="done-count">${enr.classes.length} / ${course.topics.length} clases dadas</span>
            ${course.allowManual ? `<button class="btn btn-ghost btn-sm" data-add-class="${enr.enrollId}" data-topic="">+ Clase manual</button>` : ""}
          </div>
        </div>
        <div class="class-table-wrap">
          <table class="class-table">
            <thead><tr><th>Fecha</th><th>Desarrollo Temático</th><th>Profesor</th><th>Observaciones</th><th></th></tr></thead>
            <tbody>${topicRows}${extraRows}</tbody>
          </table>
        </div>
      </div>`;
    } else {
      const manualRows = enr.classes.map((cl, idx) => {
        const hw = cl.homework;
        const hwRow = hw ? `
        <tr class="hw-row">
          <td>${fmtDate(cl.date)}</td>
          <td><span class="hw-label">HW:</span> <span class="hw-task-sub${hw.done ? " done" : ""}">${esc(hw.task)}</span> <button class="hw-done-toggle${hw.done ? " hw-done" : ""}" data-toggle-hw-done="${enr.enrollId}" data-class-idx="${idx}">${hw.done ? "Hecho" : "Pendiente"}</button></td>
          <td></td><td></td>
          <td style="display:flex;gap:4px">
            <button class="btn-icon" data-edit-hw="${enr.enrollId}" data-class-idx="${idx}" title="Editar homework">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="btn-icon danger" data-del-hw="${enr.enrollId}" data-class-idx="${idx}" title="Eliminar homework">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </td>
        </tr>` : "";
        return `
        <tr>
          <td>${fmtDate(cl.date)}${cl.startTime ? `<br><span class="cl-time">${cl.startTime}${cl.endTime ? " – " + cl.endTime : ""}</span>` : ""}</td>
          <td>${renderTopicHtml(cl.topic)}${cl.modality ? `<br><span class="cl-modality">${esc(cl.modality)}</span>` : ""}</td>
          <td>${esc(cl.professor)}</td>
          <td>${esc(cl.observations || "—")}</td>
          <td style="display:flex;gap:4px">
            <button class="btn-icon" data-edit-class="${enr.enrollId}" data-class-idx="${idx}" title="Editar">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="btn-icon danger" data-del-class="${enr.enrollId}" data-class-idx="${idx}" title="Eliminar">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </td>
        </tr>${hwRow}`;
      }).join("");
      classSection = `
      <div class="section-card">
        <div class="section-head">
          <h3>Clases Registradas</h3>
          <button class="btn btn-ghost btn-sm" data-add-class="${enr.enrollId}" data-topic="">+ Agregar Clase</button>
        </div>
        <div class="class-table-wrap">
          ${enr.classes.length ? `
          <table class="class-table">
            <thead><tr><th>Fecha</th><th>Desarrollo Temático</th><th>Profesor</th><th>Observaciones</th><th></th></tr></thead>
            <tbody>${manualRows}</tbody>
          </table>` : '<div class="empty-sm">No hay clases registradas aún.</div>'}
        </div>
      </div>`;
    }

    const notesSection = (course && course.notes) ? `
      <div class="section-card course-notes-card">
        <div class="section-head"><h3>Notas y materiales del curso</h3></div>
        <p class="course-notes-text">${escBr(course.notes)}</p>
      </div>` : "";

    mainContent = enrInfo + completionSection + notesSection + classSection;
  }

  return `
  <div class="crumbs"><a href="#" data-go="lista">← Lista de Alumnos</a> › <b>${esc(s.name)} ${esc(s.surname)}</b></div>

  <div class="profile-hero">
    <div class="profile-avatar" style="background:${color}">${ini}</div>
    <div class="profile-info">
      <h2>${esc(s.name)} ${esc(s.surname)}
        <span class="estado-select-wrap">
          <select class="estado-select ${estadoClass(s.estado)}" data-estado-select="${s.id}" title="Cambiar estado del alumno">
            ${ESTADOS.map(e => `<option value="${e}" ${(s.estado || "activo") === e ? "selected" : ""}>${estadoLabel(e)}</option>`).join("")}
          </select>
        </span>
      </h2>
      <div class="profile-meta">
        ${s.modality ? `<span class="modality-badge modality-${s.modality}">${s.modality === "presencial" ? "Presencial" : "Virtual"}</span>` : ""}
        <span>${esc(s.phone)}</span>
        ${s.email ? `<span>${esc(s.email)}</span>` : ""}
        ${s.contact2Name ? `<span>Contacto: ${s.contact2Name}${s.contact2Relation ? " (" + s.contact2Relation + ")" : ""} — ${s.contact2Phone}</span>` : ""}
        ${s.diasClase?.length ? `<span>Días: <b>${s.diasClase.join(" · ")}</b></span>` : ""}
        ${s.horario ? `<span>Horario: <b>${esc(s.horario)}</b></span>` : ""}
        ${s.empresaId && getCompany(s.empresaId) ? `<span>Empresa: <b>${esc(getCompany(s.empresaId).name)}</b></span>` : ""}
      </div>
      ${s.caracteristicas ? `<div class="student-caracteristicas">${escBr(s.caracteristicas)}</div>` : ""}
    </div>
    <div class="profile-btns">
      <button class="btn btn-ghost btn-sm" data-download-pdf="${s.id}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Descargar PDF
      </button>
      <button class="btn btn-ghost btn-sm" data-informe-student="${s.id}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        Copiar Informe
      </button>
      <button class="btn btn-ghost btn-sm" data-certificado="${s.id}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="6"/><path d="M15.477 12.89 17 22l-5-3-5 3 1.523-9.11"/></svg>
        Certificado
      </button>
      ${isAdmin() ? `<button class="btn btn-ghost btn-sm" data-edit-student="${s.id}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        Editar
      </button>
      <button class="btn btn-danger btn-sm" data-delete="${s.id}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
        Eliminar
      </button>` : ""}
    </div>
  </div>

  <div class="course-tabs">
    ${planillaTabBtn}
    ${enrollTabs}
    <button class="course-tab add-tab" data-add-enrollment="${s.id}">+ Agregar Curso</button>
  </div>

  ${mainContent}`;
}

// ====== Vista: Registro ======
function enrollmentBlock(idx) {
  const opts = COURSES.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
  return `
  <div class="enrollment-block" data-enr="${idx}">
    <div class="enr-header">
      <span class="enr-num">Curso ${idx + 1}</span>
      ${idx > 0 ? `<button type="button" class="btn-icon danger" data-remove-enr title="Quitar">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>` : ""}
    </div>
    <div class="grid-2">
      <div class="field"><label>Curso *</label>
        <div class="select-wrap">
          <select name="enr_course_${idx}" required>
            <option value="">— Seleccionar —</option>${opts}
          </select>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
      </div>
      <div class="field"><label>Tutor(es)</label><input name="enr_tutors_${idx}" placeholder="Ej. Carlos R., María L."></div>
      <div class="field"><label>Fecha de inicio</label><input type="date" name="enr_start_${idx}"></div>
      <div class="field"><label>Fecha fin estimada</label><input type="date" name="enr_end_${idx}"></div>
    </div>
  </div>`;
}

function viewRegistro() {
  return `
  <div class="page-head">
    <div>
      <h2>Registrar Nuevo Alumno</h2>
      <p>Completá los datos del alumno y sus cursos.</p>
    </div>
  </div>
  <form id="regForm">
    <div class="form-section">
      <h3>Datos Personales</h3>
      <div class="grid-2">
        <div class="field"><label>Nombre *</label><input name="nombre" required placeholder="Ej. Sofía"></div>
        <div class="field"><label>Apellido *</label><input name="apellido" required placeholder="Ej. Martínez"></div>
        <div class="field"><label>Teléfono</label><input name="telefono" placeholder="+595 9xx xxx xxx"></div>
        <div class="field"><label>Correo electrónico</label><input type="email" name="email" placeholder="ejemplo@correo.com"></div>
        <div class="field"><label>Modalidad</label>
          <div class="select-wrap">
            <select name="modalidad">
              <option value="">— Seleccionar —</option>
              <option value="presencial">Presencial</option>
              <option value="virtual">Virtual</option>
            </select>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
          </div>
        </div>
      </div>
      <div class="field" style="margin-top:14px">
        <label>Días de clase</label>
        <div style="display:flex;flex-wrap:wrap;gap:8px 20px;margin-top:6px">
          ${DIAS.map(d => `<label style="display:flex;align-items:center;gap:5px;font-size:13.5px;cursor:pointer;font-weight:400"><input type="checkbox" name="diasClase" value="${d}"> ${d}</label>`).join("")}
        </div>
      </div>
      <div class="field" style="margin-top:14px">
        <label>Horario</label>
        <input name="horario" placeholder="Ej. 14:00 - 16:00">
      </div>
      ${COMPANIES.length ? `<div class="field" style="margin-top:14px">
        <label>Empresa <span class="optional">(opcional)</span></label>
        <div class="select-wrap">
          <select name="empresaId">
            <option value="">— Sin empresa —</option>
            ${COMPANIES.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}
          </select>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
      </div>` : ""}
      <div class="field" style="margin-top:14px">
        <label>Características del alumno <span class="optional">(opcional)</span></label>
        <textarea name="caracteristicas" rows="3" placeholder="Ej. Aprende rápido, dificultad con fórmulas, prefiere ejemplos prácticos…" style="width:100%;padding:11px 14px;border:1px solid var(--line);border-radius:10px;font-size:14px;font-family:inherit;resize:vertical"></textarea>
      </div>
    </div>

    <div class="form-section">
      <h3>Contacto Adicional <span class="optional">(opcional)</span></h3>
      <div class="grid-2">
        <div class="field"><label>Nombre</label><input name="c2nombre" placeholder="Nombre completo"></div>
        <div class="field"><label>Parentesco</label>
          <div class="select-wrap">
            <select name="c2parentesco">
              <option value="">— Seleccionar —</option>
              <option>Madre</option><option>Padre</option><option>Hermano/a</option><option>Tutor legal</option><option>Otro</option>
            </select>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
          </div>
        </div>
        <div class="field"><label>Teléfono</label><input name="c2telefono" placeholder="+595 9xx xxx xxx"></div>
      </div>
    </div>

    <div class="form-section">
      <h3>Pago <span class="optional">(único para todos los cursos)</span></h3>
      <div class="grid-2">
        <div class="field"><label>Modalidad de pago</label>
          <div class="select-wrap">
            <select name="paytype">
              <option value="mensual">Mensual</option>
              <option value="por clase">Por clase</option>
              <option value="curso completo">Curso completo</option>
              <option value="paquete">Paquete de horas</option>
            </select>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
          </div>
        </div>
        <div class="field"><label>Monto / Cuota (₲)</label><input type="number" name="amount" placeholder="Ej. 600000" min="0"></div>
        <div class="field"><label>Hs/semana <span class="optional">(paquete)</span></label><input type="number" name="packageHours" placeholder="Ej. 6" min="0"></div>
      </div>
    </div>

    <div class="form-section">
      <h3>Cursos</h3>
      <div id="enrollmentsList"></div>
      <button type="button" class="btn btn-ghost" id="addEnrollmentBtn">+ Agregar otro curso</button>
    </div>

    <div class="form-actions">
      <button type="button" class="btn btn-ghost" data-go="lista">Cancelar</button>
      <button type="submit" class="btn btn-primary">Guardar Alumno</button>
    </div>
  </form>`;
}

// ====== Vista: Cursos ======
function viewCursos() {
  const cards = COURSES.map(c => {
    const count = STUDENTS.filter(s => s.enrollments.some(e => e.courseId === c.id)).length;
    const previewTopics = c.topics.slice(0, 4).map(t => `<li>${esc(t)}</li>`).join("");
    const more = c.topics.length > 4 ? `<li class="more">+ ${c.topics.length - 4} temas más…</li>` : "";
    return `
    <div class="course-card">
      <div class="course-card-head">
        <div class="course-card-name">${esc(c.name)}</div>
        <div class="course-card-count">${count} alumno${count !== 1 ? "s" : ""}</div>
      </div>
      <div class="course-topics-label">${c.topics.length > 0 ? `${c.topics.length} temas predefinidos` : "Sin temas predefinidos — ingreso manual por clase"}${c.hasHomework ? ' · <span style="color:var(--amber-tx);font-weight:600">Homework activado</span>' : ''}</div>
      ${c.topics.length > 0 ? `<ul class="topic-list">${previewTopics}${more}</ul>` : ""}
      <div class="course-card-actions">
        <button class="btn btn-ghost btn-sm" data-view-course="${c.id}">${isAdmin() ? "Ver / Editar temas" : "Ver temas"}</button>
        ${isAdmin() ? `<button class="btn-icon danger" data-delete-course="${c.id}" title="Eliminar curso">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
        </button>` : ""}
      </div>
    </div>`;
  }).join("");

  return `
  <div class="page-head">
    <div>
      <h2>Gestión de Cursos</h2>
      <p>Administrá los cursos disponibles y sus temas predefinidos.</p>
    </div>
    ${isAdmin() ? `<button class="btn btn-primary" data-new-course>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      Nuevo Curso
    </button>` : ""}
  </div>
  <div class="courses-grid">${cards}</div>`;
}

// ====== Vista: Empresas ======
function viewEmpresas() {
  const q = state.empresaSearch.trim().toLowerCase();
  const filtered = q
    ? COMPANIES.filter(c => [c.name, c.ruc, c.email, c.contactName].some(v => (v || "").toLowerCase().includes(q)))
    : COMPANIES;
  const cards = filtered.map(c => {
    const count = STUDENTS.filter(s => s.empresaId === c.id).length;
    const info = [c.ruc ? `RUC: ${esc(c.ruc)}` : "", esc(c.phone), esc(c.email), esc(c.address)].filter(Boolean).join(" · ");
    return `
    <div class="course-card">
      <div class="course-card-head">
        <div class="course-card-name">${esc(c.name)}</div>
        <div class="course-card-count">${count} alumno${count !== 1 ? "s" : ""}</div>
      </div>
      <div class="course-topics-label">${info || "Sin datos adicionales"}</div>
      ${c.modality ? `<div style="margin-top:4px"><span class="modality-badge modality-${c.modality}">${c.modality === "presencial" ? "Presencial" : "Virtual"}</span></div>` : ""}
      ${c.horario ? `<div style="font-size:12px;color:var(--ink-3);margin-top:4px">Horario: ${esc(c.horario)}</div>` : ""}
      ${c.diasClase?.length ? `<div style="font-size:12px;color:var(--ink-3);margin-top:2px">Días: ${c.diasClase.join(" · ")}</div>` : ""}
      ${c.contactName ? `<div style="font-size:12px;color:var(--ink-3);margin-top:6px;padding-top:6px;border-top:1px solid var(--line)">Contacto: <b>${esc(c.contactName)}</b>${c.contactRole ? ` (${esc(c.contactRole)})` : ""}${c.contactPhone ? ` — ${esc(c.contactPhone)}` : ""}</div>` : ""}
      <div class="course-card-actions">
        <button class="btn btn-primary btn-sm" data-view-empresa-detail="${c.id}">Ver / Gestionar</button>
        ${isAdmin() ? `<button class="btn btn-ghost btn-sm" data-edit-empresa="${c.id}">Editar</button>
        <button class="btn-icon danger" data-delete-empresa="${c.id}" title="Eliminar empresa">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
        </button>` : ""}
      </div>
    </div>`;
  }).join("");

  return `
  <div class="page-head">
    <div>
      <h2>Empresas</h2>
      <p>Administrá las empresas que contratan el servicio.</p>
    </div>
    ${isAdmin() ? `<button class="btn btn-primary" data-new-empresa>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      Nueva Empresa
    </button>` : ""}
  </div>
  <div style="margin-bottom:16px">
    <input id="empresaSearchInput" placeholder="Buscar empresa por nombre, RUC, correo o contacto…" value="${state.empresaSearch.replace(/"/g, "&quot;")}" style="width:100%;max-width:420px;padding:9px 12px;border:1px solid var(--line);border-radius:10px;font-size:14px;font-family:inherit;background:var(--surface);color:var(--ink)">
  </div>
  <div class="courses-grid">${cards || `<div class="empty" style="padding:40px;text-align:center;color:var(--ink-3)">${q ? "No hay empresas que coincidan con la búsqueda." : "No hay empresas registradas."}</div>`}</div>`;
}

function _empresaFormFields(c = {}) {
  return `
    <div class="field"><label>Nombre de la empresa *</label><input name="nombre" required placeholder="Ej. Grupo Empresarial SA" value="${esc(c.name || "")}"></div>
    <div class="grid-2">
      <div class="field"><label>RUC / NIT</label><input name="ruc" placeholder="80012345-6" value="${esc(c.ruc || "")}"></div>
      <div class="field"><label>Teléfono</label><input name="telefono" placeholder="+595 21 xxx xxx" value="${esc(c.phone || "")}"></div>
    </div>
    <div class="grid-2">
      <div class="field"><label>Correo electrónico</label><input type="email" name="email" placeholder="empresa@correo.com" value="${esc(c.email || "")}"></div>
      <div class="field"><label>Dirección</label><input name="direccion" placeholder="Av. Principal 123" value="${esc(c.address || "")}"></div>
    </div>
    <div class="field"><label>Modalidad</label>
      <div class="select-wrap">
        <select name="modalidad">
          <option value="" ${!c.modality ? "selected" : ""}>— Seleccionar —</option>
          <option value="presencial" ${c.modality === "presencial" ? "selected" : ""}>Presencial</option>
          <option value="virtual"    ${c.modality === "virtual"    ? "selected" : ""}>Virtual</option>
        </select>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
    </div>
    <div class="field">
      <label>Días de clase</label>
      <div style="display:flex;flex-wrap:wrap;gap:8px 20px;margin-top:6px">
        ${DIAS.map(d => `<label style="display:flex;align-items:center;gap:5px;font-size:13.5px;cursor:pointer;font-weight:400"><input type="checkbox" name="diasClase" value="${d}" ${(c.diasClase||[]).includes(d) ? "checked" : ""}> ${d}</label>`).join("")}
      </div>
    </div>
    <div class="field"><label>Horario</label><input name="horario" placeholder="Ej. 14:00 - 16:00" value="${esc(c.horario || "")}"></div>
    <div style="margin-top:6px;margin-bottom:14px;padding-top:14px;border-top:1px solid var(--line);font-size:13px;font-weight:700;color:var(--ink-3)">PERSONA DE CONTACTO <span style="font-weight:400">(opcional)</span></div>
    <div class="grid-2">
      <div class="field"><label>Nombre</label><input name="contactNombre" placeholder="Nombre completo" value="${esc(c.contactName || "")}"></div>
      <div class="field"><label>Cargo</label><input name="contactCargo" placeholder="Ej. RRHH, Gerente" value="${esc(c.contactRole || "")}"></div>
      <div class="field"><label>Teléfono de contacto</label><input name="contactTelefono" placeholder="+595 9xx xxx xxx" value="${esc(c.contactPhone || "")}"></div>
    </div>`;
}

function modalAgregarEmpresa() {
  openModal(`
  <div class="modal-head">
    <h3>Nueva Empresa</h3>
    <button class="modal-close" data-modal-close>&times;</button>
  </div>
  <form id="addEmpresaForm">
    ${_empresaFormFields()}
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" data-modal-close>Cancelar</button>
      <button type="submit" class="btn btn-primary">Guardar Empresa</button>
    </div>
  </form>`);
}

function modalEditarEmpresa(empresaId) {
  const c = getCompany(empresaId);
  if (!c) return;
  openModal(`
  <div class="modal-head">
    <h3>Editar Empresa</h3>
    <button class="modal-close" data-modal-close>&times;</button>
  </div>
  <form id="editEmpresaForm" data-empresa="${empresaId}">
    ${_empresaFormFields(c)}
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" data-modal-close>Cancelar</button>
      <button type="submit" class="btn btn-primary">Guardar Cambios</button>
    </div>
  </form>`);
}

// ====== Vista: Soporte ======
// ── Contenido del tutorial (una sola fuente para HTML y PDF) ──
// adminOnly: la sección solo se muestra/exporta para administradores.
function tutorialSections() {
  return [
    { title: "Primeros pasos y navegación", intro: "Descripción general del acceso al sistema y de la estructura de navegación.", steps: [
      "El acceso se realiza con usuario y contraseña. Si la cuenta tiene activada la verificación en dos pasos, el sistema solicitará además un código de seis dígitos.",
      "El menú lateral izquierdo concentra la navegación principal: Panel de Control, Lista de Alumnos, Registrar Alumno, Gestionar Cursos, Empresas y Soporte.",
      "En la esquina superior derecha se encuentran el selector de tema (claro u oscuro), el acceso a los ajustes del perfil y la opción de cerrar sesión.",
      "La sesión permanece iniciada de forma segura hasta que el usuario cierre sesión manualmente.",
    ] },

    { title: "Panel de Control", intro: "Vista de resumen con los indicadores generales del sistema.", steps: [
      "Presenta los totales principales: cantidad de alumnos, cursos activos y empresas registradas.",
      "Los administradores disponen además de gráficos financieros: ingresos por mes, por curso y por empresa.",
      "El selector de rango (seis meses, doce meses o histórico completo) ajusta el gráfico de ingresos.",
      "El panel puede exportarse como documento interactivo (HTML) o en PDF con el mismo formato.",
    ] },

    { title: "Lista de Alumnos", intro: "Herramientas de búsqueda, filtrado y acceso a los perfiles.", steps: [
      "La barra superior permite buscar por nombre o apellido.",
      "Los selectores permiten filtrar por curso, día de clase o empresa.",
      "Cada fila indica el estado del alumno (Activo, Pausado o Finalizado) y las alertas correspondientes, si las hubiera.",
      "Al hacer clic sobre la fila, o sobre el ícono de vista, se abre el perfil completo del alumno.",
      "El ícono de eliminación borra al alumno previa confirmación.",
    ] },

    { title: "Registrar un alumno", intro: "Procedimiento de alta de un alumno nuevo.", steps: [
      "Se inicia con la opción «Nuevo Alumno», disponible en la lista o en el menú lateral.",
      "Los datos obligatorios son nombre, apellido y teléfono. El correo electrónico y los contactos adicionales son opcionales y resultan útiles para registrar a padres o tutores.",
      "Se asignan los días de clase, el horario y, cuando corresponda, la empresa a la que pertenece el alumno.",
      "El alumno puede inscribirse en uno o más cursos mediante la opción «Agregar otro curso», indicando la fecha de inicio y la fecha estimada de culminación.",
      "Debe definirse la modalidad de pago: mensual, por clase o por paquete de horas.",
    ] },

    { title: "Perfil del alumno y registro de clases", intro: "Registro del avance académico en cada curso.", steps: [
      "El perfil organiza la información en pestañas por curso.",
      "La opción «Agregar Curso» permite inscribir al alumno en un curso adicional desde su propio perfil.",
      "En los cursos con temario predefinido se muestra la lista completa con el estado de cada tema (pendiente o completado); la opción «Registrar» permite cargar la clase correspondiente.",
      "En los cursos sin temario predefinido, la opción «Agregar Clase» permite ingresar el tema manualmente.",
      "Cada clase admite el registro de fecha, horario, profesor, observaciones y tarea asignada, cuando el curso lo contemple.",
    ] },

    { title: "Control de asistencia", intro: "Registro de presentes, ausentes y carga horaria.", steps: [
      "La asistencia puede registrarse de forma general o por curso, según corresponda.",
      "En cada registro se indica la condición (presente o ausente), la cantidad de horas y, opcionalmente, una observación.",
      "El sistema calcula automáticamente el total de presentes, ausentes y horas acumuladas.",
    ] },

    { title: "Generación de informes", intro: "Elaboración del texto del informe para su envío.", steps: [
      "La opción «Copiar Informe», disponible en el perfil, ofrece dos formatos mediante un selector: Básico y Avanzado.",
      "El formato Básico genera el informe a partir de las clases registradas en una fecha determinada.",
      "El formato Avanzado completa automáticamente el profesor, los cursos, el horario, el desarrollo y la siguiente clase a partir de la información cargada; todos los campos permanecen editables.",
      "La acción de copiar deja el informe en el portapapeles, listo para pegarse en cualquier medio de comunicación.",
    ] },

    { title: "Descarga del informe en PDF", intro: "Generación del informe formal del alumno.", steps: [
      "La opción «Descargar PDF» se encuentra en el perfil del alumno.",
      "Permite seleccionar los cursos a incluir y las secciones deseadas: características, asistencia y, en el caso de los administradores, pagos.",
      "El documento incorpora los datos del alumno, la tabla de clases con el formato institucional y el resumen seleccionado.",
    ] },

    { title: "Gestión de cursos", intro: "Creación y mantenimiento de los cursos.", steps: [
      "La sección «Gestionar Cursos» muestra la totalidad de los cursos del sistema.",
      "La opción «Nuevo Curso» permite crear un curso; el temario puede pegarse (un tema por línea) o dejarse vacío para su ingreso manual posterior.",
      "Puede habilitarse la asignación de tareas por clase mediante la opción correspondiente del curso.",
      "La opción «Ver o Editar temas» permite incorporar nuevos temas a un curso existente.",
      "Un curso no puede eliminarse mientras tenga alumnos inscriptos.",
    ] },

    { title: "Empresas", intro: "Gestión de alumnos vinculados a una empresa.", steps: [
      "Las empresas se crean desde la sección «Empresas», junto con sus datos de contacto.",
      "Los alumnos se asocian a una empresa durante su alta o edición.",
      "Es posible registrar una misma clase para todo el grupo de la empresa en una sola operación.",
      "Pueden generarse el informe y el PDF de la empresa con los alumnos seleccionados.",
      "El pago de los alumnos vinculados a una empresa lo abona la propia empresa; en consecuencia, en su planilla figura el pago de la empresa y no un pago individual.",
    ] },

    { title: "Estados y alertas del alumno", intro: "Herramientas de seguimiento y control.", steps: [
      "Cada alumno posee un estado editable por el administrador: Activo, Pausado o Finalizado.",
      "El sistema genera alertas de inactividad cuando transcurren varios días sin registro de clases y, exclusivamente para administradores, alertas por pago atrasado o por ausencia total de pagos registrados.",
      "Las alertas pueden descartarse una vez resueltas.",
    ] },

    { title: "Seguridad de la cuenta", intro: "Contraseña, verificación en dos pasos y cifrado de datos.", steps: [
      "Desde la sección de ajustes, cada usuario puede modificar su nombre, su usuario y su contraseña.",
      "La verificación en dos pasos se activa escaneando un código QR con una aplicación de autenticación; a partir de entonces el acceso requiere un código de seis dígitos.",
      "La información sensible —teléfonos, correos electrónicos, contactos, observaciones y los montos y conceptos de pago— se almacena cifrada en la base de datos.",
    ] },

    // ── Secciones exclusivas de administradores ──
    { title: "Registro de Pagos", adminOnly: true, intro: "Panel de administración de pagos, de acceso exclusivo para administradores.", steps: [
      "El acceso se realiza mediante la opción «Registro de Pagos» del menú lateral, visible únicamente para administradores.",
      "El panel se divide en dos secciones, Alumnos y Empresas, seleccionables mediante el control superior.",
      "Cada alumno o empresa se presenta como un grupo desplegable que, al abrirse, muestra la totalidad de sus pagos.",
      "La opción de registro permite añadir un pago; cada pago puede marcarse como abonado, editarse o eliminarse.",
      "La información puede filtrarse por búsqueda, curso y estado, y ordenarse por fecha o por orden alfabético.",
      "Los alumnos vinculados a una empresa se muestran con un distintivo y sus pagos son de solo lectura, ya que se administran desde la sección Empresas.",
    ] },

    { title: "Exportación del registro de pagos", adminOnly: true, intro: "Descarga del registro de pagos en formato PDF o Excel.", steps: [
      "La opción «Exportar PDF/Excel» adapta sus alternativas al sector activo (Alumnos o Empresas).",
      "Puede elegirse entre formato PDF o Excel con formato profesional.",
      "En la sección Alumnos es posible incluir la totalidad de los alumnos, únicamente aquellos con pagos pendientes, únicamente los que se encuentran al día, o una selección específica mediante buscador.",
      "La opción de exclusión permite dejar fuera a los alumnos que pertenecen a una empresa.",
      "En la sección Empresas puede exportarse la totalidad o una selección específica de empresas.",
      "La exportación puede acotarse por período, seleccionando uno o varios meses y años. El archivo Excel incluye los importes en formato numérico y los totales correspondientes.",
    ] },

    { title: "Gestión de usuarios", adminOnly: true, intro: "Administración de las cuentas del sistema, de acceso exclusivo para administradores.", steps: [
      "El administrador principal dispone de la sección «Usuarios» en el menú.",
      "Permite crear, editar y eliminar cuentas, así como asignar el rol de administrador o de usuario.",
      "Es posible restablecer la contraseña de un usuario y habilitar o deshabilitar su acceso.",
      "El sistema impide que la totalidad de las cuentas de administrador queden deshabilitadas de forma simultánea.",
    ] },
  ];
}

function viewSoporte() {
  const tab = state.soporteTab === "contacto" ? "contacto" : "tutorial";
  const admin = isAdmin();
  const sections = tutorialSections().filter(s => !s.adminOnly || admin);

  const toc = sections.map((sec, i) =>
    `<li><a href="#doc-sec-${i + 1}"><span class="doc-toc-num">${i + 1}.</span> ${sec.title}${sec.adminOnly ? ` <span class="doc-admin-tag">Administrador</span>` : ""}</a></li>`
  ).join("");

  const body = sections.map((sec, i) => `
    <section class="doc-section" id="doc-sec-${i + 1}">
      <h2 class="doc-h2"><span class="doc-h2-num">${i + 1}</span>${sec.title}${sec.adminOnly ? ` <span class="doc-admin-tag">Administrador</span>` : ""}</h2>
      ${sec.intro ? `<p class="doc-intro">${sec.intro}</p>` : ""}
      <ol class="doc-steps">${sec.steps.map(s => `<li>${s}</li>`).join("")}</ol>
    </section>`).join("");

  const tutorial = `
    <div class="doc">
      <header class="doc-header">
        <div class="doc-eyebrow">Keynes Education &amp; Technology</div>
        <h1 class="doc-title">Manual de uso del sistema</h1>
        <p class="doc-lead">Guía completa de operación del sistema de gestión académica${admin ? ", con inclusión de las funciones reservadas a administradores." : "."}</p>
        <div class="doc-actions">
          <button class="btn btn-primary btn-sm" data-export-tutorial>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Descargar en PDF
          </button>
        </div>
      </header>
      <nav class="doc-toc">
        <h2 class="doc-toc-title">Contenido</h2>
        <ol class="doc-toc-list">${toc}</ol>
      </nav>
      <div class="doc-divider"></div>
      ${body}
    </div>`;

  const contacto = `
    <div class="doc doc-narrow">
      <header class="doc-header">
        <div class="doc-eyebrow">Soporte</div>
        <h1 class="doc-title">Contacto con el equipo</h1>
        <p class="doc-lead">Ante cualquier consulta, inconveniente o sugerencia, este formulario permite comunicarse directamente con el equipo responsable del sistema.</p>
      </header>
      <form id="soporteForm" class="doc-form">
        <div class="field"><label>Asunto</label><input name="asunto" maxlength="200" placeholder="Ejemplo: no puedo registrar un pago"></div>
        <div class="field"><label>Mensaje</label>
          <textarea name="mensaje" rows="7" required maxlength="5000" placeholder="Describa con el mayor detalle posible su consulta o el inconveniente." style="width:100%;padding:11px 14px;border:1px solid var(--line);border-radius:10px;font-size:14px;font-family:inherit;resize:vertical;background:var(--surface);color:var(--ink)"></textarea>
        </div>
        <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
          <button type="submit" class="btn btn-primary">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            Enviar mensaje
          </button>
          <span style="font-size:12.5px;color:var(--ink-3)">El envío se realiza de forma segura. Se incluye su identidad de usuario para poder responderle.</span>
        </div>
      </form>
    </div>`;

  return `
  <div class="page-head">
    <div>
      <h2>Soporte y Ayuda</h2>
      <p>Manual de uso del sistema y canal de contacto directo.</p>
    </div>
  </div>
  <div class="seg-control pay-seg" style="margin-bottom:18px">
    <button class="seg-btn ${tab === "tutorial" ? "active" : ""}" data-soporte-tab="tutorial">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
      Manual
    </button>
    <button class="seg-btn ${tab === "contacto" ? "active" : ""}" data-soporte-tab="contacto">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      Soporte
    </button>
  </div>
  ${tab === "contacto" ? contacto : tutorial}`;
}

// Exporta el tutorial a PDF (incluye las secciones de admin solo si el usuario es admin)
async function exportTutorialPDF() {
  const JsPdf = await _getJsPDF(); if (!JsPdf) return;
  const admin = isAdmin();
  const sections = tutorialSections().filter(s => !s.adminOnly || admin);
  const doc = new JsPdf({ unit: "mm", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  const M = 16;
  let y = 20;
  const strip = t => String(t).replace(/<[^>]+>/g, "");
  const brk = need => { if (y + need > 285) { doc.addPage(); y = 20; } };

  doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(37, 99, 235);
  doc.text("KEYNES EDUCATION & TECHNOLOGY", M, y); y += 7;
  doc.setFont("helvetica", "bold"); doc.setFontSize(21); doc.setTextColor(15, 23, 42);
  doc.text("Manual de uso del sistema", M, y); y += 8;
  doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.setTextColor(100, 116, 139);
  doc.text(`Generado el ${new Date().toLocaleString("es")}${admin ? "  ·  Incluye funciones de administrador" : ""}`, M, y); y += 6;
  doc.setDrawColor(226, 232, 240); doc.line(M, y, W - M, y); y += 8;

  sections.forEach((sec, i) => {
    brk(22);
    doc.setFillColor(238, 244, 255); doc.roundedRect(M, y - 5, W - M * 2, 9, 2, 2, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(12.5); doc.setTextColor(37, 99, 235);
    doc.text(`${i + 1}. ${sec.title}${sec.adminOnly ? "  (Solo admin)" : ""}`, M + 3, y + 1); y += 9;
    if (sec.intro) {
      doc.setFont("helvetica", "italic"); doc.setFontSize(9.5); doc.setTextColor(100, 116, 139);
      doc.text(doc.splitTextToSize(strip(sec.intro), W - M * 2), M, y); y += 6;
    }
    doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.setTextColor(30, 41, 59);
    sec.steps.forEach(step => {
      const lines = doc.splitTextToSize("•  " + strip(step), W - M * 2 - 2);
      brk(lines.length * 5 + 2);
      lines.forEach((l, li) => { doc.text(l, M + (li === 0 ? 0 : 4), y); y += 5; });
      y += 1;
    });
    y += 4;
  });

  doc.setFontSize(7.5); doc.setTextColor(148, 163, 184);
  doc.text("Keynes Education & Technology — Guía de uso", M, 292);
  doc.save(`Keynes_Tutorial_${new Date().toISOString().slice(0, 10)}.pdf`);
  toast("Tutorial exportado a PDF.");
}

// ====== Modales ======
function modalCopiarInforme(studentId) {
  const s = getStudent(studentId);
  if (!s) return;

  const datesSet = new Set();
  s.enrollments.forEach(e => e.classes.forEach(cl => datesSet.add(cl.date)));
  const dates = [...datesSet].sort().reverse();
  const dateOptions = dates.map(d => `<option value="${d}">${fmtDate(d)}</option>`).join("");

  // Prefill del formato avanzado con datos del alumno
  const cursos = [...new Set((s.enrollments || []).map(e => getCourse(e.courseId)?.name).filter(Boolean))].join(" + ");
  // Fecha de inicio = primera clase registrada en cualquiera de sus cursos (editable).
  // Si aún no hay clases, cae a la fecha de inicio más temprana de las inscripciones.
  let inicio = firstClassDate(s), fin = "";
  (s.enrollments || []).forEach(e => {
    if (!inicio && e.startDate && (!inicio || e.startDate < inicio)) inicio = e.startDate;
    if (e.estimatedEnd && (!fin || e.estimatedEnd > fin)) fin = e.estimatedEnd;
  });
  if (!inicio) { (s.enrollments || []).forEach(e => { if (e.startDate && (!inicio || e.startDate < inicio)) inicio = e.startDate; }); }

  openModal(`
  <div class="modal-head">
    <h3>Copiar Informe</h3>
    <button class="modal-close" data-modal-close>&times;</button>
  </div>
  <form id="informeForm" data-student="${studentId}">
    <div class="field">
      <label>Formato del informe</label>
      <div class="fmt-toggle">
        <label class="fmt-opt">
          <input type="radio" name="formato" value="basico" checked>
          <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>Básico</span>
        </label>
        <label class="fmt-opt">
          <input type="radio" name="formato" value="avanzado">
          <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>Avanzado</span>
        </label>
      </div>
    </div>

    <div id="informeBasico" style="margin-top:14px">
      <p style="font-size:13px;color:var(--ink-2);margin-bottom:10px">Generá el informe de todas las clases de una fecha.</p>
      <div class="field"><label>Fecha *</label>
        ${dates.length > 0 ? `
        <div class="select-wrap">
          <select name="date">
            <option value="">— Seleccionar fecha —</option>
            ${dateOptions}
          </select>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
        </div>` : `<input type="date" name="date">`}
      </div>
      ${dates.length === 0 ? '<p style="font-size:13px;color:var(--ink-3);margin-top:-8px">No hay clases registradas aún.</p>' : ''}
    </div>

    <div id="informeAvanzado" style="display:none;margin-top:14px">
      <div class="field"><label>Fecha de la clase <span class="optional">(autocompleta el informe)</span></label>
        ${dates.length > 0 ? `
        <div class="select-wrap">
          <select name="advDate" id="advDate">
            <option value="">— Seleccionar fecha —</option>
            ${dateOptions}
          </select>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
        </div>` : '<p style="font-size:13px;color:var(--ink-3)">No hay clases registradas aún. Completá los campos a mano.</p>'}
      </div>
      <div class="grid-2">
        <div class="field"><label>Profesor</label><input name="profesor" placeholder="Nombre del profesor"></div>
        <div class="field"><label>Horario general</label><input name="horarioGeneral" placeholder="Ej. 8 a 16hs"></div>
        <div class="field"><label>Nombre(s)</label><input name="nombres" value="${esc(s.name + " " + s.surname)}"></div>
        <div class="field"><label>Curso(s)</label><input name="cursos" value="${cursos.replace(/"/g, "&quot;")}"></div>
        <div class="field"><label>Horario de la clase</label><input name="horarioClase" value="${esc(s.horario || "")}" placeholder="Ej. 9 a 12 hs"></div>
        <div class="field"><label>Fecha de inicio</label><input name="inicio" value="${inicio ? fmtDate(inicio) : ""}" placeholder="DD/MM/AA"></div>
        <div class="field"><label>Fecha estimada de culminación</label><input name="fin" value="${fin ? fmtDate(fin) : ""}" placeholder="DD/MM/AA"></div>
      </div>
      <div class="field" style="margin-top:12px"><label>Desarrollo <span class="optional">(una línea por tema)</span></label>
        <textarea name="desarrollo" rows="4" placeholder="Tablas Dinámicas&#10;Cta. Resultados - Proyección&#10;Consolidación" style="width:100%;padding:11px 14px;border:1px solid var(--line);border-radius:10px;font-size:14px;font-family:inherit;resize:vertical;background:var(--surface);color:var(--ink)"></textarea>
      </div>
      <div class="field" style="margin-top:12px"><label>Observación</label>
        <textarea name="observacion" rows="3" placeholder="Desarrollamos el contenido citado.&#10;El alumno no tuvo inconvenientes." style="width:100%;padding:11px 14px;border:1px solid var(--line);border-radius:10px;font-size:14px;font-family:inherit;resize:vertical;background:var(--surface);color:var(--ink)"></textarea>
      </div>
      <div class="grid-2" style="margin-top:12px">
        <div class="field"><label>Ausentes</label><input name="ausentes" value="Ninguno"></div>
        <div class="field"><label>Siguiente clase</label><input name="siguiente" placeholder="Ej. Repaso de Consolidación"></div>
      </div>
    </div>

    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" data-modal-close>Cancelar</button>
      <button type="submit" class="btn btn-primary">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        Copiar
      </button>
    </div>
  </form>`);

  // Autocompletar los campos del avanzado con las clases de la fecha elegida
  const fillAdvanced = date => {
    const d = advDataForDate(s, date);
    const set = (name, val) => { const el = modalBox.querySelector(`[name="${name}"]`); if (el && val) el.value = val; };
    set("profesor", d.profesor);
    set("cursos", d.cursos);
    set("horarioClase", d.horarioClase);
    set("desarrollo", d.desarrollo);
    set("observacion", d.observacion);
    set("siguiente", d.siguiente);
  };

  const advDateSel = document.getElementById("advDate");
  if (advDateSel) advDateSel.addEventListener("change", () => fillAdvanced(advDateSel.value));

  // Alternar básico/avanzado
  modalBox.querySelectorAll('input[name="formato"]').forEach(r => r.addEventListener("change", () => {
    const adv = modalBox.querySelector('input[name="formato"]:checked').value === "avanzado";
    document.getElementById("informeBasico").style.display = adv ? "none" : "";
    document.getElementById("informeAvanzado").style.display = adv ? "" : "none";
    // Al entrar al avanzado por primera vez, autocompletar con la fecha más reciente
    if (adv && advDateSel && !advDateSel.value && dates.length) {
      advDateSel.value = dates[0];
      fillAdvanced(dates[0]);
    }
  }));
}

// Datos de las clases de una fecha para autocompletar el informe avanzado
function advDataForDate(s, date) {
  const items = [];
  (s.enrollments || []).forEach(enr => {
    const course = getCourse(enr.courseId);
    (enr.classes || []).filter(cl => cl.date === date).forEach(cl => items.push({ cl, course }));
  });
  const profesor = items.map(i => (i.cl.professor || "").trim()).find(Boolean) || "";
  const cursos = [...new Set(items.map(i => i.course?.name).filter(Boolean))].join(" + ");
  const wt = items.find(i => i.cl.startTime && i.cl.endTime);
  const horarioClase = wt ? `${wt.cl.startTime} a ${wt.cl.endTime} hs` : "";
  const desarrollo = items.map(i => renderTopicText(i.cl.topic)).map(t => (t || "").trim()).filter(Boolean).join("\n");
  const obs = [];
  items.forEach(i => (i.cl.observations || "").split("\n").map(l => l.trim()).filter(Boolean)
    .forEach(l => { if (!obs.includes(l)) obs.push(l); }));
  const siguiente = items.map(i => i.cl.homework?.task).map(t => (t || "").trim()).filter(Boolean).join("; ");
  return { profesor, cursos, horarioClase, desarrollo, observacion: obs.join("\n"), siguiente };
}

function buildInformeAvanzado(d) {
  const desarrollo = (d.desarrollo || "").split("\n").map(l => l.trim()).filter(Boolean)
    .map(l => (l.startsWith(">") ? l : `> ${l}`)).join("\n");
  const prof = (d.profesor || "").trim();
  let t = `INFORME${prof ? ` (${prof})` : ""}${d.horarioGeneral ? " " + d.horarioGeneral.trim() : ""}`.trim() + "\n\n";
  t += `${(d.nombres || "").trim()}${d.cursos ? ` (${d.cursos.trim()})` : ""}${d.horarioClase ? ` de ${d.horarioClase.trim()}` : ""}\n`;
  if (d.inicio && d.inicio.trim()) t += `📆 Fecha de Inicio: ${d.inicio.trim()}\n`;
  if (d.fin && d.fin.trim())       t += `📆 Fecha estimada de culminación: ${d.fin.trim()}\n`;
  if (desarrollo) t += `\n${desarrollo}\n`;
  if (d.observacion && d.observacion.trim()) t += `\nObservación: \n${d.observacion.trim()}\n`;
  if (d.ausentes && d.ausentes.trim())       t += `\n> AUSENTES: ${d.ausentes.trim()}\n`;
  if (d.siguiente && d.siguiente.trim())      t += `> SIGUIENTE CLASE: ${d.siguiente.trim()}\n`;
  return t.trimEnd();
}

function modalAgregarClase(enrollId, topicHint) {
  const today = new Date().toISOString().split("T")[0];
  const found = findEnrollment(enrollId);
  const existingClasses = found ? found.enr.classes : [];
  const courseForHw = found ? getCourse(found.enr.courseId) : null;

  function modalityForDate(date) {
    const match = existingClasses.find(cl => cl.date === date && cl.modality);
    return match ? match.modality : "";
  }

  function professorForDate(date) {
    const match = existingClasses.find(cl => cl.date === date && cl.professor);
    return match ? match.professor : "";
  }

  function timesForDate(date) {
    const match = existingClasses.find(cl => cl.date === date && (cl.startTime || cl.endTime));
    return match ? { start: match.startTime || "", end: match.endTime || "" } : { start: "", end: "" };
  }

  const defaultModality  = modalityForDate(today);
  const defaultProfessor = professorForDate(today);
  const defaultTimes     = timesForDate(today);

  openModal(`
  <div class="modal-head">
    <h3>Registrar Clase</h3>
    <button class="modal-close" data-modal-close>&times;</button>
  </div>
  <form id="addClaseForm" data-enr="${enrollId}">
    <div class="field"><label>Fecha *</label><input type="date" name="date" required value="${today}" id="claseDate"></div>
    <div class="grid-2">
      <div class="field"><label>Hora inicio</label><input type="time" name="startTime" id="claseHoraInicio" value="${defaultTimes.start}"></div>
      <div class="field"><label>Hora fin</label><input type="time" name="endTime" id="claseHoraFin" value="${defaultTimes.end}"></div>
    </div>
    <div class="field"><label>Modalidad</label>
      <div class="select-wrap">
        <select name="modality" id="claseModality">
          <option value=""       ${!defaultModality                   ? "selected" : ""}>— Sin especificar —</option>
          <option value="Virtual"    ${defaultModality === "Virtual"    ? "selected" : ""}>Virtual</option>
          <option value="Presencial" ${defaultModality === "Presencial" ? "selected" : ""}>Presencial</option>
        </select>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
    </div>
    <div class="field">
      <label>Desarrollo Temático *</label>
      <input name="topic" required placeholder="Tema de la clase" value="${topicHint || ""}" ${topicHint ? "readonly style=\"background:var(--brand-50);color:var(--ink-2)\"" : ""}>
    </div>
    <div class="field"><label>Profesor *</label><input name="professor" id="claseProfesor" required placeholder="Nombre del profesor" value="${defaultProfessor}"></div>
    <div class="field"><label>Observaciones <span class="optional">(una por línea)</span></label><textarea name="observations" placeholder="Comprende rápido.&#10;Tiene muchas ganas de aprender." rows="3"></textarea></div>
    ${courseForHw?.hasHomework ? `
    <div class="field hw-field">
      <label>Homework <span class="optional">(opcional)</span></label>
      <textarea name="hwTask" rows="2" placeholder="Ej: Completar ejercicios de gramática páginas 12-15."></textarea>
    </div>` : ""}
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" data-modal-close>Cancelar</button>
      <button type="submit" class="btn btn-primary">Guardar Clase</button>
    </div>
  </form>`);

  // Auto-llenado de modalidad, profesor y horario al cambiar la fecha
  const dateEl      = document.getElementById("claseDate");
  const modalityEl  = document.getElementById("claseModality");
  const profesorEl  = document.getElementById("claseProfesor");
  const horaInicioEl = document.getElementById("claseHoraInicio");
  const horaFinEl    = document.getElementById("claseHoraFin");
  if (dateEl) {
    dateEl.addEventListener("change", () => {
      const m = modalityForDate(dateEl.value);
      if (m && modalityEl) modalityEl.value = m;
      const p = professorForDate(dateEl.value);
      if (p && profesorEl && !profesorEl.value.trim()) profesorEl.value = p;
      const t = timesForDate(dateEl.value);
      if (horaInicioEl && t.start) horaInicioEl.value = t.start;
      if (horaFinEl    && t.end)   horaFinEl.value    = t.end;
    });
  }
}

function modalAgregarHomework(enrollId) {
  const today = new Date().toISOString().split("T")[0];
  const found = findEnrollment(enrollId);
  const existingClasses = found ? found.enr.classes : [];

  function modalityForDate(date) {
    const match = existingClasses.find(cl => cl.date === date && cl.modality);
    return match ? match.modality : "";
  }
  function professorForDate(date) {
    const match = existingClasses.find(cl => cl.date === date && cl.professor);
    return match ? match.professor : "";
  }
  function timesForDate(date) {
    const match = existingClasses.find(cl => cl.date === date && (cl.startTime || cl.endTime));
    return match ? { start: match.startTime || "", end: match.endTime || "" } : { start: "", end: "" };
  }

  const defaultModality  = modalityForDate(today);
  const defaultProfessor = professorForDate(today);
  const defaultTimes     = timesForDate(today);

  openModal(`
  <div class="modal-head">
    <h3>Registrar Homework</h3>
    <button class="modal-close" data-modal-close>&times;</button>
  </div>
  <form id="addHomeworkForm" data-enr="${enrollId}">
    <div class="field"><label>Fecha *</label><input type="date" name="date" required value="${today}" id="hwDate"></div>
    <div class="grid-2">
      <div class="field"><label>Hora inicio</label><input type="time" name="startTime" id="hwHoraInicio" value="${defaultTimes.start}"></div>
      <div class="field"><label>Hora fin</label><input type="time" name="endTime" id="hwHoraFin" value="${defaultTimes.end}"></div>
    </div>
    <div class="field"><label>Modalidad</label>
      <div class="select-wrap">
        <select name="modality" id="hwModality">
          <option value=""           ${!defaultModality                   ? "selected" : ""}>— Sin especificar —</option>
          <option value="Virtual"    ${defaultModality === "Virtual"    ? "selected" : ""}>Virtual</option>
          <option value="Presencial" ${defaultModality === "Presencial" ? "selected" : ""}>Presencial</option>
        </select>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
    </div>
    <div class="field">
      <label>Tarea <span class="optional">(descripción del homework)</span></label>
      <textarea name="hwTask" rows="3" placeholder="Ej: Completar ejercicios de gramática páginas 12-15."></textarea>
    </div>
    <div class="field"><label>Profesor *</label><input name="professor" id="hwProfesor" required placeholder="Nombre del profesor" value="${defaultProfessor}"></div>
    <div class="field"><label>Observaciones <span class="optional">(una por línea)</span></label><textarea name="observations" rows="2"></textarea></div>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" data-modal-close>Cancelar</button>
      <button type="submit" class="btn btn-primary">Guardar Homework</button>
    </div>
  </form>`);

  const dateEl       = document.getElementById("hwDate");
  const modalityEl   = document.getElementById("hwModality");
  const profesorEl   = document.getElementById("hwProfesor");
  const horaInicioEl = document.getElementById("hwHoraInicio");
  const horaFinEl    = document.getElementById("hwHoraFin");
  if (dateEl) {
    dateEl.addEventListener("change", () => {
      const m = modalityForDate(dateEl.value);
      if (m && modalityEl) modalityEl.value = m;
      const p = professorForDate(dateEl.value);
      if (p && profesorEl && !profesorEl.value.trim()) profesorEl.value = p;
      const t = timesForDate(dateEl.value);
      if (horaInicioEl && t.start) horaInicioEl.value = t.start;
      if (horaFinEl    && t.end)   horaFinEl.value    = t.end;
    });
  }
}

function modalEditarClase(enrollId, classIdx) {
  const found = findEnrollment(enrollId);
  if (!found) return;
  const cl = found.enr.classes[parseInt(classIdx)];
  if (!cl) return;
  const course = getCourse(found.enr.courseId);
  const hasPredefinedTopic = course && course.topics.length > 0;
  const isHW = isHomeworkTopic(cl.topic);
  const hwTask = isHW ? cl.topic.slice(9) : "";

  openModal(`
  <div class="modal-head">
    <h3>Editar ${isHW ? "Homework" : "Clase"}</h3>
    <button class="modal-close" data-modal-close>&times;</button>
  </div>
  <form id="editClaseForm" data-enr="${enrollId}" data-idx="${classIdx}">
    <div class="field"><label>Fecha *</label><input type="date" name="date" required value="${cl.date || ""}"></div>
    <div class="grid-2">
      <div class="field"><label>Hora inicio</label><input type="time" name="startTime" value="${cl.startTime || ""}"></div>
      <div class="field"><label>Hora fin</label><input type="time" name="endTime" value="${cl.endTime || ""}"></div>
    </div>
    <div class="field"><label>Modalidad</label>
      <div class="select-wrap">
        <select name="modality">
          <option value="" ${!cl.modality ? "selected" : ""}>— Sin especificar —</option>
          <option value="Virtual" ${cl.modality === "Virtual" ? "selected" : ""}>Virtual</option>
          <option value="Presencial" ${cl.modality === "Presencial" ? "selected" : ""}>Presencial</option>
        </select>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
    </div>
    <div class="field">
      ${isHW ? `
        <label>Tarea <span class="optional">(descripción del homework)</span></label>
        <textarea name="hwTaskOld" rows="3">${esc(hwTask)}</textarea>
      ` : `
        <label>Desarrollo Temático *</label>
        <input name="topic" required value="${esc(cl.topic || "")}" ${hasPredefinedTopic ? 'readonly style="background:var(--brand-50);color:var(--ink-2)"' : ""}>
      `}
    </div>
    ${!isHW && course?.hasHomework ? `
    <div class="field hw-field">
      <label>Homework <span class="optional">(opcional — vacío para eliminar)</span></label>
      <textarea name="hwTask" rows="2" placeholder="Ej: Completar ejercicios...">${esc(cl.homework ? cl.homework.task : "")}</textarea>
    </div>` : ""}
    <div class="field"><label>Profesor *</label><input name="professor" required value="${esc(cl.professor || "")}"></div>
    <div class="field"><label>Observaciones</label><textarea name="observations" rows="3">${esc(cl.observations || "")}</textarea></div>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" data-modal-close>Cancelar</button>
      <button type="submit" class="btn btn-primary">Guardar Cambios</button>
    </div>
  </form>`);
}

function modalEditarHomework(enrollId, classIdx) {
  const r = findEnrollment(enrollId);
  if (!r) return;
  const cl = r.enr.classes[parseInt(classIdx)];
  if (!cl || !cl.homework) return;
  openModal(`
  <div class="modal-head">
    <h3>Editar Homework</h3>
    <button class="modal-close" data-modal-close>&times;</button>
  </div>
  <form id="editHomeworkForm" data-enr="${enrollId}" data-idx="${classIdx}">
    <div class="field">
      <label>Tarea</label>
      <textarea name="hwTask" rows="3" required>${esc(cl.homework.task)}</textarea>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" data-modal-close>Cancelar</button>
      <button type="submit" class="btn btn-primary">Guardar</button>
    </div>
  </form>`);
}

function modalAgregarPago(studentId) {
  const today = new Date().toISOString().split("T")[0];
  openModal(`
  <div class="modal-head">
    <h3>Registrar Pago</h3>
    <button class="modal-close" data-modal-close>&times;</button>
  </div>
  <form id="addPagoForm" data-student="${studentId}">
    <div class="field"><label>Fecha *</label><input type="date" name="date" required value="${today}"></div>
    <div class="field"><label>Concepto *</label><input name="concept" required placeholder="Ej. Mensualidad Junio"></div>
    <div class="field"><label>Monto (₲) *</label><input type="number" name="amount" required min="0" placeholder="Ej. 150000"></div>
    <div class="field check-field"><label><input type="checkbox" name="paid" checked> Marcar como pagado</label></div>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" data-modal-close>Cancelar</button>
      <button type="submit" class="btn btn-primary">Guardar Pago</button>
    </div>
  </form>`);
}

function modalEditarPago(studentId, idx) {
  const s = getStudent(studentId);
  if (!s) return;
  const p = (s.payments || [])[parseInt(idx)];
  if (!p) return;
  openModal(`
  <div class="modal-head">
    <h3>Editar Pago</h3>
    <button class="modal-close" data-modal-close>&times;</button>
  </div>
  <form id="editPagoForm" data-student="${studentId}" data-idx="${idx}">
    <div class="field"><label>Fecha *</label><input type="date" name="date" required value="${p.date || ''}"></div>
    <div class="field"><label>Concepto *</label><input name="concept" required value="${esc(p.concept || '')}"></div>
    <div class="field"><label>Monto (₲) *</label><input type="number" name="amount" required min="0" value="${p.amount || 0}"></div>
    <div class="field check-field"><label><input type="checkbox" name="paid" ${p.paid ? 'checked' : ''}> Marcar como pagado</label></div>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" data-modal-close>Cancelar</button>
      <button type="submit" class="btn btn-primary">Guardar Cambios</button>
    </div>
  </form>`);
}

function modalEditarPagoEmpresa(empresaId, payId) {
  const c = getCompany(empresaId);
  if (!c) return;
  const p = (c.pagosEmpresa || []).find(x => x.id === payId);
  if (!p) return;
  const companyStudents = STUDENTS.filter(s => s.empresaId === empresaId);
  const studentOpts = companyStudents.map(s =>
    `<option value="${s.id}" ${p.studentId === s.id ? "selected" : ""}>${esc(s.name)} ${esc(s.surname)}</option>`).join("");
  openModal(`
  <div class="modal-head">
    <h3>Editar Pago — ${esc(c.name)}</h3>
    <button class="modal-close" data-modal-close>&times;</button>
  </div>
  <form id="editPagoEmpresaForm" data-empresa="${empresaId}" data-pay-id="${payId}">
    <div class="field"><label>Alumno <span class="optional">(opcional)</span></label>
      <div class="select-wrap">
        <select name="studentId">
          <option value="">— General (sin alumno específico) —</option>
          ${studentOpts}
        </select>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
    </div>
    <div class="field"><label>Fecha *</label><input type="date" name="date" required value="${p.date || ''}"></div>
    <div class="field"><label>Concepto *</label><input name="concept" required value="${esc(p.concept || '')}"></div>
    <div class="field"><label>Monto (₲) *</label><input type="number" name="amount" required min="0" value="${p.amount || 0}"></div>
    <div class="field check-field"><label><input type="checkbox" name="paid" ${p.paid ? 'checked' : ''}> Marcar como pagado</label></div>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" data-modal-close>Cancelar</button>
      <button type="submit" class="btn btn-primary">Guardar Cambios</button>
    </div>
  </form>`);
}

function modalEliminarAlumno(studentId) {
  const s = getStudent(studentId);
  if (!s) return;
  modalConfirmarEliminar({
    titulo: "Eliminar Alumno",
    mensaje: `¿Confirmás la eliminación de <b>${esc(s.name)} ${esc(s.surname)}</b>? Se eliminarán todos sus datos, cursos y pagos registrados.`,
    onConfirmAttr: "data-confirm-delete",
    onConfirmValue: studentId
  });
}

function modalEditarAlumno(studentId) {
  const s = getStudent(studentId);
  if (!s) return;
  openModal(`
  <div class="modal-head">
    <h3>Editar Alumno</h3>
    <button class="modal-close" data-modal-close>&times;</button>
  </div>
  <form id="editStudentForm" data-student="${studentId}">
    <div class="grid-2">
      <div class="field"><label>Nombre *</label><input name="nombre" required value="${esc(s.name)}"></div>
      <div class="field"><label>Apellido *</label><input name="apellido" required value="${esc(s.surname)}"></div>
      <div class="field"><label>Teléfono</label><input name="telefono" value="${esc(s.phone)}"></div>
      <div class="field"><label>Correo electrónico</label><input type="email" name="email" value="${esc(s.email || "")}"></div>
      <div class="field"><label>Modalidad</label>
        <div class="select-wrap">
          <select name="modalidad">
            <option value="" ${!s.modality ? "selected" : ""}>— Seleccionar —</option>
            <option value="presencial" ${s.modality === "presencial" ? "selected" : ""}>Presencial</option>
            <option value="virtual" ${s.modality === "virtual" ? "selected" : ""}>Virtual</option>
          </select>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
      </div>
    </div>
    <div class="field" style="margin-top:14px">
      <label>Días de clase</label>
      <div style="display:flex;flex-wrap:wrap;gap:8px 20px;margin-top:6px">
        ${DIAS.map(d => `<label style="display:flex;align-items:center;gap:5px;font-size:13.5px;cursor:pointer;font-weight:400"><input type="checkbox" name="diasClase" value="${d}" ${(s.diasClase||[]).includes(d) ? "checked" : ""}> ${d}</label>`).join("")}
      </div>
    </div>
    <div class="field" style="margin-top:14px">
      <label>Horario</label>
      <input name="horario" placeholder="Ej. 14:00 - 16:00" value="${esc(s.horario || "")}">
    </div>
    ${COMPANIES.length ? `<div class="field" style="margin-top:14px">
      <label>Empresa <span class="optional">(opcional)</span></label>
      <div class="select-wrap">
        <select name="empresaId">
          <option value="">— Sin empresa —</option>
          ${COMPANIES.map(c => `<option value="${c.id}" ${s.empresaId === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}
        </select>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
    </div>` : ""}
    <div style="margin-top:6px;margin-bottom:14px;padding-top:14px;border-top:1px solid var(--line);font-size:13px;font-weight:700;color:var(--ink-3)">CONTACTO ADICIONAL <span style="font-weight:400">(opcional)</span></div>
    <div class="grid-2">
      <div class="field"><label>Nombre</label><input name="c2nombre" value="${s.contact2Name || ""}"></div>
      <div class="field"><label>Parentesco</label>
        <div class="select-wrap">
          <select name="c2parentesco">
            <option value="" ${!s.contact2Relation ? "selected" : ""}>— Seleccionar —</option>
            ${["Madre","Padre","Hermano/a","Tutor legal","Otro"].map(o => `<option ${s.contact2Relation === o ? "selected" : ""}>${o}</option>`).join("")}
          </select>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
      </div>
      <div class="field"><label>Teléfono</label><input name="c2telefono" value="${s.contact2Phone || ""}"></div>
    </div>
    <div class="field" style="margin-top:14px">
      <label>Características del alumno <span class="optional">(opcional)</span></label>
      <textarea name="caracteristicas" rows="3" placeholder="Ej. Aprende rápido, dificultad con fórmulas, prefiere ejemplos prácticos…" style="width:100%;padding:11px 14px;border:1px solid var(--line);border-radius:10px;font-size:14px;font-family:inherit;resize:vertical">${esc(s.caracteristicas || "")}</textarea>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" data-modal-close>Cancelar</button>
      <button type="submit" class="btn btn-primary">Guardar Cambios</button>
    </div>
  </form>`);
}

function modalConfirmarEliminar({ titulo, mensaje, onConfirmAttr, onConfirmValue }) {
  openModal(`
  <div class="modal-head">
    <h3>${titulo}</h3>
    <button class="modal-close" data-modal-close>&times;</button>
  </div>
  <div class="modal-body">
    <p>${mensaje}</p>
    <p class="warn-text">Esta acción no se puede deshacer.</p>
  </div>
  <div class="modal-actions">
    <button class="btn btn-ghost" data-modal-close>Cancelar</button>
    <button class="btn btn-danger" ${onConfirmAttr}="${onConfirmValue}">Sí, eliminar</button>
  </div>`);
}

function modalConfirmarFinalizar(enrollId) {
  const r = findEnrollment(enrollId);
  if (!r) return;
  const courseName = getCourse(r.enr.courseId)?.name || "el curso";
  openModal(`
  <div class="modal-head">
    <h3>Confirmar Finalización</h3>
    <button class="modal-close" data-modal-close>&times;</button>
  </div>
  <div class="modal-body">
    <p>¿Confirmás que <b>${esc(r.student.name)} ${esc(r.student.surname)}</b> finalizó <b>${esc(courseName)}</b>?</p>
    <p style="font-size:13px;color:var(--ink-3);margin-top:8px">El alumno aparecerá como <b>Finalizado</b> en la lista una vez que todos sus cursos estén marcados como completados.</p>
  </div>
  <div class="modal-actions">
    <button class="btn btn-ghost" data-modal-close>Cancelar</button>
    <button class="btn btn-primary" data-confirm-complete="${enrollId}">Sí, marcar como finalizado</button>
  </div>`);
}

function modalAgregarAsistenciaGeneral(studentId) {
  const today = new Date().toISOString().split("T")[0];
  openModal(`
  <div class="modal-head">
    <h3>Registrar Asistencia</h3>
    <button class="modal-close" data-modal-close>&times;</button>
  </div>
  <form id="addAttendGenForm" data-student="${studentId}">
    <div class="field"><label>Fecha *</label><input type="date" name="date" required value="${today}"></div>
    <div class="field"><label>Estado *</label>
      <div class="select-wrap">
        <select name="present" required>
          <option value="true">Presente (P)</option>
          <option value="false">Ausente (A)</option>
        </select>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
    </div>
    <div class="field"><label>Horas</label><input type="number" name="hours" step="0.5" min="0" placeholder="Ej. 1.5"></div>
    <div class="field"><label>Observación <span class="optional">(opcional)</span></label><input name="observations" placeholder="Ej. Llegó tarde, trabajamos tema X…"></div>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" data-modal-close>Cancelar</button>
      <button type="submit" class="btn btn-primary">Guardar</button>
    </div>
  </form>`);
}

function modalEditarAsistenciaGeneral(studentId, idx) {
  const s = getStudent(studentId);
  if (!s || !s.attendance) return;
  const a = s.attendance[parseInt(idx)];
  if (!a) return;
  openModal(`
  <div class="modal-head">
    <h3>Editar Asistencia</h3>
    <button class="modal-close" data-modal-close>&times;</button>
  </div>
  <form id="editAttendGenForm" data-student="${studentId}" data-idx="${idx}">
    <div class="field"><label>Fecha *</label><input type="date" name="date" required value="${a.date || ""}"></div>
    <div class="field"><label>Estado *</label>
      <div class="select-wrap">
        <select name="present" required>
          <option value="true" ${a.present ? "selected" : ""}>Presente (P)</option>
          <option value="false" ${!a.present ? "selected" : ""}>Ausente (A)</option>
        </select>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
    </div>
    <div class="field"><label>Horas</label><input type="number" name="hours" step="0.5" min="0" placeholder="Ej. 1.5" value="${a.hours !== undefined && a.hours !== null ? a.hours : ""}"></div>
    <div class="field"><label>Observación <span class="optional">(opcional)</span></label><input name="observations" placeholder="Ej. Llegó tarde, trabajamos tema X…" value="${esc(a.observations || "")}"></div>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" data-modal-close>Cancelar</button>
      <button type="submit" class="btn btn-primary">Guardar Cambios</button>
    </div>
  </form>`);
}

function modalNuevoCurso() {
  openModal(`
  <div class="modal-head">
    <h3>Nuevo Curso</h3>
    <button class="modal-close" data-modal-close>&times;</button>
  </div>
  <form id="newCourseForm">
    <div class="field"><label>Nombre del curso *</label><input name="name" required placeholder="Ej. Excel Intermedio"></div>
    <div class="field">
      <label>Temas predefinidos <span class="optional">(uno por línea — dejá vacío para carga manual)</span></label>
      <textarea name="topics" rows="7" placeholder="C1.1 - Tema uno&#10;C1.2 - Tema dos&#10;C2.1 - Otro tema…"></textarea>
    </div>
    <div class="field">
      <label class="check-label" style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:500">
        <input type="checkbox" name="hasHomework" style="width:16px;height:16px;flex-shrink:0">
        Permitir homework en las clases
      </label>
      <span style="font-size:12px;color:var(--ink-3);margin-top:4px;display:block">Al registrar una clase se podrá agregar una tarea opcional.</span>
    </div>
    <div class="field">
      <label class="check-label" style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:500">
        <input type="checkbox" name="allowManual" style="width:16px;height:16px;flex-shrink:0">
        Permitir carga manual de clases (además de los temas)
      </label>
      <span style="font-size:12px;color:var(--ink-3);margin-top:4px;display:block">Útil si querés registrar clases que no están en la lista de temas predefinidos.</span>
    </div>
    <div class="field">
      <label>Notas / Materiales <span class="optional">(opcional)</span></label>
      <textarea name="notes" rows="4" placeholder="Ej. Material: cuadernillo Excel 2024 (PDF), enlace a plantillas, bibliografía…"></textarea>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" data-modal-close>Cancelar</button>
      <button type="submit" class="btn btn-primary">Crear Curso</button>
    </div>
  </form>`);
}

function modalVerTemas(courseId) {
  const c = getCourse(courseId);
  if (!c) return;
  const admin = isAdmin();
  const list = c.topics.length
    ? `<ol class="topics-list">${c.topics.map((t, i) => `<li>
        <span class="topic-text">${t.replace(/</g, "&lt;")}</span>
        ${admin ? `<span class="topic-actions">
          <button type="button" class="btn-icon" data-edit-topic="${courseId}" data-topic-idx="${i}" title="Editar tema">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button type="button" class="btn-icon danger" data-del-topic="${courseId}" data-topic-idx="${i}" title="Eliminar tema">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </span>` : ""}
      </li>`).join("")}</ol>`
    : "<p style='color:var(--ink-3);font-size:13.5px;margin-bottom:16px'>Este curso no tiene temas predefinidos.</p>";
  const hwOn = !!c.hasHomework;
  const manualOn = !!c.allowManual;
  openModal(`
  <div class="modal-head">
    <h3>${esc(c.name)}</h3>
    <button class="modal-close" data-modal-close>&times;</button>
  </div>
  ${admin ? `<div style="padding:0 20px 14px;border-bottom:1px solid var(--line);margin-bottom:14px">
    <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13.5px;font-weight:500">
      <input type="checkbox" id="hwToggle" data-toggle-course-hw="${courseId}" ${hwOn ? "checked" : ""} style="width:16px;height:16px;flex-shrink:0">
      Permitir homework en las clases
    </label>
    <p style="font-size:12px;color:var(--ink-3);margin:4px 0 0 24px">Al registrar una clase se podrá agregar una tarea opcional.</p>
    <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13.5px;font-weight:500;margin-top:12px">
      <input type="checkbox" id="manualToggle" data-toggle-course-manual="${courseId}" ${manualOn ? "checked" : ""} style="width:16px;height:16px;flex-shrink:0">
      Permitir carga manual de clases (además de los temas)
    </label>
    <p style="font-size:12px;color:var(--ink-3);margin:4px 0 0 24px">Permite registrar clases fuera de la lista de temas predefinidos.</p>
  </div>
  <form id="courseNotesForm" data-course="${courseId}" style="padding:0 20px 14px;border-bottom:1px solid var(--line);margin-bottom:14px">
    <div class="field" style="margin-bottom:8px"><label>Notas / Materiales</label>
      <textarea name="notes" rows="4" placeholder="Ej. Material: cuadernillo (PDF), enlaces, bibliografía…" style="width:100%;padding:11px 14px;border:1px solid var(--line);border-radius:10px;font-size:14px;font-family:inherit;resize:vertical;background:var(--surface);color:var(--ink)">${esc(c.notes || "")}</textarea>
    </div>
    <button type="submit" class="btn btn-ghost btn-sm">Guardar notas</button>
  </form>` : (c.notes ? `<div style="padding:0 20px 14px;border-bottom:1px solid var(--line);margin-bottom:14px">
    <label style="display:block;font-size:13.5px;font-weight:600;margin-bottom:4px">Notas / Materiales</label>
    <p style="font-size:13.5px;color:var(--ink-2);white-space:pre-wrap;line-height:1.55">${esc(c.notes || "")}</p>
  </div>` : "")}
  <div class="modal-body">${list}</div>
  ${admin ? `<form id="addTopicForm" data-course="${courseId}">
    <div class="field"><label>Agregar tema</label><input name="topic" placeholder="Ej. C9.1 - Nuevo tema"></div>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" data-modal-close>Cerrar</button>
      <button type="submit" class="btn btn-primary">Agregar Tema</button>
    </div>
  </form>` : `<div class="modal-actions">
    <button type="button" class="btn btn-ghost" data-modal-close>Cerrar</button>
  </div>`}`);
}

function modalEditarTema(courseId, idx) {
  const c = getCourse(courseId);
  const i = parseInt(idx);
  if (!c || !c.topics || !c.topics[i]) return;
  openModal(`
  <div class="modal-head">
    <h3>Editar Tema</h3>
    <button class="modal-close" data-modal-close>&times;</button>
  </div>
  <form id="editTopicForm" data-course="${courseId}" data-idx="${i}">
    <div class="field"><label>Tema *</label><input name="topic" required value="${c.topics[i].replace(/"/g, "&quot;")}"></div>
    <p style="font-size:12.5px;color:var(--ink-3);margin:2px 0 10px">Si el tema ya tiene clases registradas, se actualizarán para que sigan asociadas.</p>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" data-modal-close>Cancelar</button>
      <button type="submit" class="btn btn-primary">Guardar</button>
    </div>
  </form>`);
}

function modalAgregarEnrollment(studentId) {
  const opts = COURSES.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
  openModal(`
  <div class="modal-head">
    <h3>Agregar Curso al Alumno</h3>
    <button class="modal-close" data-modal-close>&times;</button>
  </div>
  <form id="addEnrollForm" data-student="${studentId}">
    <div class="field"><label>Curso *</label>
      <div class="select-wrap">
        <select name="courseId" required><option value="">— Seleccionar —</option>${opts}</select>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
    </div>
    <div class="field"><label>Tutor(es)</label><input name="tutors" placeholder="Ej. Carlos R."></div>
    <p style="font-size:12.5px;color:var(--ink-3);margin:2px 0 10px">La configuración de pago es única del alumno (se administra desde el Registro de Pagos).</p>
    <div class="grid-2">
      <div class="field"><label>Fecha inicio</label><input type="date" name="startDate"></div>
      <div class="field"><label>Fin estimado</label><input type="date" name="endDate"></div>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" data-modal-close>Cancelar</button>
      <button type="submit" class="btn btn-primary">Agregar</button>
    </div>
  </form>`);
}

function modalEditarCursoEnrollment(enrollId) {
  const r = findEnrollment(enrollId);
  if (!r) return;
  const opts = COURSES.map(c => `<option value="${c.id}"${c.id === r.enr.courseId ? ' selected' : ''}>${esc(c.name)}</option>`).join("");
  openModal(`
  <div class="modal-head">
    <h3>Cambiar Curso</h3>
    <button class="modal-close" data-modal-close>&times;</button>
  </div>
  <form id="editEnrCourseForm" data-enr="${enrollId}">
    <div class="field"><label>Curso *</label>
      <div class="select-wrap">
        <select name="courseId" required><option value="">— Seleccionar —</option>${opts}</select>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" data-modal-close>Cancelar</button>
      <button type="submit" class="btn btn-primary">Guardar</button>
    </div>
  </form>`);
}

function modalEditarFechasCurso(enrollId) {
  const r = findEnrollment(enrollId);
  if (!r) return;
  openModal(`
  <div class="modal-head">
    <h3>Editar Fechas del Curso</h3>
    <button class="modal-close" data-modal-close>&times;</button>
  </div>
  <form id="editEnrDatesForm" data-enr="${enrollId}">
    <div class="grid-2">
      <div class="field"><label>Fecha inicio</label><input type="date" name="startDate" value="${r.enr.startDate || ''}"></div>
      <div class="field"><label>Fin estimado</label><input type="date" name="endDate" value="${r.enr.estimatedEnd || ''}"></div>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" data-modal-close>Cancelar</button>
      <button type="submit" class="btn btn-primary">Guardar</button>
    </div>
  </form>`);
}

function modalEditarTutores(enrollId) {
  const r = findEnrollment(enrollId);
  if (!r) return;
  openModal(`
  <div class="modal-head">
    <h3>Editar Tutores</h3>
    <button class="modal-close" data-modal-close>&times;</button>
  </div>
  <form id="editEnrTutorsForm" data-enr="${enrollId}">
    <div class="field">
      <label>Tutor(es)</label>
      <input name="tutors" placeholder="Ej. Carlos R., María L." value="${esc((r.enr.tutors || []).join(', '))}">
      <span style="font-size:12px;color:var(--ink-3);margin-top:4px;display:block">Separados por coma.</span>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" data-modal-close>Cancelar</button>
      <button type="submit" class="btn btn-primary">Guardar</button>
    </div>
  </form>`);
}

function modalEditarConfigPago(studentId) {
  const s = getStudent(studentId);
  if (!s) return;
  const p = s.payment || {};
  const type = p.type || 'mensual';
  openModal(`
  <div class="modal-head">
    <h3>Editar Configuración de Pago</h3>
    <button class="modal-close" data-modal-close>&times;</button>
  </div>
  <form id="editPayConfigForm" data-student="${studentId}">
    <div class="field"><label>Modalidad de pago</label>
      <div class="select-wrap">
        <select name="paytype">
          <option value="mensual"         ${type === 'mensual'          ? 'selected' : ''}>Mensual</option>
          <option value="por clase"       ${type === 'por clase'        ? 'selected' : ''}>Por clase</option>
          <option value="curso completo"  ${type === 'curso completo'   ? 'selected' : ''}>Curso completo</option>
          <option value="paquete"         ${type === 'paquete'          ? 'selected' : ''}>Paquete de horas</option>
        </select>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
    </div>
    <div class="grid-2">
      <div class="field"><label>Monto / Cuota (₲)</label><input type="number" name="amount" min="0" placeholder="Ej. 600000" value="${p.amount || 0}"></div>
      <div class="field"><label>Hs/semana <span class="optional">(paquete)</span></label><input type="number" name="packageHours" min="0" placeholder="Ej. 6" value="${p.packageHours || ''}"></div>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" data-modal-close>Cancelar</button>
      <button type="submit" class="btn btn-primary">Guardar</button>
    </div>
  </form>`);
}

function modalAgregarAsistencia(enrollId) {
  const today = new Date().toISOString().split("T")[0];
  openModal(`
  <div class="modal-head">
    <h3>Registrar Asistencia</h3>
    <button class="modal-close" data-modal-close>&times;</button>
  </div>
  <form id="addAttendForm" data-enr="${enrollId}">
    <div class="field"><label>Fecha *</label><input type="date" name="date" required value="${today}"></div>
    <div class="field"><label>Estado *</label>
      <div class="select-wrap">
        <select name="present" required>
          <option value="true">Presente (P)</option>
          <option value="false">Ausente (A)</option>
        </select>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
    </div>
    <div class="field"><label>Horas</label><input type="number" name="hours" step="0.5" min="0" placeholder="Ej. 1.5"></div>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" data-modal-close>Cancelar</button>
      <button type="submit" class="btn btn-primary">Guardar</button>
    </div>
  </form>`);
}

function modalDescargarPDF(studentId) {
  const s = getStudent(studentId);
  if (!s) return;

  const enrollRows = (s.enrollments || []).map((enr, idx) => {
    const course = getCourse(enr.courseId);
    const courseName = course ? course.name : (enr.courseId || 'Curso');
    return `
    <div style="border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:8px">
      <label style="display:flex;align-items:center;gap:8px;font-weight:600;font-size:14px;cursor:pointer;margin-bottom:0">
        <input type="checkbox" class="chk-enr" data-enr-idx="${idx}" checked style="width:16px;height:16px;flex-shrink:0">
        ${esc(courseName)}
        ${enr.startDate ? `<span style="font-size:12px;color:var(--ink-2);font-weight:normal">desde ${fmtDate(enr.startDate)}</span>` : ''}
      </label>
      <div class="enr-edit-fields" data-for-enr="${idx}" style="margin-top:10px;display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div class="field" style="margin:0">
          <label style="font-size:12px">Tutor(es)</label>
          <input type="text" class="enr-tutors" data-enr-idx="${idx}" value="${esc((enr.tutors || []).join(', '))}" style="font-size:13px;padding:7px 10px">
        </div>
        <div class="field" style="margin:0">
          <label style="font-size:12px">Fecha inicio</label>
          <input type="date" class="enr-start" data-enr-idx="${idx}" value="${enr.startDate || ''}" style="font-size:13px;padding:7px 10px">
        </div>
        <div class="field" style="margin:0">
          <label style="font-size:12px">Fin estimado</label>
          <input type="date" class="enr-end" data-enr-idx="${idx}" value="${enr.estimatedEnd || ''}" style="font-size:13px;padding:7px 10px">
        </div>
      </div>
    </div>`;
  }).join('');

  openModal(`
  <div class="modal-head">
    <h3>Descargar Informe PDF</h3>
    <button class="modal-close" data-modal-close>&times;</button>
  </div>
  <p style="font-size:14px;color:var(--ink-2);margin-bottom:14px">Seleccioná qué secciones incluir en el informe:</p>
  <div class="field check-field"><label><input type="checkbox" id="chkPdfCaracteristicas" checked> Características del Alumno</label></div>
  <div class="field check-field"><label><input type="checkbox" id="chkPdfAsistencia" checked> Planilla de Asistencia</label></div>
  ${isAdmin() ? `<div class="field check-field" style="margin-bottom:4px"><label><input type="checkbox" id="chkPdfPagos" checked> Registro de Pagos</label></div>` : ""}
  <div class="field check-field" style="margin-bottom:16px;margin-top:6px;padding-top:10px;border-top:1px solid var(--line)"><label><input type="checkbox" id="chkPdfSoloAsistencia"> <strong>Solo Planilla de Asistencia</strong> <span style="font-size:12px;color:var(--ink-3);font-weight:normal">— omite el desarrollo temático de los cursos</span></label></div>
  <p style="font-size:13px;font-weight:600;color:var(--ink-1);margin-bottom:8px" id="pdfEnrollHeader">Cursos a incluir en el PDF:</p>
  ${enrollRows || '<p style="font-size:13px;color:var(--ink-2);margin-bottom:12px">El alumno no tiene inscripciones.</p>'}
  <div class="field" style="margin-top:12px">
    <label>Observaciones generales <span class="optional">(opcional)</span></label>
    <textarea id="pdfObservaciones" rows="3" placeholder="Ej. El alumno muestra excelente progreso…" style="width:100%;padding:11px 14px;border:1px solid var(--line);border-radius:10px;font-size:14px;font-family:inherit;resize:vertical"></textarea>
  </div>
  <div class="modal-actions" style="margin-top:8px">
    <button class="btn btn-ghost" data-modal-close>Cancelar</button>
    <button class="btn btn-primary" data-do-pdf="${studentId}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      Descargar PDF
    </button>
  </div>`);

  modalBox.querySelectorAll('.chk-enr').forEach(chk => {
    chk.addEventListener('change', () => {
      const fields = modalBox.querySelector(`.enr-edit-fields[data-for-enr="${chk.dataset.enrIdx}"]`);
      if (fields) fields.style.display = chk.checked ? 'grid' : 'none';
    });
  });

  document.getElementById("chkPdfSoloAsistencia")?.addEventListener("change", e => {
    if (e.target.checked) modalBox.querySelectorAll(".chk-enr").forEach(c => { c.checked = false; c.dispatchEvent(new Event("change")); });
  });
}

// ====== Certificado ======
const CERT_MESES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];

// Número (0-99) a palabras en español, para el año del certificado.
function _num99(n) {
  const U = ["cero","uno","dos","tres","cuatro","cinco","seis","siete","ocho","nueve","diez","once","doce","trece","catorce","quince","dieciséis","diecisiete","dieciocho","diecinueve"];
  const V = ["veinte","veintiuno","veintidós","veintitrés","veinticuatro","veinticinco","veintiséis","veintisiete","veintiocho","veintinueve"];
  const D = ["","","","treinta","cuarenta","cincuenta","sesenta","setenta","ochenta","noventa"];
  n = Math.floor(n);
  if (n < 20) return U[n];
  if (n < 30) return V[n - 20];
  const d = Math.floor(n / 10), u = n % 10;
  return D[d] + (u ? " y " + U[u] : "");
}
function _tituloCase(str) { return str.split(" ").map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(" "); }
// Año 2000-2099 en palabras: 2026 → "Dos Mil Veintiséis"
function _anioEnLetras(y) {
  const resto = y - 2000;
  return _tituloCase("dos mil" + (resto ? " " + _num99(resto) : ""));
}
// Primer nombre + primer apellido (automático, no editable)
function _nombreCertificado(s) {
  const nombre   = (s.name || "").trim().split(/\s+/)[0] || "";
  const apellido = (s.surname || "").trim().split(/\s+/)[0] || "";
  return `${nombre} ${apellido}`.trim();
}

function modalCertificado(studentId) {
  const s = getStudent(studentId);
  if (!s) return;
  // Curso sugerido: el del primer curso inscripto, si existe
  const primerCurso = (s.enrollments || []).map(e => getCourse(e.courseId)).find(Boolean);
  const cursoDef = primerCurso ? primerCurso.name : "";
  const hoy = new Date().toISOString().slice(0, 10);
  openModal(`
  <div class="modal-head">
    <h3>Certificado — ${_nombreCertificado(s)}</h3>
    <button class="modal-close" data-modal-close>&times;</button>
  </div>
  <form id="certificadoForm" data-student="${studentId}">
    <p style="font-size:12.5px;color:var(--ink-3);margin-bottom:12px">El nombre se toma automáticamente (primer nombre + primer apellido): <b>${_nombreCertificado(s)}</b></p>
    <div class="field"><label>Tipo de certificado</label>
      <div class="select-wrap">
        <select name="tipo" id="certTipo">
          <option value="informatica" selected>Informática</option>
          <option value="ingles">Inglés</option>
        </select>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
    </div>

    <div id="certCamposInformatica">
      <div class="field"><label>Curso *</label><input name="curso" value="${cursoDef.replace(/"/g, "&quot;")}" placeholder="Ej. Excel Avanzado + PowerBI"></div>
      <div class="field"><label>Sector</label><input name="sector" value="Informáticas" placeholder="Ej. Informáticas / Administrativas"></div>
    </div>

    <div id="certCamposIngles" style="display:none">
      <div class="field"><label>Sistema *</label><input name="sistema" placeholder="Ej. Full Conversation + Test de Duolingo"></div>
      <div class="field"><label>Nivel</label><input name="nivel" placeholder="Ej. High Intermediate"></div>
    </div>

    <div class="grid-2">
      <div class="field"><label>Horas cátedra <span class="optional">(opcional)</span></label><input type="number" name="horas" min="1" placeholder="Ej. 24"></div>
      <div class="field"><label>Fecha</label><input type="date" name="fecha" value="${hoy}"></div>
    </div>
    <div class="grid-2">
      <div class="field"><label>Ciudad / País</label><input name="lugar" value="Asunción, Paraguay"></div>
      <div class="field"><label>Formato</label>
        <div class="select-wrap">
          <select name="formato">
            <option value="pptx" selected>PowerPoint (.pptx)</option>
            <option value="pdf">PDF</option>
          </select>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
      </div>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" data-modal-close>Cancelar</button>
      <button type="submit" class="btn btn-primary">Descargar Certificado</button>
    </div>
  </form>`);

  // Alternar campos según el tipo
  const tipoSel = document.getElementById("certTipo");
  tipoSel?.addEventListener("change", () => {
    const ing = tipoSel.value === "ingles";
    document.getElementById("certCamposInformatica").style.display = ing ? "none" : "";
    document.getElementById("certCamposIngles").style.display = ing ? "" : "none";
  });
}

// Textos del certificado (compartidos por PDF y PPTX). Las horas son opcionales.
// tipo: "informatica" (Herramientas … Aplicadas a Empresas) | "ingles" (clases de Inglés).
function _certTextos(s, opts) {
  const tipo   = opts.tipo === "ingles" ? "ingles" : "informatica";
  const horas  = parseInt(opts.horas) > 0 ? parseInt(opts.horas) : null;
  const lugar  = (opts.lugar || "Asunción, Paraguay").trim();
  const d = opts.fecha ? new Date(opts.fecha + "T00:00:00") : new Date();
  const dia = d.getDate(), mes = CERT_MESES[d.getMonth()], anio = _anioEnLetras(d.getFullYear());

  const run1 = horas
    ? `Ha completado satisfactoriamente un programa especial de ${horas} horas cátedras de instrucción`
    : `Ha completado satisfactoriamente un programa especial de instrucción`;

  let run2, run3;
  if (tipo === "ingles") {
    const sistema = (opts.sistema || "").trim();
    const nivel   = (opts.nivel || "").trim();
    run2 = `en clases de Inglés (Sistema: ${sistema})${nivel ? `, nivel ${nivel}` : ""}.`;
    run3 = `Recibido en ${lugar}, a los ${dia} días `;
  } else {
    const curso  = (opts.curso || "").trim();
    const sector = (opts.sector || "Informáticas").trim();
    run2 = `en Herramientas ${sector} Aplicadas a Empresas: “${curso}”.`;
    run3 = `Recibido en ${lugar}, ${dia} días `;
  }
  return { tipo, nombre: _nombreCertificado(s), run1, run2, run3, run4: `del mes de ${mes} del Año ${anio}.` };
}

// Construye la URL de verificación firmada (para el QR) y devuelve el QR como
// dataURL PNG. Requiere que el servidor firme el payload (usuario autenticado).
async function _certQRDataURL(s, opts, t) {
  const dia = opts.fecha || new Date().toISOString().slice(0, 10);
  const payload = {
    n: t.nombre, k: t.tipo,
    c: t.tipo === "ingles" ? (opts.sistema || "").trim() : (opts.curso || "").trim(),
    l: t.tipo === "ingles" ? (opts.nivel || "").trim() : "",
    h: parseInt(opts.horas) > 0 ? parseInt(opts.horas) : "",
    f: dia,
  };
  const dB64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  let sig;
  try {
    const r = await fetch(`/api/cert-firma?d=${encodeURIComponent(dB64)}`);
    if (!r.ok) throw new Error("firma");
    sig = (await r.json()).s;
  } catch { return null; }
  const url = `${location.origin}/verificar?d=${dB64}&s=${sig}`;

  if (!window.QRCode) return null;
  const holder = document.createElement("div");
  holder.style.position = "fixed"; holder.style.left = "-9999px";
  document.body.appendChild(holder);
  try {
    new QRCode(holder, { text: url, width: 320, height: 320, correctLevel: QRCode.CorrectLevel.M });
    const canvas = holder.querySelector("canvas");
    const dataUrl = canvas ? canvas.toDataURL("image/png") : (holder.querySelector("img") || {}).src;
    return dataUrl || null;
  } catch { return null; }
  finally { holder.remove(); }
}

async function generarCertificadoPDF(studentId, opts) {
  const s = getStudent(studentId);
  if (!s) return;
  const JsPdf = await _getJsPDF(); if (!JsPdf) return;

  const t = _certTextos(s, opts);
  const nombre = t.nombre;

  // Cargar la plantilla (mismo diseño que el certificado real) como fondo.
  let img;
  try {
    img = new Image();
    img.src = "/cert-template.png?v=3";  // cache-bust: el fondo cambió (subir al cambiar la plantilla)
    await img.decode();
  } catch { toast("No se pudo cargar la plantilla del certificado."); return; }

  // Fondo = plantilla LIMPIA derivada del propio pptx (image2 + firma + sello, sin cuerpo).
  // Slide pptx = 9906000×6858000 EMU = 780×540 pt. No hace falta tapar nada: se escribe encima.
  const cx = 390;   // centro horizontal (780/2)
  const doc = new JsPdf({ orientation: "landscape", unit: "pt", format: [780, 540] });
  doc.addImage(img, "PNG", 0, 0, 780, 540);

  const INK = [30, 30, 30];
  doc.setTextColor(...INK);

  // Nombre (automático: primer nombre + primer apellido). Bajo "Certificamos que:" (~215pt).
  // Igual que el pptx: subrayado, ~40pt (se achica si el nombre es muy ancho).
  const yNombre = 258;
  doc.setFont("times", "normal");
  let nameSize = 40; doc.setFontSize(nameSize);
  while (doc.getTextWidth(nombre) > 560 && nameSize > 22) { nameSize -= 2; doc.setFontSize(nameSize); }
  doc.text(nombre, cx, yNombre, { align: "center" });
  const nw = doc.getTextWidth(nombre);
  doc.setLineWidth(1); doc.setDrawColor(...INK);
  doc.line(cx - nw / 2, yNombre + 5, cx + nw / 2, yNombre + 5);

  // Cuerpo + fecha (16pt, como el pptx). Debe caber sobre firma/sello (empiezan ~413pt).
  doc.setFontSize(16);
  const cuerpo = `${t.run1} ${t.run2}`;
  const lineas = doc.splitTextToSize(cuerpo, 620);
  const yBody = 296;
  doc.text(lineas, cx, yBody, { align: "center", lineHeightFactor: 1.3 });

  const fechaTxt = `${t.run3}${t.run4}`;
  const fechaLineas = doc.splitTextToSize(fechaTxt, 620);
  const yFecha = yBody + lineas.length * 16 * 1.3 + 6;
  doc.text(fechaLineas, cx, yFecha, { align: "center", lineHeightFactor: 1.3 });

  // QR de verificación en la esquina superior izquierda
  const qr = await _certQRDataURL(s, opts, t);
  if (qr) {
    doc.addImage(qr, "PNG", 40, 34, 88, 88);
    doc.setFont("times", "normal"); doc.setFontSize(7); doc.setTextColor(90, 90, 90);
    doc.text("Verificar autenticidad", 84, 134, { align: "center" });
  }

  const safe = nombre.replace(/[^a-z0-9]+/gi, "_");
  doc.save(`Certificado_${safe}.pdf`);
}

// Genera el certificado en PowerPoint editando la plantilla .pptx real (JSZip):
// rellena el nombre y el cuerpo, y pasa la tipografía a Times New Roman.
const _certXmlEsc = v => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
async function generarCertificadoPPTX(studentId, opts) {
  const s = getStudent(studentId);
  if (!s) return;
  try { await loadScript("https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"); }
  catch { toast("No se pudo cargar el generador de PowerPoint."); return; }
  if (!window.JSZip) { toast("No se pudo cargar el generador de PowerPoint."); return; }

  let buf;
  try {
    const r = await fetch("/cert-template.pptx");
    if (!r.ok) throw new Error("plantilla");
    buf = await r.arrayBuffer();
  } catch { toast("No se pudo cargar la plantilla del certificado."); return; }

  const t = _certTextos(s, opts);
  const zip = await window.JSZip.loadAsync(buf);
  const slidePath = "ppt/slides/slide1.xml";
  let xml = await zip.file(slidePath).async("string");

  // Nombre: el cuadro está vacío (solo endParaRPr). Se inyecta el run con el nombre.
  const NAME_EMPTY = '<a:p><a:pPr algn="ctr"><a:defRPr></a:defRPr></a:pPr><a:endParaRPr lang="es-PY" sz="4000" u="sng"><a:latin typeface="Calisto MT"></a:latin><a:ea typeface="Cambria"></a:ea></a:endParaRPr></a:p>';
  const NAME_FILLED = `<a:p><a:pPr algn="ctr"><a:defRPr></a:defRPr></a:pPr><a:r><a:rPr lang="es-PY" sz="4000" u="sng"><a:latin typeface="Calisto MT"></a:latin><a:ea typeface="Cambria"></a:ea></a:rPr><a:t>${_certXmlEsc(t.nombre)}</a:t></a:r></a:p>`;
  xml = xml.replace(NAME_EMPTY, NAME_FILLED);

  // Cuerpo: reemplazar los 4 textos con huecos por su versión completa.
  const repl = [
    ["Ha completado satisfactoriamente un programa especial de  horas cátedras de instrucción", t.run1],
    ["en Herramientas ", t.run2],
    ["Recibido en Asunción, Paraguay,  días ", t.run3],
    ["del mes de  del Año .", t.run4],
  ];
  for (const [oldT, newT] of repl) {
    xml = xml.replace(`<a:t>${oldT}</a:t>`, `<a:t>${_certXmlEsc(newT)}</a:t>`);
  }

  // Tipografía → Times New Roman (nombre, "Certificamos que:" y cuerpo).
  xml = xml.split('typeface="Calisto MT"').join('typeface="Times New Roman"')
           .split('typeface="Cambria"').join('typeface="Times New Roman"');

  // QR de verificación en la esquina superior izquierda (imagen + relación + shape).
  const qr = await _certQRDataURL(s, opts, t);
  if (qr && qr.startsWith("data:image/png")) {
    const qrB64 = qr.split(",")[1];
    zip.file("ppt/media/imageQR.png", qrB64, { base64: true });
    const relsPath = "ppt/slides/_rels/slide1.xml.rels";
    let rels = await zip.file(relsPath).async("string");
    rels = rels.replace("</Relationships>",
      '<Relationship Id="rId100" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/imageQR.png"/></Relationships>');
    zip.file(relsPath, rels);
    const pic = '<p:pic><p:nvPicPr><p:cNvPr id="9100" name="QR Verificacion"></p:cNvPr><p:cNvPicPr></p:cNvPicPr><p:nvPr></p:nvPr></p:nvPicPr><p:blipFill><a:blip r:embed="rId100"></a:blip><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="620000" y="360000"/><a:ext cx="900000" cy="900000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>';
    xml = xml.replace("</p:spTree>", pic + "</p:spTree>");
  }

  zip.file(slidePath, xml);
  const blob = await zip.generateAsync({
    type: "blob",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `Certificado_${t.nombre.replace(/[^a-z0-9]+/gi, "_")}.pptx`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  toast("Certificado PowerPoint descargado.");
}

// ====== PDF Export ======
async function downloadPDF(studentId, opts) {
  if (!opts) opts = { incluirPagos: true, incluirAsistencia: true };

  const jsPDF = await _getJsPDF(); if (!jsPDF) return;

  const s = getStudent(studentId);
  if (!s) return;

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const W = 210, M = 14;

  function sectionDivider(title) {
    if (y > 260) { doc.addPage(); y = 20; }
    y += 6;
    doc.setDrawColor(226, 232, 240);
    doc.line(M, y, W - M, y);
    y += 7;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(15, 23, 42);
    doc.text(title, M, y);
    y += 7;
  }

  // ── Header ──
  doc.setFillColor(30, 58, 95);
  doc.rect(0, 0, W, 32, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(20);
  doc.setTextColor(255, 255, 255);
  doc.text(">> KEYNES", M, 14);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  doc.setTextColor(180, 210, 255);
  doc.text("EDUCATION & TECHNOLOGY  |  ESTUDIOS SUPERIORES", M, 20);
  doc.setFontSize(9);
  doc.setTextColor(255, 255, 255);
  doc.text("Informe del Alumno", M, 27);
  doc.setFontSize(8);
  doc.setTextColor(180, 210, 255);
  doc.text(`Generado: ${new Date().toLocaleDateString("es-PY")}`, W - M, 27, { align: "right" });

  let y = 42;

  // ── Student info ──
  doc.setTextColor(15, 23, 42);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.text(`${s.name} ${s.surname}`, M, y);
  y += 7;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(71, 85, 105);
  doc.text(`Teléfono: ${s.phone}`, M, y);
  if (s.email) { doc.text(`   Email: ${s.email}`, M + 40, y); }
  y += 5;
  if (s.modality) {
    const modalLabel = s.modality.charAt(0).toUpperCase() + s.modality.slice(1);
    doc.text(`Modalidad: ${modalLabel}`, M, y);
    y += 5;
  }
  if (s.contact2Name) {
    doc.text(`Contacto adicional: ${s.contact2Name}${s.contact2Relation ? " (" + s.contact2Relation + ")" : ""} — ${s.contact2Phone}`, M, y);
    y += 5;
  }

  // ── 1. PLANILLA DE ASISTENCIA (general, una sola vez) ──
  if (opts.incluirAsistencia) {
    sectionDivider("Planilla de Asistencia");
    const attend = s.attendance || [];
    if (attend.length === 0) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.setTextColor(120, 120, 120);
      doc.text("Sin registros de asistencia.", M, y);
      y += 6;
    } else {
      const sortedAtt = [...attend].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
      const cAFecha = M, cAEstado = M + 32, cAHoras = M + 76;
      doc.setFillColor(241, 245, 249);
      doc.rect(M, y, W - M * 2, 7, "F");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8);
      doc.setTextColor(100, 116, 139);
      doc.text("FECHA", cAFecha + 1, y + 5);
      doc.text("ESTADO", cAEstado + 1, y + 5);
      doc.text("HORAS", cAHoras + 1, y + 5);
      y += 7;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8.5);
      sortedAtt.forEach((a, i) => {
        if (y > 272) { doc.addPage(); y = 20; }
        if (i % 2 === 1) {
          doc.setFillColor(249, 250, 252);
          doc.rect(M, y, W - M * 2, 6.5, "F");
        }
        doc.setTextColor(30, 30, 30);
        doc.text(fmtDate(a.date), cAFecha + 1, y + 4.5);
        if (a.present) {
          doc.setTextColor(21, 128, 61);
          doc.text("Presente (P)", cAEstado + 1, y + 4.5);
        } else {
          doc.setTextColor(185, 28, 28);
          doc.text("Ausente (A)", cAEstado + 1, y + 4.5);
        }
        doc.setTextColor(30, 30, 30);
        doc.text((a.hours != null && a.hours !== '') ? String(a.hours) + " hs" : "—", cAHoras + 1, y + 4.5);
        doc.setDrawColor(230, 230, 230);
        doc.line(M, y + 6.5, W - M, y + 6.5);
        y += 6.5;
      });
      y += 4;
      const attPres = attend.filter(a => a.present).length;
      const attAus  = attend.filter(a => !a.present).length;
      const attHrs  = attend.reduce((sum, a) => sum + (parseFloat(a.hours) || 0), 0);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8.5);
      doc.setTextColor(71, 85, 105);
      doc.text(`Presentes: ${attPres}   Ausentes: ${attAus}   Total horas: ${attHrs} hs`, M, y);
      y += 5;
    }
  }

  // ── 2. SECCIONES POR CURSO ──
  const enrollsToRender = (opts.selectedEnrollments && opts.selectedEnrollments.length > 0)
    ? opts.selectedEnrollments
    : (s.enrollments || []).map((_, idx) => ({ idx }));

  enrollsToRender.forEach(sel => {
    const enr = s.enrollments[sel.idx];
    if (!enr) return;
    const course = getCourse(enr.courseId);
    if (!course) return;

    const tutors      = sel.tutors      !== undefined ? sel.tutors      : (enr.tutors || []);
    const startDate   = sel.startDate   || enr.startDate   || '';
    const estimatedEnd = sel.estimatedEnd || enr.estimatedEnd || '';

    if (!opts.soloAsistencia) {
      // Encabezado del curso
      if (y > 258) { doc.addPage(); y = 20; }
      y += 5;
      doc.setDrawColor(226, 232, 240);
      doc.line(M, y, W - M, y);
      y += 6;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(12);
      doc.setTextColor(15, 23, 42);
      doc.text(course.name, M, y);
      y += 6;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9.5);
      doc.setTextColor(71, 85, 105);
      const infoLine = [
        `Inicio: ${fmtDate(startDate)}`,
        `Fin estimado: ${fmtDate(estimatedEnd)}`,
        `Tutor(es): ${tutors.join(", ") || "—"}`,
      ].join("    ");
      doc.text(infoLine, M, y);
      y += 5;
      doc.text(`Contenido Dado: ${enr.classes.length}`, M, y);
      y += 2;

      // Desarrollo Temático
      sectionDivider("Desarrollo Temático");
      const cFecha = M, cTema = M + 26, cProf = M + 112, cObs = M + 140;
      doc.setFillColor(241, 245, 249);
      doc.rect(M, y, W - M * 2, 7, "F");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8);
      doc.setTextColor(100, 116, 139);
      doc.text("FECHA", cFecha + 1, y + 5);
      doc.text("DESARROLLO TEMÁTICO", cTema + 1, y + 5);
      doc.text("PROFESOR", cProf + 1, y + 5);
      doc.text("OBS.", cObs + 1, y + 5);
      y += 7;

      const rows = course.topics.length > 0
        ? course.topics.map(topic => {
            const cl = enr.classes.find(c => c.topic === topic);
            return cl ? { ...cl } : { date: "", topic, professor: "", observations: "" };
          })
        : enr.classes;

      doc.setFont("helvetica", "normal");
      doc.setFontSize(8.5);
      const obsW  = W - M - cObs - 2;
      const temaW = cProf - cTema - 2;
      const profW = cObs  - cProf - 2;
      const lineH = 5;
      rows.forEach((cl, i) => {
        const obsLines  = doc.splitTextToSize(cl.observations || "", obsW);
        const temaLines = doc.splitTextToSize(cl.topic        || "", temaW);
        const profLines = doc.splitTextToSize(cl.professor    || "—", profW);
        const cellH = Math.max(6.5, Math.max(obsLines.length, temaLines.length, profLines.length) * lineH + 2);

        if (y + cellH > 272) { doc.addPage(); y = 20; }
        if (i % 2 === 1) {
          doc.setFillColor(249, 250, 252);
          doc.rect(M, y, W - M * 2, cellH, "F");
        }
        const isBlank = !cl.date;
        doc.setTextColor(isBlank ? 180 : 30, isBlank ? 180 : 30, isBlank ? 180 : 30);
        doc.text(cl.date ? fmtDate(cl.date) : "—", cFecha + 1, y + 4.5);
        temaLines.forEach((line, li) => doc.text(line, cTema + 1, y + 4.5 + li * lineH));
        profLines.forEach((line, li) => doc.text(line, cProf + 1, y + 4.5 + li * lineH));
        obsLines.forEach( (line, li) => doc.text(line, cObs  + 1, y + 4.5 + li * lineH));
        doc.setDrawColor(230, 230, 230);
        doc.line(M, y + cellH, W - M, y + cellH);
        y += cellH;
      });
    } // end !soloAsistencia (desarrollo temático)
  });

  // ── Registro de Pagos (unificado por alumno) — solo admin ──
  if (isAdmin() && opts.incluirPagos && !opts.soloAsistencia) {
    const pay = s.payment || { type: 'mensual', amount: 0, packageHours: null };
    const payments = s.payments || [];
    sectionDivider("Registro de Pagos");
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(71, 85, 105);
    const paid = payments.filter(p => p.paid).reduce((a, p) => a + p.amount, 0);
    const pend = payments.filter(p => !p.paid).reduce((a, p) => a + p.amount, 0);
    const payLine = pay.type === "paquete" && pay.packageHours
      ? `Paquete (${pay.packageHours} hs/sem.)   Cuota: ${fmt(pay.amount)}`
      : `Modalidad: ${payTypeLabel(pay.type)}   Monto: ${fmt(pay.amount)}`;
    doc.text(payLine, M, y); y += 5;
    doc.text(`Total pagado: ${fmt(paid)}   Total pendiente: ${fmt(pend)}`, M, y); y += 5;
    if (payments.length > 0) {
      y += 2;
      const cPFecha = M, cPConc = M + 25, cPMon = M + 110, cPEst = M + 140;
      doc.setFillColor(241, 245, 249);
      doc.rect(M, y, W - M * 2, 7, "F");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8);
      doc.setTextColor(100, 116, 139);
      doc.text("FECHA", cPFecha + 1, y + 5);
      doc.text("CONCEPTO", cPConc + 1, y + 5);
      doc.text("MONTO", cPMon + 1, y + 5);
      doc.text("ESTADO", cPEst + 1, y + 5);
      y += 7;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8.5);
      payments.forEach((p, i) => {
        if (y > 272) { doc.addPage(); y = 20; }
        if (i % 2 === 1) {
          doc.setFillColor(249, 250, 252);
          doc.rect(M, y, W - M * 2, 6.5, "F");
        }
        doc.setTextColor(30, 30, 30);
        doc.text(fmtDate(p.date), cPFecha + 1, y + 4.5);
        doc.text(doc.splitTextToSize(p.concept || "", 80)[0], cPConc + 1, y + 4.5);
        doc.text(fmt(p.amount), cPMon + 1, y + 4.5);
        if (p.paid) { doc.setTextColor(21, 128, 61); doc.text("Pagado", cPEst + 1, y + 4.5); }
        else { doc.setTextColor(185, 28, 28); doc.text("Pendiente", cPEst + 1, y + 4.5); }
        doc.setDrawColor(230, 230, 230);
        doc.line(M, y + 6.5, W - M, y + 6.5);
        y += 6.5;
      });
    }
  }

  // ── Características del alumno ──
  if (opts.incluirCaracteristicas && s.caracteristicas) {
    sectionDivider("Características del Alumno");
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(30, 30, 30);
    const carLines = doc.splitTextToSize(s.caracteristicas, W - M * 2);
    carLines.forEach(line => {
      if (y > 272) { doc.addPage(); y = 20; }
      doc.text(line, M, y);
      y += 6;
    });
  }

  // ── Observaciones generales ──
  if (opts.observaciones) {
    sectionDivider("Observaciones Generales");
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(30, 30, 30);
    const obsLines = doc.splitTextToSize(opts.observaciones, W - M * 2);
    obsLines.forEach(line => {
      if (y > 272) { doc.addPage(); y = 20; }
      doc.text(line, M, y);
      y += 6;
    });
  }

  // ── Footer ──
  doc.setFontSize(7.5);
  doc.setTextColor(148, 163, 184);
  doc.text("Keynes Education & Technology — Sistema de Gestión Interno", M, 290);

  const renderedCourseNames = (opts.selectedEnrollments && opts.selectedEnrollments.length > 0
    ? opts.selectedEnrollments
    : (s.enrollments || []).map((_, idx) => ({ idx }))
  ).map(sel => { const enr = s.enrollments[sel.idx]; const c = enr ? getCourse(enr.courseId) : null; return c ? c.name : ''; }).filter(Boolean);
  const filenameSuffix = renderedCourseNames.length === 1 ? '_' + renderedCourseNames[0] : renderedCourseNames.length > 1 ? '_Varios_Cursos' : '';
  const filename = `Keynes_${s.name}_${s.surname}${filenameSuffix}.pdf`.replace(/\s+/g, "_");
  doc.save(filename);
  toast("PDF descargado correctamente.");
}

// ====== Vista: Empresa Detalle ======
function viewEmpresaDetalle() {
  const c = getCompany(state.currentCompanyId);
  if (!c) { go("empresas"); return ""; }

  const companyStudents = STUDENTS.filter(s => s.empresaId === c.id);
  const color = colorFor(c.id);
  let tab = state.empresaTab;
  if (tab === "pagos" && !isAdmin()) tab = "alumnos";   // pagos solo para admin

  // ── Tab: Alumnos ──
  let tabContent = "";
  if (tab === "alumnos") {
    const studentRows = companyStudents.map(s => {
      const sColor = colorFor(s.id);
      const ini = initials(s.name, s.surname);
      const tags = s.enrollments.map(e => {
        const course = getCourse(e.courseId);
        return course ? `<span class="course-tag">${esc(course.name)}</span>` : "";
      }).join("");
      const statusBadge = estadoBadge(s);
      const attend = s.attendance || [];
      const totPres = attend.filter(a => a.present).length;
      const totAus  = attend.filter(a => !a.present).length;
      const totHrs  = attend.reduce((sum, a) => sum + (parseFloat(a.hours) || 0), 0);
      return `
      <div class="t-row" style="align-items:center">
        <div class="t-student">
          <div class="t-avatar" style="background:${sColor}">${ini}</div>
          <div>
            <div class="name">${esc(s.name)} ${esc(s.surname)}</div>
            <div class="mail">${esc(s.phone)}${s.email ? " · " + esc(s.email) : ""}</div>
          </div>
        </div>
        <div class="t-courses">${tags || '<span class="no-course">Sin cursos</span>'} ${statusBadge}</div>
        <div style="display:flex;gap:6px;align-items:center;font-size:12px;color:var(--ink-3)">
          <span class="attend-badge present" style="font-size:11px">${totPres} P</span>
          <span class="attend-badge absent" style="font-size:11px">${totAus} A</span>
          <span style="margin-left:2px">${totHrs} hs</span>
        </div>
        <div class="t-actions">
          <button class="btn btn-ghost btn-sm" data-open="${s.id}">Ver Perfil</button>
          <button class="btn btn-ghost btn-sm" data-add-attend-gen="${s.id}">+ Asistencia</button>
        </div>
      </div>`;
    }).join("");

    tabContent = `
    <div class="section-card">
      <div class="section-head">
        <h3>Alumnos (${companyStudents.length})</h3>
        <button class="btn btn-primary btn-sm" data-clase-grupo="${c.id}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:14px;height:14px;margin-right:4px;vertical-align:-2px"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Registrar Clase para el Grupo
        </button>
      </div>
      ${companyStudents.length ? `
      <div class="table-card" style="margin-top:0;box-shadow:none;border:none">
        <div class="t-head">
          <div>Alumno</div>
          <div>Cursos</div>
          <div>Asistencia</div>
          <div class="right">Acciones</div>
        </div>
        ${studentRows}
      </div>` : '<div class="empty-sm">No hay alumnos asociados a esta empresa.</div>'}
    </div>`;

  // ── Tab: Pagos ──
  } else if (tab === "pagos") {
    const allPayments = [];
    // Todos los pagos de la empresa (generales y por alumno)
    (c.pagosEmpresa || []).forEach(p => {
      const student = p.studentId ? getStudent(p.studentId) : null;
      allPayments.push({ student, course: null, payment: p, general: !p.studentId });
    });
    allPayments.sort((a, b) => (b.payment.date || "").localeCompare(a.payment.date || ""));

    const totalPaid = allPayments.filter(x => x.payment.paid).reduce((sum, x) => sum + x.payment.amount, 0);
    const totalPend = allPayments.filter(x => !x.payment.paid).reduce((sum, x) => sum + x.payment.amount, 0);

    const payRows = allPayments.map(({ student, course, payment, general }) => `
    <tr>
      <td style="font-weight:500">${student ? `${esc(student.name)} ${esc(student.surname)}` : `<span style="color:var(--ink-3);font-style:italic">General</span>`}</td>
      <td>${esc(course ? course.name : "—")}</td>
      <td>${fmtDate(payment.date)}</td>
      <td>${esc(payment.concept)}</td>
      <td>${fmt(payment.amount)}</td>
      <td><span class="pay-badge ${payment.paid ? "paid" : "unpaid"}">${payment.paid ? "Pagado" : "Pendiente"}</span></td>
      <td style="display:flex;gap:4px;align-items:center;justify-content:flex-end">
        ${!payment.paid ? `<button class="btn-outline" data-mark-paid-emp="${c.id}" data-pay-id="${payment.id}">Marcar pagado</button>` : ""}
        <button class="btn-icon" data-edit-pay-emp="${c.id}" data-pay-id="${payment.id}" title="Editar">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="btn-icon danger" data-del-pay-emp="${c.id}" data-pay-id="${payment.id}" title="Eliminar">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </td>
    </tr>`).join("");

    tabContent = `
    <div class="section-card">
      <div class="section-head">
        <h3>Resumen de Pagos</h3>
        <button class="btn btn-primary btn-sm" data-add-pago-empresa="${c.id}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:14px;height:14px;margin-right:4px;vertical-align:-2px"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Registrar Pago
        </button>
      </div>
      <div class="pay-summary">
        <div class="pay-stat green"><div class="k">Total pagado</div><div class="val">${fmt(totalPaid)}</div></div>
        <div class="pay-stat amber"><div class="k">Total pendiente</div><div class="val">${fmt(totalPend)}</div></div>
        <div class="pay-stat"><div class="k">Registros</div><div class="val">${allPayments.length}</div></div>
      </div>
      ${allPayments.length ? `
      <div class="class-table-wrap">
        <table class="class-table">
          <thead><tr><th>Alumno</th><th>Curso</th><th>Fecha</th><th>Concepto</th><th>Monto</th><th>Estado</th><th class="right">Acciones</th></tr></thead>
          <tbody>${payRows}</tbody>
        </table>
      </div>` : '<div class="empty-sm">No hay pagos registrados para esta empresa.</div>'}
    </div>`;
  }

  return `
  <div class="crumbs"><a href="#" data-go="empresas">← Empresas</a> › <b>${esc(c.name)}</b></div>

  <div class="profile-hero">
    <div class="profile-avatar" style="background:${color};display:flex;align-items:center;justify-content:center">
      <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.8" style="width:38px;height:38px"><path d="M3 21h18"/><rect x="5" y="3" width="14" height="18" rx="1"/><rect x="9" y="8" width="2" height="2"/><rect x="13" y="8" width="2" height="2"/><rect x="9" y="13" width="2" height="2"/><rect x="13" y="13" width="2" height="2"/><path d="M9 21v-4h6v4"/></svg>
    </div>
    <div class="profile-info">
      <h2>${esc(c.name)}</h2>
      <div class="profile-meta">
        ${c.modality ? `<span class="modality-badge modality-${c.modality}">${c.modality === "presencial" ? "Presencial" : "Virtual"}</span>` : ""}
        ${c.ruc ? `<span>RUC: ${esc(c.ruc)}</span>` : ""}
        ${c.phone ? `<span>${esc(c.phone)}</span>` : ""}
        ${c.email ? `<span>${esc(c.email)}</span>` : ""}
        ${c.address ? `<span>${esc(c.address)}</span>` : ""}
        ${c.diasClase?.length ? `<span>Días: <b>${c.diasClase.join(" · ")}</b></span>` : ""}
        ${c.horario ? `<span>Horario: <b>${esc(c.horario)}</b></span>` : ""}
        ${c.contactName ? `<span>Contacto: <b>${esc(c.contactName)}</b>${c.contactRole ? " (" + c.contactRole + ")" : ""}${c.contactPhone ? " — " + c.contactPhone : ""}</span>` : ""}
      </div>
    </div>
    <div class="profile-btns">
      <button class="btn btn-ghost btn-sm" data-download-pdf-empresa="${c.id}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Descargar PDF
      </button>
      <button class="btn btn-ghost btn-sm" data-informe-empresa="${c.id}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        Copiar Informe
      </button>
      ${isAdmin() ? `<button class="btn btn-ghost btn-sm" data-edit-empresa="${c.id}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        Editar
      </button>` : ""}
    </div>
  </div>

  <div class="course-tabs">
    <button class="course-tab ${tab === "alumnos" ? "active" : ""}" data-empresa-tab="alumnos">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:13px;height:13px;margin-right:4px;vertical-align:-2px"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
      Alumnos (${companyStudents.length})
    </button>
    ${isAdmin() ? `<button class="course-tab ${tab === "pagos" ? "active" : ""}" data-empresa-tab="pagos">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:13px;height:13px;margin-right:4px;vertical-align:-2px"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>
      Pagos
    </button>` : ""}
  </div>

  ${tabContent}`;
}

// ====== Modal: Registrar Clase para el Grupo ======
function modalRegistrarClaseGrupo(empresaId) {
  const c = getCompany(empresaId);
  if (!c) return;
  const companyStudents = STUDENTS.filter(s => s.empresaId === empresaId);
  if (companyStudents.length === 0) { toast("No hay alumnos en esta empresa."); return; }

  const today = new Date().toISOString().split("T")[0];

  const courseSet = new Set();
  companyStudents.forEach(s => s.enrollments.forEach(e => courseSet.add(e.courseId)));
  const availCourses = [...courseSet].map(id => getCourse(id)).filter(Boolean);
  const courseOpts = availCourses.map(co => `<option value="${co.id}">${esc(co.name)}</option>`).join("");

  const studentCheckboxes = companyStudents.map(s => {
    const courseIds = s.enrollments.map(e => e.courseId).join(",");
    return `
    <div class="student-check-row" data-student-id="${s.id}" data-courses="${courseIds}">
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13.5px;padding:4px 0">
        <input type="checkbox" class="student-select-chk" name="studentIds" value="${s.id}" checked style="width:15px;height:15px;flex-shrink:0">
        <span style="font-weight:500">${esc(s.name)} ${esc(s.surname)}</span>
        <span style="font-size:11px;color:var(--ink-3)">${esc(s.enrollments.map(e => getCourse(e.courseId)?.name).filter(Boolean).join(", "))}</span>
      </label>
    </div>`;
  }).join("");

  openModal(`
  <div class="modal-head">
    <h3>Registrar Clase para el Grupo</h3>
    <button class="modal-close" data-modal-close>&times;</button>
  </div>
  <form id="claseGrupoForm" data-empresa="${empresaId}">
    <div class="field"><label>Curso *</label>
      <div class="select-wrap">
        <select name="courseId" id="claseGrupoCurso" required>
          <option value="">— Seleccionar curso —</option>
          ${courseOpts}
        </select>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
    </div>
    <div class="field">
      <label>Alumnos a incluir</label>
      <div style="display:flex;gap:8px;margin-bottom:8px">
        <button type="button" class="btn btn-ghost btn-sm" id="claseGrupoSelAll">Todos</button>
        <button type="button" class="btn btn-ghost btn-sm" id="claseGrupoDeselAll">Ninguno</button>
      </div>
      <div id="claseGrupoStudentList" style="border:1px solid var(--line);border-radius:10px;padding:8px 12px;max-height:180px;overflow-y:auto">
        ${studentCheckboxes}
      </div>
    </div>
    <div class="field"><label>Fecha *</label><input type="date" name="date" required value="${today}" id="claseGrupoDate"></div>
    <div class="grid-2">
      <div class="field"><label>Hora inicio</label><input type="time" name="startTime" id="claseGrupoStart"></div>
      <div class="field"><label>Hora fin</label><input type="time" name="endTime" id="claseGrupoEnd"></div>
    </div>
    <div class="field"><label>Modalidad</label>
      <div class="select-wrap">
        <select name="modality">
          <option value="">— Sin especificar —</option>
          <option value="Virtual">Virtual</option>
          <option value="Presencial">Presencial</option>
        </select>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
    </div>
    <div class="field"><label>Desarrollo Temático *</label><input name="topic" id="claseGrupoTopic" required placeholder="Tema de la clase"></div>
    <div id="grupoTopicList" style="margin-top:-8px;margin-bottom:12px;border:1px solid var(--line);border-radius:10px;padding:6px 8px;max-height:200px;overflow-y:auto;display:none;font-size:12.5px"></div>
    <div class="field"><label>Profesor *</label><input name="professor" required placeholder="Nombre del profesor"></div>
    <div class="field"><label>Observaciones <span class="optional">(una por línea)</span></label><textarea name="observations" rows="2"></textarea></div>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" data-modal-close>Cancelar</button>
      <button type="submit" class="btn btn-primary">Registrar Clase</button>
    </div>
  </form>`);

  const cursoSelect = document.getElementById("claseGrupoCurso");
  const topicInput  = document.getElementById("claseGrupoTopic");

  function updateTopicList() {
    const selCourse = cursoSelect.value;
    const listEl = document.getElementById("grupoTopicList");
    if (!listEl) return;
    if (!selCourse) { listEl.style.display = "none"; listEl.innerHTML = ""; return; }
    const course = getCourse(selCourse);
    if (!course || !course.topics || course.topics.length === 0) {
      listEl.style.display = "none"; listEl.innerHTML = ""; return;
    }

    const checkedIds = [...document.querySelectorAll("#claseGrupoStudentList .student-select-chk:checked")].map(c => c.value);
    const studentsInCourse = checkedIds
      .map(id => getStudent(id))
      .filter(s => s && s.enrollments.some(e => e.courseId === selCourse));
    const total = studentsInCourse.length;
    const studentCovered = studentsInCourse.map(s => {
      const enr = s.enrollments.find(e => e.courseId === selCourse);
      return new Set((enr?.classes || []).map(cl => cl.topic));
    });

    let nextFound = false;
    const items = course.topics.map((topic, idx) => {
      const covCount = studentCovered.filter(set => set.has(topic)).length;
      let status;
      if (covCount === 0 || total === 0) {
        status = nextFound ? "pending" : "next";
        if (!nextFound) nextFound = true;
      } else if (covCount >= total) {
        status = "done";
      } else {
        status = "partial";
      }
      return { topic, status, covCount, idx };
    });

    listEl.innerHTML = `
      <div style="font-size:11px;font-weight:600;color:var(--ink-3);text-transform:uppercase;letter-spacing:.05em;padding:2px 4px 6px">
        Temas del curso — clic para seleccionar
      </div>
      ${items.map(({ topic, status, covCount, idx }) => {
        const bg  = status === "done" ? "rgba(34,197,94,.08)" : status === "partial" ? "rgba(245,158,11,.08)" : status === "next" ? "rgba(59,130,246,.08)" : "";
        const col = status === "done" ? "#22c55e" : status === "partial" ? "#f59e0b" : status === "next" ? "var(--accent)" : "var(--ink-3)";
        const icon = status === "done" ? "✓" : status === "partial" ? `${covCount}/${total}` : status === "next" ? "→" : "";
        const fw  = status === "next" ? "600" : "400";
        return `<div class="topic-pick-item" data-idx="${idx}"
          style="display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:6px;cursor:pointer;background:${bg};margin-bottom:1px">
          <span style="width:34px;font-size:11px;font-weight:700;color:${col};flex-shrink:0;text-align:center">${icon}</span>
          <span style="font-size:12.5px;color:${status === "next" ? col : "inherit"};font-weight:${fw}">${esc(topic)}</span>
        </div>`;
      }).join("")}`;

    listEl.style.display = "";
    listEl.querySelectorAll(".topic-pick-item").forEach(el => {
      el.addEventListener("click", () => {
        const idx = parseInt(el.dataset.idx, 10);
        topicInput.value = course.topics[idx];
        listEl.querySelectorAll(".topic-pick-item").forEach(i => i.style.outline = "");
        el.style.outline = "2px solid var(--accent)";
      });
    });
  }

  function updateStudentListByCourse() {
    const selCourse = cursoSelect.value;
    document.querySelectorAll(".student-check-row").forEach(row => {
      const courses = (row.dataset.courses || "").split(",");
      const visible = !selCourse || courses.includes(selCourse);
      row.style.display = visible ? "" : "none";
      const chk = row.querySelector(".student-select-chk");
      if (chk && !visible) chk.checked = false;
      if (chk && visible)  chk.checked = true;
    });
    if (selCourse && !topicInput.value.trim()) {
      const course = getCourse(selCourse);
      if (course && course.topics.length > 0) {
        const firstS = companyStudents.find(s => s.enrollments.some(e => e.courseId === selCourse));
        if (firstS) {
          const enr = firstS.enrollments.find(e => e.courseId === selCourse);
          if (enr) {
            const covered = new Set((enr.classes || []).map(cl => cl.topic));
            const next = course.topics.find(t => !covered.has(t));
            if (next) topicInput.value = next;
          }
        }
      }
    }
    updateTopicList();
  }

  function prefillFromDate(date) {
    const courseId = cursoSelect.value;
    if (!date || !courseId) return;
    const checkedIds = [...document.querySelectorAll("#claseGrupoStudentList .student-select-chk:checked")].map(c => c.value);
    let foundModality = "", foundProfessor = "", foundStart = "", foundEnd = "";
    for (const sid of checkedIds) {
      const s = getStudent(sid);
      if (!s) continue;
      const enr = s.enrollments.find(e => e.courseId === courseId);
      if (!enr) continue;
      const cl = (enr.classes || []).find(c => c.date === date);
      if (!cl) continue;
      if (!foundModality  && cl.modality)   foundModality  = cl.modality;
      if (!foundProfessor && cl.professor)  foundProfessor = cl.professor;
      if (!foundStart     && cl.startTime)  foundStart     = cl.startTime;
      if (!foundEnd       && cl.endTime)    foundEnd       = cl.endTime;
      if (foundModality && foundProfessor && foundStart && foundEnd) break;
    }
    const modalityEl = modalBox.querySelector('[name="modality"]');
    const profEl     = modalBox.querySelector('[name="professor"]');
    const startEl    = document.getElementById("claseGrupoStart");
    const endEl      = document.getElementById("claseGrupoEnd");
    if (modalityEl && foundModality)  modalityEl.value = foundModality;
    if (profEl     && foundProfessor && !profEl.value.trim()) profEl.value = foundProfessor;
    if (startEl    && foundStart)     startEl.value    = foundStart;
    if (endEl      && foundEnd)       endEl.value      = foundEnd;
  }

  const dateGrupoEl = document.getElementById("claseGrupoDate");
  if (dateGrupoEl) {
    dateGrupoEl.addEventListener("change", () => prefillFromDate(dateGrupoEl.value));
  }

  cursoSelect.addEventListener("change", () => { topicInput.value = ""; updateStudentListByCourse(); prefillFromDate(dateGrupoEl?.value); });

  document.getElementById("claseGrupoStudentList")?.addEventListener("change", e => {
    if (e.target.classList.contains("student-select-chk")) updateTopicList();
  });

  document.getElementById("claseGrupoSelAll")?.addEventListener("click", () => {
    document.querySelectorAll(".student-check-row:not([style*='display: none']) .student-select-chk").forEach(c => c.checked = true);
    updateTopicList();
  });
  document.getElementById("claseGrupoDeselAll")?.addEventListener("click", () => {
    document.querySelectorAll(".student-select-chk").forEach(c => c.checked = false);
    updateTopicList();
  });
}

// ====== Modal: Descargar PDF Empresa ======
function modalDescargarPDFEmpresa(empresaId) {
  const c = getCompany(empresaId);
  if (!c) return;
  const companyStudents = STUDENTS.filter(s => s.empresaId === empresaId);

  const courseSet = new Set();
  companyStudents.forEach(s => s.enrollments.forEach(e => courseSet.add(e.courseId)));
  const availCourses = [...courseSet].map(id => getCourse(id)).filter(Boolean);

  const studentRows = companyStudents.map(s => `
  <div style="border:1px solid var(--line);border-radius:8px;padding:10px 14px;margin-bottom:6px">
    <label style="display:flex;align-items:center;gap:8px;font-weight:500;font-size:13.5px;cursor:pointer">
      <input type="checkbox" class="chk-pdf-student" value="${s.id}" checked style="width:15px;height:15px;flex-shrink:0">
      ${esc(s.name)} ${esc(s.surname)}
      ${s.enrollments.length > 0 ? `<span style="font-size:11px;color:var(--ink-3);font-weight:normal">${esc(s.enrollments.map(e => getCourse(e.courseId)?.name).filter(Boolean).join(", "))}</span>` : ""}
    </label>
  </div>`).join("");

  const courseRows = availCourses.map(co => `
  <div style="margin-bottom:4px">
    <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px">
      <input type="checkbox" class="chk-pdf-course" value="${co.id}" checked style="width:14px;height:14px;flex-shrink:0">
      ${esc(co.name)}
    </label>
  </div>`).join("");

  openModal(`
  <div class="modal-head">
    <h3>Descargar PDF — ${esc(c.name)}</h3>
    <button class="modal-close" data-modal-close>&times;</button>
  </div>
  <p style="font-size:13px;font-weight:600;color:var(--ink-1);margin-bottom:6px">Alumnos a incluir:</p>
  <div style="display:flex;gap:8px;margin-bottom:8px">
    <button type="button" class="btn btn-ghost btn-sm" id="pdfEmpSelAll">Seleccionar todos</button>
    <button type="button" class="btn btn-ghost btn-sm" id="pdfEmpDeselAll">Deseleccionar todos</button>
  </div>
  ${studentRows || '<p style="font-size:13px;color:var(--ink-2)">No hay alumnos en esta empresa.</p>'}
  ${availCourses.length > 1 ? `
  <p style="font-size:13px;font-weight:600;color:var(--ink-1);margin:12px 0 6px">Cursos a incluir:</p>
  <div style="border:1px solid var(--line);border-radius:10px;padding:8px 14px;margin-bottom:10px">${courseRows}</div>` : ""}
  <p style="font-size:13px;font-weight:600;color:var(--ink-1);margin:12px 0 6px">Secciones:</p>
  <div class="field check-field" style="margin-bottom:4px"><label><input type="checkbox" id="chkEmpPdfAsistencia" checked> Planilla de Asistencia</label></div>
  ${isAdmin() ? `<div class="field check-field" style="margin-bottom:4px"><label><input type="checkbox" id="chkEmpPdfPagos" checked> Registro de Pagos</label></div>` : ""}
  <div class="field check-field" style="margin-bottom:4px"><label><input type="checkbox" id="chkEmpPdfCaracteristicas" checked> Características del Alumno</label></div>
  <div class="field check-field" style="margin-top:6px;padding-top:10px;border-top:1px solid var(--line)"><label><input type="checkbox" id="chkEmpPdfSoloAsistencia"> <strong>Solo Planilla de Asistencia</strong> <span style="font-size:12px;color:var(--ink-3);font-weight:normal">— omite el desarrollo temático de los cursos</span></label></div>
  <div class="modal-actions" style="margin-top:12px">
    <button class="btn btn-ghost" data-modal-close>Cancelar</button>
    <button class="btn btn-primary" data-do-pdf-empresa="${empresaId}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      Descargar PDF
    </button>
  </div>`);

  document.getElementById("pdfEmpSelAll")?.addEventListener("click", () => {
    modalBox.querySelectorAll(".chk-pdf-student").forEach(c => c.checked = true);
  });
  document.getElementById("pdfEmpDeselAll")?.addEventListener("click", () => {
    modalBox.querySelectorAll(".chk-pdf-student").forEach(c => c.checked = false);
  });

  document.getElementById("chkEmpPdfSoloAsistencia")?.addEventListener("change", e => {
    if (e.target.checked) modalBox.querySelectorAll(".chk-pdf-course").forEach(c => c.checked = false);
  });
}

// ====== Modal: Registrar Pago Empresa ======
function modalAgregarPagoEmpresa(empresaId) {
  const c = getCompany(empresaId);
  if (!c) return;
  const companyStudents = STUDENTS.filter(s => s.empresaId === empresaId);

  const today = new Date().toISOString().split("T")[0];

  const studentOpts = companyStudents.map(s =>
    `<option value="${s.id}">${esc(s.name)} ${esc(s.surname)}</option>`
  ).join("");

  openModal(`
  <div class="modal-head">
    <h3>Registrar Pago — ${esc(c.name)}</h3>
    <button class="modal-close" data-modal-close>&times;</button>
  </div>
  <form id="pagoEmpresaForm" data-empresa="${empresaId}">
    <div class="field"><label>Alumno <span class="optional">(opcional)</span></label>
      <div class="select-wrap">
        <select name="studentId" id="pagoEmpStudentSel">
          <option value="">— General (sin alumno específico) —</option>
          ${studentOpts}
        </select>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
    </div>
    <div class="field"><label>Fecha *</label><input type="date" name="date" required value="${today}"></div>
    <div class="field"><label>Concepto *</label><input type="text" name="concept" required placeholder="Ej. Cuota Mayo"></div>
    <div class="field"><label>Monto (₲) *</label><input type="number" name="amount" required min="0" placeholder="0"></div>
    <div class="field check-field"><label><input type="checkbox" name="paid" value="1" checked> Marcar como pagado</label></div>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" data-modal-close>Cancelar</button>
      <button type="submit" class="btn btn-primary">Guardar Pago</button>
    </div>
  </form>`);
}

// ====== Modal: Copiar Informe Empresa ======
function modalInformeEmpresa(empresaId) {
  const c = getCompany(empresaId);
  if (!c) return;
  const companyStudents = STUDENTS.filter(s => s.empresaId === empresaId);

  const datesSet = new Set();
  companyStudents.forEach(s => s.enrollments.forEach(e => e.classes.forEach(cl => { if (cl.date) datesSet.add(cl.date); })));
  const dates = [...datesSet].sort().reverse();

  const dateOptions = dates.map(d => `<option value="${d}">${fmtDate(d)}</option>`).join("");

  const studentCheckboxes = companyStudents.map(s => `
  <div>
    <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13.5px;padding:3px 0">
      <input type="checkbox" class="student-informe-chk" value="${s.id}" checked style="width:14px;height:14px">
      <span>${esc(s.name)} ${esc(s.surname)}</span>
    </label>
  </div>`).join("");

  openModal(`
  <div class="modal-head">
    <h3>Copiar Informe — ${esc(c.name)}</h3>
    <button class="modal-close" data-modal-close>&times;</button>
  </div>
  <form id="informeEmpresaForm" data-empresa="${empresaId}">
    <p style="font-size:13.5px;color:var(--ink-2);margin-bottom:16px">Seleccioná la fecha para generar el informe grupal en formato WhatsApp.</p>
    <div class="field"><label>Fecha *</label>
      ${dates.length > 0 ? `
      <div class="select-wrap">
        <select name="date" required>
          <option value="">— Seleccionar fecha —</option>
          ${dateOptions}
        </select>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </div>` : `<input type="date" name="date" required>`}
    </div>
    ${companyStudents.length > 0 ? `
    <div class="field">
      <label>Alumnos a incluir</label>
      <div style="border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin-top:6px;max-height:180px;overflow-y:auto">
        ${studentCheckboxes}
      </div>
    </div>` : ""}
    ${dates.length === 0 ? '<p style="font-size:13px;color:var(--ink-3)">No hay clases registradas aún.</p>' : ""}
    <div class="field" style="margin-top:4px">
      <label>Observaciones <span class="optional">(una por línea, editables)</span></label>
      <textarea id="informeObs" rows="4" placeholder="- Avanzan de buena manera.&#10;- Tienen muchas ganas de aprender."></textarea>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" data-modal-close>Cancelar</button>
      <button type="submit" class="btn btn-primary">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        Copiar Informe
      </button>
    </div>
  </form>`);

  const dateSelectEl = modalBox.querySelector('#informeEmpresaForm select[name="date"], #informeEmpresaForm input[name="date"]');
  const obsEl = document.getElementById("informeObs");

  function prefillObs() {
    if (!obsEl || !dateSelectEl) return;
    const d = dateSelectEl.value;
    if (!d) return;
    const checkedIds = [...modalBox.querySelectorAll(".student-informe-chk:checked")].map(c => c.value);
    const allObs = [];
    const absentNames = [];
    checkedIds.forEach(sid => {
      const s = getStudent(sid);
      if (!s) return;
      let hasClass = false;
      s.enrollments.forEach(enr => {
        (enr.classes || []).filter(cl => cl.date === d).forEach(cl => {
          hasClass = true;
          (cl.observations || "").split("\n").map(l => l.trim()).filter(Boolean)
            .forEach(l => { if (!allObs.includes(l)) allObs.push(l); });
        });
      });
      if (!hasClass) absentNames.push(`${s.name} ${s.surname}`);
    });
    const lines = allObs.map(l => `- ${l}`);
    if (absentNames.length > 0)
      lines.push(`- Tener en cuenta las ausencias de ${absentNames.join(", ")}.`);
    obsEl.value = lines.join("\n");
  }

  if (dateSelectEl) {
    dateSelectEl.addEventListener("change", prefillObs);
    if (dateSelectEl.value) prefillObs();
  }
}

// ====== Builder: Informe Empresa (WhatsApp) ======
function buildInformeEmpresaText(empresaId, date, studentIds, observations) {
  const c = getCompany(empresaId);
  if (!c) return "";
  const students = (studentIds && studentIds.length)
    ? studentIds.map(id => getStudent(id)).filter(Boolean)
    : STUDENTS.filter(s => s.empresaId === empresaId);

  let professorName = "";
  const presentData   = [];  // alumnos con clase en esa fecha
  const absentStudents = []; // alumnos seleccionados sin clase en esa fecha

  students.forEach(s => {
    const allClasses = [];
    s.enrollments.forEach(enr => {
      const course = getCourse(enr.courseId);
      (enr.classes || []).filter(cl => cl.date === date).forEach(cl => {
        allClasses.push({ cl, course, enr });
      });
    });
    if (allClasses.length === 0) {
      absentStudents.push(s);
      return;
    }
    if (!professorName && allClasses[0].cl.professor)
      professorName = allClasses[0].cl.professor.toUpperCase();
    presentData.push({ s, allClasses });
  });

  if (presentData.length === 0) return "";

  // ── Encabezado ──────────────────────────────────────
  let text = `*Informe  ${professorName || "KEYNES"}*\n`;

  // ── Línea de alumnos + ausentes + empresa + cursos + horario ───
  const presentNames = presentData.map(({ s }) => `${esc(s.name)} ${esc(s.surname)}`);
  const presentNamesStr = presentNames.length <= 2
    ? presentNames.join(" y ")
    : presentNames.slice(0, -1).join(", ") + " y " + presentNames[presentNames.length - 1];

  // Ausentes en paréntesis: "(Lucas Caballero ausente)"
  const absentParts = absentStudents.map(s => `(${esc(s.name)} ${esc(s.surname)} ausente)`).join(" ");
  const headerNames = absentParts ? `${presentNamesStr} ${absentParts}` : presentNamesStr;

  const courseNameSet = [];
  presentData.forEach(({ allClasses }) => allClasses.forEach(({ course }) => {
    if (course && !courseNameSet.includes(course.name)) courseNameSet.push(course.name);
  }));
  const courseLine = courseNameSet.join(" + ");

  // Días de la empresa con formato "Lunes, Miércoles y Viernes"
  const compDays = (c.diasClase || []).map(d => d.charAt(0).toUpperCase() + d.slice(1));
  let daysStr = compDays.length > 1
    ? compDays.slice(0, -1).join(", ") + " y " + compDays[compDays.length - 1]
    : compDays[0] || "";

  const anyTime = presentData.flatMap(({ allClasses }) => allClasses).find(i => i.cl.startTime && i.cl.endTime);
  const startTime = anyTime?.cl.startTime || "";
  const endTime   = anyTime?.cl.endTime   || "";
  const modality  = (anyTime?.cl.modality || c.modality || "").toLowerCase();

  const schedParts = [];
  if (daysStr)              schedParts.push(daysStr);
  if (startTime && endTime) schedParts.push(`de ${startTime}hs a ${endTime}hs`);
  if (modality)             schedParts.push(modality);
  const schedStr = schedParts.join(" ");

  text += `*-  ${headerNames} (${c.name}) | ${courseLine}${schedStr ? " " + schedStr : ""}*\n\n`;

  // ── Fechas de la primera inscripción ────────────────
  const firstEnr = presentData[0]?.allClasses[0]?.enr;
  if (firstEnr?.startDate)    text += `*FECHA DE INICIO: ${fmtDate(firstEnr.startDate)}*\n`;
  if (firstEnr?.estimatedEnd) text += `*FECHA DE CULMINACIÓN ESTIMADA: ${fmtDate(firstEnr.estimatedEnd)}*\n`;

  // ── Desarrollo por alumno (solo presentes) ───────────
  text += `\n*Desarrollo:* \n`;
  presentData.forEach(({ s, allClasses }) => {
    const topics = allClasses.map(i => renderTopicText(i.cl.topic)).filter(Boolean).join(". ");
    text += `- ${s.name}: ${topics || "—"}\n`;
  });

  // ── Homework (si existe en alguna clase) ─────────────
  const hwLines = [];
  presentData.forEach(({ allClasses }) => allClasses.forEach(i => {
    if (i.cl.homework?.task) hwLines.push(i.cl.homework.task.trim());
  }));
  if (hwLines.length > 0) text += `\n*HOMEWORK*\n${hwLines.map(l => `- ${l}`).join("\n")}\n`;

  // ── Observaciones (textarea + nota de ausentes automática) ──
  const obsLines = (observations || "")
    .split("\n").map(l => l.trim()).filter(Boolean)
    .map(l => l.startsWith("-") ? l : `- ${l}`);

  if (absentStudents.length > 0) {
    const absentNames = absentStudents.map(s => `${esc(s.name)} ${esc(s.surname)}`).join(", ");
    const absentNote = `- Tener en cuenta las ausencias de ${absentNames}.`;
    if (!obsLines.includes(absentNote)) obsLines.push(absentNote);
  }

  if (obsLines.length > 0) text += `\n*Observaciones:* \n${obsLines.join("\n")}`;

  return text;
}

// ====== PDF: Empresa (multi-alumno) ======
async function downloadPDFEmpresa(empresaId, selectedStudentIds, opts) {
  if (!opts) opts = { incluirAsistencia: true, incluirPagos: true, incluirCaracteristicas: true };

  const jsPDF = await _getJsPDF(); if (!jsPDF) return;

  const c        = getCompany(empresaId);
  const students = (selectedStudentIds || []).map(id => getStudent(id)).filter(Boolean);
  if (students.length === 0) { toast("Seleccioná al menos un alumno."); return; }

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const W = 210, M = 14;
  let y = 42;

  function pageHeader() {
    doc.setFillColor(30, 58, 95);
    doc.rect(0, 0, W, 32, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(20); doc.setTextColor(255, 255, 255);
    doc.text(">> KEYNES", M, 14);
    doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor(180, 210, 255);
    doc.text("EDUCATION & TECHNOLOGY  |  ESTUDIOS SUPERIORES", M, 20);
    doc.setFontSize(9); doc.setTextColor(255, 255, 255);
    doc.text(`Informe Empresa: ${c ? c.name : ""}`, M, 27);
    doc.setFontSize(8); doc.setTextColor(180, 210, 255);
    doc.text(`Generado: ${new Date().toLocaleDateString("es-PY")}`, W - M, 27, { align: "right" });
  }

  function sectionDivider(title) {
    if (y > 260) { doc.addPage(); y = 20; }
    y += 6;
    doc.setDrawColor(226, 232, 240); doc.line(M, y, W - M, y); y += 7;
    doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.setTextColor(15, 23, 42);
    doc.text(title, M, y); y += 7;
  }

  pageHeader();

  students.forEach((s, sIdx) => {
    if (sIdx > 0) { doc.addPage(); pageHeader(); y = 42; }

    // Label alumno
    doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(100, 116, 139);
    doc.text(`Alumno ${sIdx + 1} de ${students.length}`, M, y); y += 5;

    doc.setTextColor(15, 23, 42); doc.setFont("helvetica", "bold"); doc.setFontSize(15);
    doc.text(`${s.name} ${s.surname}`, M, y); y += 7;
    doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.setTextColor(71, 85, 105);
    doc.text(`Teléfono: ${s.phone}`, M, y);
    if (s.email) doc.text(`   Email: ${s.email}`, M + 40, y);
    y += 5;
    if (s.modality) { doc.text(`Modalidad: ${s.modality.charAt(0).toUpperCase() + s.modality.slice(1)}`, M, y); y += 5; }

    // Asistencia
    if (opts.incluirAsistencia) {
      sectionDivider("Planilla de Asistencia");
      const attend = s.attendance || [];
      if (attend.length === 0) {
        doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(120, 120, 120);
        doc.text("Sin registros de asistencia.", M, y); y += 6;
      } else {
        const sorted = [...attend].sort((a, b) => (a.date || "").localeCompare(b.date || ""));
        const cAF = M, cAE = M + 32, cAH = M + 76;
        doc.setFillColor(241, 245, 249); doc.rect(M, y, W - M * 2, 7, "F");
        doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(100, 116, 139);
        doc.text("FECHA", cAF + 1, y + 5); doc.text("ESTADO", cAE + 1, y + 5); doc.text("HORAS", cAH + 1, y + 5);
        y += 7; doc.setFont("helvetica", "normal"); doc.setFontSize(8.5);
        sorted.forEach((a, i) => {
          if (y > 272) { doc.addPage(); y = 20; }
          if (i % 2 === 1) { doc.setFillColor(249, 250, 252); doc.rect(M, y, W - M * 2, 6.5, "F"); }
          doc.setTextColor(30, 30, 30); doc.text(fmtDate(a.date), cAF + 1, y + 4.5);
          if (a.present) { doc.setTextColor(21, 128, 61); doc.text("Presente (P)", cAE + 1, y + 4.5); }
          else { doc.setTextColor(185, 28, 28); doc.text("Ausente (A)", cAE + 1, y + 4.5); }
          doc.setTextColor(30, 30, 30);
          doc.text((a.hours != null && a.hours !== "") ? String(a.hours) + " hs" : "—", cAH + 1, y + 4.5);
          doc.setDrawColor(230, 230, 230); doc.line(M, y + 6.5, W - M, y + 6.5); y += 6.5;
        });
        y += 4;
        const pres = attend.filter(a => a.present).length, aus = attend.filter(a => !a.present).length;
        const hrs  = attend.reduce((sum, a) => sum + (parseFloat(a.hours) || 0), 0);
        doc.setFont("helvetica", "bold"); doc.setFontSize(8.5); doc.setTextColor(71, 85, 105);
        doc.text(`Presentes: ${pres}   Ausentes: ${aus}   Total horas: ${hrs} hs`, M, y); y += 5;
      }
    }

    // Cursos
    const enrollsEmp = opts.selectedCourseIds && opts.selectedCourseIds.length
      ? s.enrollments.filter(enr => opts.selectedCourseIds.includes(enr.courseId))
      : s.enrollments;
    enrollsEmp.forEach(enr => {
      const course = getCourse(enr.courseId);
      if (!course) return;

      if (!opts.soloAsistencia) {
        if (y > 258) { doc.addPage(); y = 20; }
        y += 5;
        doc.setDrawColor(226, 232, 240); doc.line(M, y, W - M, y); y += 6;
        doc.setFont("helvetica", "bold"); doc.setFontSize(12); doc.setTextColor(15, 23, 42);
        doc.text(course.name, M, y); y += 6;
        doc.setFont("helvetica", "normal"); doc.setFontSize(9.5); doc.setTextColor(71, 85, 105);
        doc.text([`Inicio: ${fmtDate(enr.startDate)}`, `Fin estimado: ${fmtDate(enr.estimatedEnd)}`, `Tutor(es): ${(enr.tutors||[]).join(", ") || "—"}`].join("    "), M, y); y += 5;
        doc.text(`Contenido Dado: ${enr.classes.length}`, M, y); y += 2;

        sectionDivider("Desarrollo Temático");
        const cF = M, cT = M + 26, cP = M + 112, cO = M + 140;
        doc.setFillColor(241, 245, 249); doc.rect(M, y, W - M * 2, 7, "F");
        doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(100, 116, 139);
        doc.text("FECHA", cF + 1, y + 5); doc.text("DESARROLLO TEMÁTICO", cT + 1, y + 5); doc.text("PROFESOR", cP + 1, y + 5); doc.text("OBS.", cO + 1, y + 5);
        y += 7;
        const rows = course.topics.length > 0
          ? course.topics.map(topic => { const cl = enr.classes.find(c => c.topic === topic); return cl ? { ...cl } : { date: "", topic, professor: "", observations: "" }; })
          : enr.classes;
        doc.setFont("helvetica", "normal"); doc.setFontSize(8.5);
        const obsW = W - M - cO - 2, temaW = cP - cT - 2, profW = cO - cP - 2, lineH = 5;
        rows.forEach((cl, i) => {
          const oL = doc.splitTextToSize(cl.observations || "", obsW);
          const tL = doc.splitTextToSize(cl.topic || "", temaW);
          const pL = doc.splitTextToSize(cl.professor || "—", profW);
          const cellH = Math.max(6.5, Math.max(oL.length, tL.length, pL.length) * lineH + 2);
          if (y + cellH > 272) { doc.addPage(); y = 20; }
          if (i % 2 === 1) { doc.setFillColor(249, 250, 252); doc.rect(M, y, W - M * 2, cellH, "F"); }
          const blank = !cl.date;
          doc.setTextColor(blank ? 180 : 30, blank ? 180 : 30, blank ? 180 : 30);
          doc.text(cl.date ? fmtDate(cl.date) : "—", cF + 1, y + 4.5);
          tL.forEach((l, li) => doc.text(l, cT + 1, y + 4.5 + li * lineH));
          pL.forEach((l, li) => doc.text(l, cP + 1, y + 4.5 + li * lineH));
          oL.forEach((l, li) => doc.text(l, cO + 1, y + 4.5 + li * lineH));
          doc.setDrawColor(230, 230, 230); doc.line(M, y + cellH, W - M, y + cellH); y += cellH;
        });
      } // end !soloAsistencia
    });

    // Registro de Pagos unificado por alumno (una vez, no por curso)
    if (isAdmin() && opts.incluirPagos && !opts.soloAsistencia) {
      const pay = s.payment || { type: 'mensual', amount: 0, packageHours: null };
      const payments = s.payments || [];
      sectionDivider("Registro de Pagos");
      doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(71, 85, 105);
      const paid = payments.filter(p => p.paid).reduce((a, p) => a + p.amount, 0);
      const pend = payments.filter(p => !p.paid).reduce((a, p) => a + p.amount, 0);
      const pLine = pay.type === "paquete" && pay.packageHours
        ? `Paquete (${pay.packageHours} hs/sem.)   Cuota: ${fmt(pay.amount)}`
        : `Modalidad: ${payTypeLabel(pay.type)}   Monto: ${fmt(pay.amount)}`;
      doc.text(pLine, M, y); y += 5;
      doc.text(`Total pagado: ${fmt(paid)}   Total pendiente: ${fmt(pend)}`, M, y); y += 5;
      if (payments.length > 0) {
        y += 2;
        const cPF = M, cPC = M + 25, cPM = M + 110, cPE = M + 140;
        doc.setFillColor(241, 245, 249); doc.rect(M, y, W - M * 2, 7, "F");
        doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(100, 116, 139);
        doc.text("FECHA", cPF + 1, y + 5); doc.text("CONCEPTO", cPC + 1, y + 5); doc.text("MONTO", cPM + 1, y + 5); doc.text("ESTADO", cPE + 1, y + 5);
        y += 7; doc.setFont("helvetica", "normal"); doc.setFontSize(8.5);
        payments.forEach((p, i) => {
          if (y > 272) { doc.addPage(); y = 20; }
          if (i % 2 === 1) { doc.setFillColor(249, 250, 252); doc.rect(M, y, W - M * 2, 6.5, "F"); }
          doc.setTextColor(30, 30, 30);
          doc.text(fmtDate(p.date), cPF + 1, y + 4.5);
          doc.text(doc.splitTextToSize(p.concept || "", 80)[0], cPC + 1, y + 4.5);
          doc.text(fmt(p.amount), cPM + 1, y + 4.5);
          if (p.paid) { doc.setTextColor(21, 128, 61); doc.text("Pagado", cPE + 1, y + 4.5); }
          else { doc.setTextColor(185, 28, 28); doc.text("Pendiente", cPE + 1, y + 4.5); }
          doc.setDrawColor(230, 230, 230); doc.line(M, y + 6.5, W - M, y + 6.5); y += 6.5;
        });
      }
    }

    if (opts.incluirCaracteristicas && s.caracteristicas) {
      sectionDivider("Características del Alumno");
      doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.setTextColor(30, 30, 30);
      const carLines = doc.splitTextToSize(s.caracteristicas, W - M * 2);
      carLines.forEach(line => { if (y > 272) { doc.addPage(); y = 20; } doc.text(line, M, y); y += 6; });
    }

    doc.setFontSize(7.5); doc.setTextColor(148, 163, 184);
    doc.text("Keynes Education & Technology — Sistema de Gestión Interno", M, 290);
  });

  const filename = `Keynes_${c ? c.name.replace(/\s+/g, "_") : "Empresa"}_Informe.pdf`;
  doc.save(filename);
  toast(`PDF descargado correctamente (${students.length} alumno${students.length !== 1 ? "s" : ""}).`);
}

// ====== Usuarios (multiusuario) ======
async function loadMe() {
  try {
    const res = await fetch("/api/me");
    if (res.ok) CURRENT_USER = await res.json();
  } catch {}
  applyUserToUI();
}

function applyUserToUI() {
  const nameEl = document.getElementById("userName");
  const roleEl = document.getElementById("userRole");
  const avEl   = document.getElementById("userAvatar");
  const navU   = document.getElementById("navUsuarios");
  if (CURRENT_USER) {
    const display = CURRENT_USER.nombre || CURRENT_USER.username;
    if (nameEl) nameEl.textContent = display;
    if (roleEl) roleEl.textContent = CURRENT_USER.role === "admin" ? "Administrador" : "Usuario";
    if (avEl)   avEl.textContent = (display || "?").trim().slice(0, 2).toUpperCase();
  }
  if (navU) navU.style.display = isAdmin() ? "" : "none";
  const navP = document.getElementById("navPagos");
  if (navP) navP.style.display = isAdmin() ? "" : "none";
  const navR = document.getElementById("navRegistro");
  if (navR) navR.style.display = isAdmin() ? "" : "none";
}

async function loadUsers() {
  try {
    const res = await fetch("/api/users");
    if (res.ok) USERS = (await res.json()).users || [];
  } catch {}
}

function viewUsuarios() {
  const rows = USERS.map(u => {
    const isSelf = CURRENT_USER && u.id === CURRENT_USER.id;
    return `
    <div class="t-row" style="align-items:center">
      <div class="t-student">
        <div class="t-avatar" style="background:${colorFor(u.id)}">${esc((u.nombre || u.username).trim().slice(0,2).toUpperCase())}</div>
        <div>
          <div class="name">${esc(u.nombre || u.username)}${isSelf ? ' <span style="font-size:11px;color:var(--ink-3)">(vos)</span>' : ''}</div>
          <div class="mail">@${esc(u.username)}</div>
        </div>
      </div>
      <div class="t-courses">
        <span class="status-badge ${u.role === "admin" ? "status-active" : ""}">${u.role === "admin" ? "Administrador" : "Usuario"}</span>
        <span class="status-badge ${u.activo ? "status-done" : "status-paused"}">${u.activo ? "Activo" : "Inactivo"}</span>
      </div>
      <div class="t-contact">—</div>
      <div class="t-actions">
        <button class="btn-icon" data-edit-user="${u.id}" title="Editar">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        ${isSelf ? "" : `<button class="btn-icon danger" data-del-user="${u.id}" title="Eliminar">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
        </button>`}
      </div>
    </div>`;
  }).join("");

  return `
  <div class="page-head">
    <div>
      <h2>Usuarios del Sistema</h2>
      <p>Creá y administrá las cuentas que pueden acceder a Keynes.</p>
    </div>
    <button class="btn btn-primary" data-new-user>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      Nuevo Usuario
    </button>
  </div>
  <div class="table-card">
    <div class="t-head">
      <div>Usuario</div>
      <div>Rol / Estado</div>
      <div></div>
      <div class="right">Acciones</div>
    </div>
    ${USERS.length ? rows : '<div class="empty">No hay usuarios.</div>'}
  </div>`;
}

function modalNuevoUsuario() {
  openModal(`
  <div class="modal-head">
    <h3>Nuevo Usuario</h3>
    <button class="modal-close" data-modal-close>&times;</button>
  </div>
  <form id="userForm" data-mode="create">
    <div class="field"><label>Nombre completo</label><input name="nombre" placeholder="Ej. María López"></div>
    <div class="field"><label>Usuario *</label><input name="username" required autocapitalize="none" placeholder="Ej. maria (letras, números, . _ -)"></div>
    <div class="field"><label>Contraseña *</label><input type="password" name="password" required minlength="6" placeholder="Mín. 6 caracteres"></div>
    <div class="field"><label>Rol</label>
      <div class="select-wrap">
        <select name="role">
          <option value="usuario">Usuario</option>
          <option value="admin">Administrador</option>
        </select>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" data-modal-close>Cancelar</button>
      <button type="submit" class="btn btn-primary">Crear Usuario</button>
    </div>
  </form>`);
}

function modalEditarUsuario(userId) {
  const u = USERS.find(x => x.id === userId);
  if (!u) return;
  const isSelf = CURRENT_USER && u.id === CURRENT_USER.id;
  openModal(`
  <div class="modal-head">
    <h3>Editar Usuario</h3>
    <button class="modal-close" data-modal-close>&times;</button>
  </div>
  <form id="userForm" data-mode="edit" data-id="${u.id}">
    <div class="field"><label>Nombre completo</label><input name="nombre" value="${esc(u.nombre || '')}" placeholder="Ej. María López"></div>
    <div class="field"><label>Usuario *</label><input name="username" required autocapitalize="none" value="${esc(u.username || '')}" placeholder="usuario"></div>
    <div class="field"><label>Nueva contraseña <span class="optional">(dejar vacío para no cambiar)</span></label><input type="password" name="password" minlength="6" placeholder="••••••••"></div>
    <div class="field"><label>Rol</label>
      <div class="select-wrap">
        <select name="role" ${isSelf ? "disabled" : ""}>
          <option value="usuario" ${u.role === "usuario" ? "selected" : ""}>Usuario</option>
          <option value="admin" ${u.role === "admin" ? "selected" : ""}>Administrador</option>
        </select>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
    </div>
    <div class="field check-field"><label><input type="checkbox" name="activo" ${u.activo ? "checked" : ""} ${isSelf ? "disabled" : ""}> Cuenta activa</label></div>
    ${isSelf ? '<p style="font-size:12.5px;color:var(--ink-3)">No podés cambiar tu propio rol ni desactivar tu cuenta.</p>' : ''}
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" data-modal-close>Cancelar</button>
      <button type="submit" class="btn btn-primary">Guardar Cambios</button>
    </div>
  </form>`);
}

function modalMiCuenta() {
  if (!CURRENT_USER) return;
  openModal(`
  <div class="modal-head">
    <h3>Ajustes de mi cuenta</h3>
    <button class="modal-close" data-modal-close>&times;</button>
  </div>
  <form id="miCuentaForm">
    <div class="field"><label>Nombre completo</label><input name="nombre" value="${esc(CURRENT_USER.nombre || '')}" placeholder="Tu nombre"></div>
    <div class="field"><label>Usuario</label><input name="username" required autocapitalize="none" value="${esc(CURRENT_USER.username || '')}"></div>
    <div style="border-top:1px solid var(--line);margin:14px 0 12px"></div>
    <p style="font-size:12.5px;color:var(--ink-3);margin-bottom:10px">Para cambiar el usuario o la contraseña, confirmá tu contraseña actual.</p>
    <div class="field"><label>Nueva contraseña <span class="optional">(opcional)</span></label><input type="password" name="password" minlength="6" placeholder="Dejar vacío para no cambiar"></div>
    <div class="field"><label>Contraseña actual</label><input type="password" name="currentPassword" id="miCuentaCurrentPw" placeholder="Requerida para cambiar usuario/contraseña"></div>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" data-modal-close>Cancelar</button>
      <button type="submit" class="btn btn-primary">Guardar Cambios</button>
    </div>
  </form>

  <div style="border-top:1px solid var(--line);margin:18px 0 14px"></div>
  <div class="twofa-block">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
      <div>
        <div style="font-weight:700;font-size:14px;color:var(--ink-1)">Verificación en dos pasos (2FA)</div>
        <div style="font-size:12.5px;color:var(--ink-3);margin-top:2px">Pedí un código de tu app (Google Authenticator, Authy) al iniciar sesión.</div>
      </div>
      <span class="status-badge ${CURRENT_USER.twofaEnabled ? "status-done" : "status-paused"}">${CURRENT_USER.twofaEnabled ? "Activado" : "Desactivado"}</span>
    </div>
    <div id="twofaArea" style="margin-top:12px"></div>
  </div>
  ${isAdmin() ? `
  <div style="border-top:1px solid var(--line);margin:18px 0 14px"></div>
  <div>
    <div style="font-weight:700;font-size:14px;color:var(--ink-1)">Backup de datos</div>
    <div style="font-size:12.5px;color:var(--ink-3);margin:2px 0 10px">Descargá una copia completa (alumnos, empresas, cursos y pagos) en un archivo JSON restaurable. También te llega una por correo todos los días.</div>
    <button type="button" class="btn btn-ghost btn-sm" id="btnBackup">Exportar backup (JSON)</button>
    <button type="button" class="btn btn-ghost btn-sm" id="btnRestore">Restaurar desde backup</button>
    <input type="file" id="fileRestore" accept="application/json,.json" hidden>
  </div>` : ''}`);

  render2faArea();
  document.getElementById("btnBackup")?.addEventListener("click", exportBackup);
  document.getElementById("btnRestore")?.addEventListener("click", () => document.getElementById("fileRestore")?.click());
  document.getElementById("fileRestore")?.addEventListener("change", onArchivoRestore);
}

// ── Restaurar desde backup ───────────────────────────────────
// Pisa TODOS los datos y no hay deshacer, así que antes de tocar nada se
// muestra exactamente qué va a pasar y se exige escribir RESTAURAR.
async function onArchivoRestore(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";              // permite volver a elegir el mismo archivo
  if (!file || !isAdmin()) return;

  let backup;
  try { backup = JSON.parse(await file.text()); }
  catch { toast("El archivo no es un JSON válido."); return; }

  const err = validarBackup(backup);
  if (err) { toast(err); return; }

  modalConfirmarRestore(file.name, backup);
}

function modalConfirmarRestore(nombreArchivo, backup) {
  const nAlumnos  = backup.students.length;
  const nCursos   = backup.courses.length;
  const nEmpresas = (backup.companies || []).length;
  const idS = new Set(backup.students.map(x => x.id));
  const aBorrar = STUDENTS.filter(x => !idS.has(x.id)).length;

  openModal(`
  <div class="modal-head">
    <h3>Restaurar desde backup</h3>
    <button class="modal-close" data-modal-close>&times;</button>
  </div>
  <p style="font-size:13px;color:var(--ink-2);margin-bottom:4px">Archivo: <strong id="restoreNombre"></strong></p>
  <p style="font-size:13px;color:var(--ink-3);margin-bottom:14px">Exportado el <span id="restoreFecha"></span></p>

  <div style="background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:12px;font-size:13px;line-height:1.7">
    El sistema va a quedar exactamente como en ese archivo:
    <div style="margin-top:8px">
      <div><strong>${nAlumnos}</strong> alumnos &nbsp;·&nbsp; <strong>${nCursos}</strong> cursos &nbsp;·&nbsp; <strong>${nEmpresas}</strong> empresas</div>
      <div style="color:var(--ink-3);margin-top:4px">Ahora tenés ${STUDENTS.length} alumnos, ${COURSES.length} cursos y ${COMPANIES.length} empresas.</div>
    </div>
  </div>

  ${aBorrar ? `<p style="margin-top:12px;font-size:13px;color:#b45309"><strong>${aBorrar}</strong> ${aBorrar === 1 ? "alumno que existe hoy no está" : "alumnos que existen hoy no están"} en el backup y se ${aBorrar === 1 ? "va" : "van"} a eliminar.</p>` : ""}

  <p style="margin-top:12px;font-size:13px;color:var(--ink-2)">Esto no se puede deshacer. Si tenés dudas, exportá un backup del estado actual antes de seguir.</p>

  <div class="field" style="margin-top:14px">
    <label>Escribí <strong>RESTAURAR</strong> para confirmar</label>
    <input id="restoreConfirm" autocapitalize="characters" autocomplete="off" placeholder="RESTAURAR">
  </div>
  <div id="restoreProgreso" style="font-size:13px;color:var(--ink-3);min-height:18px"></div>
  <div class="modal-actions">
    <button type="button" class="btn btn-ghost" data-modal-close>Cancelar</button>
    <button type="button" class="btn btn-primary" id="btnRestoreGo" disabled>Restaurar</button>
  </div>`);

  // El nombre del archivo y la fecha vienen del archivo, o sea del usuario:
  // van por textContent y nunca por innerHTML.
  document.getElementById("restoreNombre").textContent = nombreArchivo;
  const f = new Date(backup.exportedAt);
  document.getElementById("restoreFecha").textContent =
    isNaN(f.getTime()) ? "fecha desconocida" : f.toLocaleString("es");

  const input = document.getElementById("restoreConfirm");
  const btn   = document.getElementById("btnRestoreGo");
  const prog  = document.getElementById("restoreProgreso");
  input.addEventListener("input", () => { btn.disabled = input.value.trim().toUpperCase() !== "RESTAURAR"; });

  btn.addEventListener("click", async () => {
    btn.disabled = true; input.disabled = true; btn.textContent = "Restaurando…";
    try {
      await restoreBackup(backup, (hecho, total) => {
        prog.textContent = total > 1 ? `Enviando tanda ${hecho} de ${total}…` : "Enviando…";
      });
      closeModal();
      render();
      toast(`Restaurado: ${backup.students.length} alumnos, ${backup.courses.length} cursos.`);
    } catch (ex) {
      prog.textContent = ex.message || "No se pudo restaurar.";
      btn.disabled = false; input.disabled = false; btn.textContent = "Reintentar";
    }
  });
}

// Backup on-demand: baja todo el estado en memoria (admin lo ve completo, con
// pagos) como un JSON restaurable. Sin costo de servidor.
function exportBackup() {
  if (!isAdmin()) return;
  const data = { exportedAt: new Date().toISOString(), version: _dataVersion, students: STUDENTS, courses: COURSES, companies: COMPANIES };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `keynes-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  toast("Backup exportado.");
}

function render2faArea() {
  const area = document.getElementById("twofaArea");
  if (!area) return;
  if (CURRENT_USER.twofaEnabled) {
    area.innerHTML = `
      <p style="font-size:12.5px;color:var(--ink-3);margin-bottom:8px">Para desactivarlo, ingresá tu contraseña actual (campo de arriba) y confirmá.</p>
      <button type="button" class="btn btn-ghost btn-sm" id="btn2faDisable">Desactivar 2FA</button>`;
    document.getElementById("btn2faDisable").addEventListener("click", disable2FA);
  } else {
    area.innerHTML = `<button type="button" class="btn btn-primary btn-sm" id="btn2faSetup">Activar 2FA</button>`;
    document.getElementById("btn2faSetup").addEventListener("click", setup2FA);
  }
}

async function setup2FA() {
  const area = document.getElementById("twofaArea");
  area.innerHTML = '<p style="font-size:13px;color:var(--ink-3)">Generando…</p>';
  try {
    const res = await fetch("/api/me/2fa/setup", { method: "POST" });
    const j = await res.json();
    if (!res.ok) { toast(j.error || "No se pudo iniciar 2FA."); render2faArea(); return; }
    const secretGrouped = j.secret.replace(/(.{4})/g, "$1 ").trim();
    area.innerHTML = `
      <ol style="font-size:13px;color:var(--ink-2);padding-left:18px;margin-bottom:10px;line-height:1.6">
        <li>Abrí tu app de autenticación (Google Authenticator, Authy…).</li>
        <li>Escaneá el código QR (o cargá la clave manualmente).</li>
      </ol>
      <div id="twofaQrBox" style="display:flex;justify-content:center;margin-bottom:10px">
        <div id="twofaQr" style="background:#fff;padding:10px;border-radius:12px;line-height:0;box-shadow:var(--shadow-sm)"></div>
      </div>
      <div style="font-size:12px;color:var(--ink-3);text-align:center;margin-bottom:4px">o cargá esta clave manualmente:</div>
      <div style="font-family:monospace;font-size:14px;letter-spacing:1px;background:var(--brand-50);color:var(--ink-1);padding:9px 12px;border-radius:8px;word-break:break-all;text-align:center;margin-bottom:12px">${secretGrouped}</div>
      <div class="field"><label>Código de 6 dígitos</label><input id="twofaCode" inputmode="numeric" maxlength="6" placeholder="123456"></div>
      <div style="display:flex;gap:8px">
        <button type="button" class="btn btn-ghost btn-sm" id="btn2faCancel">Cancelar</button>
        <button type="button" class="btn btn-primary btn-sm" id="btn2faEnable">Confirmar y activar</button>
      </div>`;
    // Render del QR localmente (el secreto no se envía a ningún tercero)
    const qrEl = document.getElementById("twofaQr");
    if (window.QRCode && qrEl) {
      try { new QRCode(qrEl, { text: j.otpauth, width: 168, height: 168, correctLevel: QRCode.CorrectLevel.M }); }
      catch { document.getElementById("twofaQrBox").style.display = "none"; }
    } else {
      document.getElementById("twofaQrBox").style.display = "none";
    }
    document.getElementById("btn2faCancel").addEventListener("click", render2faArea);
    document.getElementById("btn2faEnable").addEventListener("click", enable2FA);
    document.getElementById("twofaCode").focus();
  } catch { toast("Error de red."); render2faArea(); }
}

async function enable2FA() {
  const code = (document.getElementById("twofaCode")?.value || "").trim();
  try {
    const res = await fetch("/api/me/2fa/enable", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
    const j = await res.json();
    if (!res.ok) { toast(j.error || "Código incorrecto."); return; }
    toast("2FA activado."); await loadMe(); modalMiCuenta();
  } catch { toast("Error de red."); }
}

async function disable2FA() {
  const currentPassword = (document.getElementById("miCuentaCurrentPw")?.value || "");
  if (!currentPassword) { toast("Ingresá tu contraseña actual para desactivar 2FA."); return; }
  try {
    const res = await fetch("/api/me/2fa/disable", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword }) });
    const j = await res.json();
    if (!res.ok) { toast(j.error || "No se pudo desactivar."); return; }
    toast("2FA desactivado."); await loadMe(); modalMiCuenta();
  } catch { toast("Error de red."); }
}

// ====== Vista: Registro de Pagos (solo admin) ======
function payAgg(payments) {
  const paid = payments.filter(p => p.paid).reduce((a, p) => a + (p.amount || 0), 0);
  const pend = payments.filter(p => !p.paid).reduce((a, p) => a + (p.amount || 0), 0);
  const last = payments.filter(p => p.paid).map(p => p.date).filter(Boolean).sort().pop() || null;
  return { paid, pend, last, count: payments.length };
}

function viewPagos() {
  // Alertas: alumnos con pago pendiente o sin ningún pago cargado
  const overdue = STUDENTS
    .map(s => ({ s, alerts: getStudentAlerts(s).filter(a => a.type === "pago" || a.type === "sinpago") }))
    .filter(x => x.alerts.length)
    .sort((a, b) => (b.alerts[0].days == null ? Infinity : b.alerts[0].days) - (a.alerts[0].days == null ? Infinity : a.alerts[0].days));

  const alertBanner = overdue.length ? `
    <div class="pay-alert-banner">
      <div class="pay-alert-head">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:16px;height:16px"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        ${overdue.length} alumno${overdue.length !== 1 ? "s" : ""} con pago pendiente o sin registrar
      </div>
      <div class="pay-alert-list">
        ${overdue.map(({ s, alerts }) => {
          const a0 = alerts[0];
          const txt = a0.type === "sinpago" ? "sin pago cargado" : `${a0.days} días sin pagar`;
          const addAttr = isEmpresaStudent(s) ? `data-add-pago-empresa="${s.empresaId}"` : `data-add-pay="${s.id}"`;
          return `<span class="pay-alert-chip">
          <button data-open="${s.id}" title="Ver perfil">${esc(s.name)} ${esc(s.surname)} · ${txt}</button>
          <button class="pay-alert-add" ${addAttr} title="Registrar pago">+ pago</button>
        </span>`;
        }).join("")}
      </div>
    </div>` : "";

  const tab = state.pagosTab === "empresas" ? "empresas" : "alumnos";

  return `
  <div class="page-head">
    <div><h2>Registro de Pagos</h2><p>Pagos de alumnos y empresas. Solo visible para el administrador.</p></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn btn-ghost" data-export-pagos-pdf>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Exportar PDF/Excel
      </button>
      ${tab === "alumnos" ? `<button class="btn btn-primary" data-registrar-pago>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Registrar Pago
      </button>` : ""}
    </div>
  </div>

  ${alertBanner}

  <div class="seg-control pay-seg" style="margin-bottom:18px">
    <button class="seg-btn ${tab === "alumnos" ? "active" : ""}" data-pagos-tab="alumnos">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
      Alumnos
    </button>
    <button class="seg-btn ${tab === "empresas" ? "active" : ""}" data-pagos-tab="empresas">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21h18"/><path d="M5 21V7l8-4v18"/><path d="M19 21V11l-6-4"/><line x1="9" y1="9" x2="9" y2="9.01"/><line x1="9" y1="12" x2="9" y2="12.01"/><line x1="9" y1="15" x2="9" y2="15.01"/></svg>
      Empresas
    </button>
  </div>

  ${tab === "alumnos" ? viewPagosAlumnos() : viewPagosEmpresas()}`;
}

// ── Sección Alumnos: un grupo desplegable por alumno individual ──
function viewPagosAlumnos() {
  const q = state.pagosSearch.trim().toLowerCase();
  const nameOf = s => (s.name + " " + s.surname).toLowerCase();

  let students = STUDENTS.filter(s => {
    const matchSearch = !q || nameOf(s).includes(q);
    const matchCourse = !state.pagosCourse || (s.enrollments || []).some(e => e.courseId === state.pagosCourse);
    const matchEstado = !state.pagosEstado || (s.estado || "activo") === state.pagosEstado;
    return matchSearch && matchCourse && matchEstado;
  });

  students.sort((a, b) => {
    const la = payAgg(effectivePayments(a)).last || "";
    const lb = payAgg(effectivePayments(b)).last || "";
    switch (state.pagosSort) {
      case "antiguo": return la.localeCompare(lb);
      case "az":      return nameOf(a).localeCompare(nameOf(b));
      case "za":      return nameOf(b).localeCompare(nameOf(a));
      default:        return lb.localeCompare(la); // reciente
    }
  });

  let totalPaid = 0, totalPend = 0;
  students.forEach(s => { const a = payAgg(effectivePayments(s)); totalPaid += a.paid; totalPend += a.pend; });

  const courseOptions = COURSES.map(c => `<option value="${c.id}" ${state.pagosCourse === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("");
  const sortOpt = (v, label) => `<option value="${v}" ${state.pagosSort === v ? "selected" : ""}>${label}</option>`;
  const estadoOpt = (v, label) => `<option value="${v}" ${state.pagosEstado === v ? "selected" : ""}>${label}</option>`;

  const groups = students.map(s => {
    const isEmp = isEmpresaStudent(s);
    const eff = effectivePayments(s);
    const payments = eff.slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    const agg = payAgg(eff);
    const empresa = isEmp ? getCompany(s.empresaId) : null;
    const cursos = (s.enrollments || []).map(e => getCourse(e.courseId)?.name).filter(Boolean).join(", ") || "—";
    const open = !!state.pagosOpen[s.id];

    const rows = payments.length ? payments.map(p => {
      // Alumno de empresa: pagos de solo lectura (se gestionan desde Empresas)
      const actions = isEmp
        ? `<span style="font-size:12px;color:var(--ink-3)">empresa</span>`
        : (() => {
            const idx = (s.payments || []).indexOf(p);
            return `${!p.paid ? `<button class="btn-outline" data-mark-paid="${s.id}" data-pay-idx="${idx}">Marcar pagado</button>` : ""}
          <button class="btn-icon" data-edit-pay="${s.id}" data-pay-idx="${idx}" title="Editar">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="btn-icon danger" data-del-pay="${s.id}" data-pay-idx="${idx}" title="Eliminar">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>`;
          })();
      return `
      <tr>
        <td>${fmtDate(p.date)}</td>
        <td>${esc(p.concept || "—")}</td>
        <td>${fmt(p.amount)}</td>
        <td><span class="pay-badge ${p.paid ? "paid" : "unpaid"}">${p.paid ? "Pagado" : "Pendiente"}</span></td>
        <td style="display:flex;gap:4px;align-items:center;justify-content:flex-end">${actions}</td>
      </tr>`;
    }).join("") : "";

    const addBtn = isEmp
      ? `<button class="btn btn-primary btn-sm pay-group-add" data-add-pago-empresa="${s.empresaId}">+ pago</button>`
      : `<button class="btn btn-primary btn-sm pay-group-add" data-add-pay="${s.id}">+ pago</button>`;

    const emptyMsg = isEmp
      ? `Sin pagos de la empresa para este alumno. Se gestionan desde la sección Empresas.`
      : `Sin pagos cargados. Usá "+ pago" para registrar el primero.`;

    return `
    <details class="pay-group" data-pay-group="${s.id}" ${open ? "open" : ""}>
      <summary>
        <svg class="pay-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
        <span class="pay-group-name"><a href="#" data-open="${s.id}">${esc(s.name)} ${esc(s.surname)}</a>${empresa ? ` <span class="emp-badge">🏢 ${esc(empresa.name)}</span>` : ""}</span>
        <span class="pay-group-cursos">${cursos}</span>
        <span class="pay-group-stats">
          <span class="chip-paid">Cobrado ${fmt(agg.paid)}</span>
          ${agg.pend ? `<span class="chip-pend">Pendiente ${fmt(agg.pend)}</span>` : ""}
          <span class="chip-count">${agg.count} pago${agg.count !== 1 ? "s" : ""}</span>
        </span>
        ${addBtn}
      </summary>
      ${rows ? `
      <div class="class-table-wrap">
        <table class="class-table">
          <thead><tr><th>Fecha</th><th>Concepto</th><th>Monto</th><th>Estado</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>` : `<div class="empty-sm">${emptyMsg}</div>`}
    </details>`;
  }).join("");

  return `
  <div class="filter-bar">
    <div class="filter-group">
      <label>Buscar alumno</label>
      <input id="pagosSearchInput" placeholder="Nombre o apellido…" value="${state.pagosSearch.replace(/"/g, "&quot;")}" style="min-width:200px;padding:9px 12px;border:1px solid var(--line);border-radius:10px;font-size:14px;font-family:inherit;background:var(--surface);color:var(--ink)">
    </div>
    <div class="filter-group">
      <label>Curso</label>
      <div class="select-wrap">
        <select id="pagosCourseSelect" style="min-width:170px"><option value="">Todos los cursos</option>${courseOptions}</select>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
    </div>
    <div class="filter-group">
      <label>Estado</label>
      <div class="select-wrap">
        <select id="pagosEstadoSelect" style="min-width:150px">
          ${estadoOpt("", "Todos los estados")}
          ${estadoOpt("activo", "Activo")}
          ${estadoOpt("pausado", "Pausado")}
          ${estadoOpt("finalizado", "Finalizado")}
        </select>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
    </div>
    <div class="filter-group">
      <label>Ordenar por</label>
      <div class="select-wrap">
        <select id="pagosSortSelect" style="min-width:160px">
          ${sortOpt("reciente", "Pago más reciente")}
          ${sortOpt("antiguo", "Pago más antiguo")}
          ${sortOpt("az", "Alumno A → Z")}
          ${sortOpt("za", "Alumno Z → A")}
        </select>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
    </div>
    <div class="result-count">${students.length} alumno${students.length !== 1 ? "s" : ""} · Cobrado ${fmt(totalPaid)} · Pendiente ${fmt(totalPend)}</div>
  </div>
  ${students.length ? `<div class="pay-groups">${groups}</div>` : '<div class="table-card"><div class="empty">No hay alumnos que coincidan con los filtros.</div></div>'}`;
}

// ── Sección Empresas: un grupo desplegable por empresa ──
function viewPagosEmpresas() {
  const q = state.pagosSearch.trim().toLowerCase();
  let companies = COMPANIES.filter(c => !q || c.name.toLowerCase().includes(q));
  companies = companies.slice().sort((a, b) => a.name.localeCompare(b.name));

  let totalPaid = 0, totalPend = 0;
  companies.forEach(c => { const a = payAgg(c.pagosEmpresa || []); totalPaid += a.paid; totalPend += a.pend; });

  const groups = companies.map(c => {
    const pagos = (c.pagosEmpresa || []).slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    const agg = payAgg(c.pagosEmpresa || []);
    const open = !!state.pagosOpen[c.id];

    const rows = pagos.length ? pagos.map(p => {
      const student = p.studentId ? getStudent(p.studentId) : null;
      return `
      <tr>
        <td>${fmtDate(p.date)}</td>
        <td>${student ? `${esc(student.name)} ${esc(student.surname)}` : `<span style="color:var(--ink-3);font-style:italic">General</span>`}</td>
        <td>${esc(p.concept || "—")}</td>
        <td>${fmt(p.amount)}</td>
        <td><span class="pay-badge ${p.paid ? "paid" : "unpaid"}">${p.paid ? "Pagado" : "Pendiente"}</span></td>
        <td style="display:flex;gap:4px;align-items:center;justify-content:flex-end">
          ${!p.paid ? `<button class="btn-outline" data-mark-paid-emp="${c.id}" data-pay-id="${p.id}">Marcar pagado</button>` : ""}
          <button class="btn-icon" data-edit-pay-emp="${c.id}" data-pay-id="${p.id}" title="Editar">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="btn-icon danger" data-del-pay-emp="${c.id}" data-pay-id="${p.id}" title="Eliminar">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </td>
      </tr>`;
    }).join("") : "";

    return `
    <details class="pay-group" data-pay-group="${c.id}" ${open ? "open" : ""}>
      <summary>
        <svg class="pay-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
        <span class="pay-group-name"><a href="#" data-open-empresa="${c.id}">${esc(c.name)}</a></span>
        <span class="pay-group-cursos">${STUDENTS.filter(s => s.empresaId === c.id).length} alumno(s)</span>
        <span class="pay-group-stats">
          <span class="chip-paid">Cobrado ${fmt(agg.paid)}</span>
          ${agg.pend ? `<span class="chip-pend">Pendiente ${fmt(agg.pend)}</span>` : ""}
          <span class="chip-count">${agg.count} pago${agg.count !== 1 ? "s" : ""}</span>
        </span>
        <button class="btn btn-primary btn-sm pay-group-add" data-add-pago-empresa="${c.id}">+ pago</button>
      </summary>
      ${rows ? `
      <div class="class-table-wrap">
        <table class="class-table">
          <thead><tr><th>Fecha</th><th>Alumno</th><th>Concepto</th><th>Monto</th><th>Estado</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>` : '<div class="empty-sm">Sin pagos cargados. Usá "+ pago" para registrar el primero.</div>'}
    </details>`;
  }).join("");

  return `
  <div class="filter-bar">
    <div class="filter-group">
      <label>Buscar empresa</label>
      <input id="pagosSearchInput" placeholder="Nombre de la empresa…" value="${state.pagosSearch.replace(/"/g, "&quot;")}" style="min-width:200px;padding:9px 12px;border:1px solid var(--line);border-radius:10px;font-size:14px;font-family:inherit;background:var(--surface);color:var(--ink)">
    </div>
    <div class="result-count">${companies.length} empresa${companies.length !== 1 ? "s" : ""} · Cobrado ${fmt(totalPaid)} · Pendiente ${fmt(totalPend)}</div>
  </div>
  ${companies.length ? `<div class="pay-groups">${groups}</div>` : '<div class="table-card"><div class="empty">No hay empresas que coincidan con los filtros.</div></div>'}`;
}

function modalRegistrarPagoPanel() {
  const today = new Date().toISOString().split("T")[0];
  // Solo alumnos individuales: los de empresa se cargan desde la sección Empresas
  const opts = STUDENTS.filter(s => !isEmpresaStudent(s)).slice()
    .sort((a, b) => (a.name + a.surname).localeCompare(b.name + b.surname))
    .map(s => `<option value="${s.id}">${esc(s.name)} ${esc(s.surname)}</option>`).join("");
  openModal(`
  <div class="modal-head">
    <h3>Registrar Pago</h3>
    <button class="modal-close" data-modal-close>&times;</button>
  </div>
  <form id="panelPagoForm">
    <div class="field"><label>Alumno *</label>
      <div class="select-wrap">
        <select name="studentId" required><option value="">— Seleccionar alumno —</option>${opts}</select>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
    </div>
    <div class="field"><label>Fecha *</label><input type="date" name="date" required value="${today}"></div>
    <div class="field"><label>Concepto *</label><input name="concept" required placeholder="Ej. Mensualidad Junio"></div>
    <div class="field"><label>Monto (₲) *</label><input type="number" name="amount" required min="0" placeholder="Ej. 300000"></div>
    <div class="field check-field"><label><input type="checkbox" name="paid" checked> Marcar como pagado</label></div>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" data-modal-close>Cancelar</button>
      <button type="submit" class="btn btn-primary">Guardar Pago</button>
    </div>
  </form>`);
}

// ====== Render ======
function render() {
  const navMap = { dashboard: "dashboard", lista: "lista", detalle: "lista", registro: "registro", cursos: "cursos", empresas: "empresas", empresaDetalle: "empresas", soporte: "soporte", usuarios: "usuarios", pagos: "pagos" };
  document.querySelectorAll(".nav-item[data-view]").forEach(n => {
    n.classList.toggle("active", n.dataset.view === navMap[state.view]);
  });

  // Solo el admin puede ver la gestión de usuarios, el registro de pagos y el alta de alumnos
  if ((state.view === "usuarios" || state.view === "pagos" || state.view === "registro") && !isAdmin()) { go("dashboard"); return; }

  if (state.view === "dashboard") {
    content.innerHTML = viewDashboard();
    requestAnimationFrame(() => initDashboardCharts());
  }
  else if (state.view === "lista") content.innerHTML = viewLista();
  else if (state.view === "detalle") content.innerHTML = viewDetalle();
  else if (state.view === "registro") {
    content.innerHTML = viewRegistro();
    let count = 1;
    document.getElementById("enrollmentsList").innerHTML = enrollmentBlock(0);
    document.getElementById("addEnrollmentBtn").addEventListener("click", () => {
      document.getElementById("enrollmentsList").insertAdjacentHTML("beforeend", enrollmentBlock(count));
      count++;
    });
  }
  else if (state.view === "cursos")        content.innerHTML = viewCursos();
  else if (state.view === "empresas")      content.innerHTML = viewEmpresas();
  else if (state.view === "empresaDetalle") content.innerHTML = viewEmpresaDetalle();
  else if (state.view === "soporte")       content.innerHTML = viewSoporte();
  else if (state.view === "usuarios") {
    content.innerHTML = viewUsuarios();
    loadUsers().then(() => { if (state.view === "usuarios") content.innerHTML = viewUsuarios(); });
  }
  else if (state.view === "pagos") content.innerHTML = viewPagos();

  content.scrollTop = 0;
  window.scrollTo(0, 0);
}

function go(view, studentId, enrollIdx, companyId) {
  state.view = view;
  if (studentId !== undefined) state.currentStudentId = studentId;
  if (enrollIdx !== undefined) state.currentEnrollIdx = enrollIdx;
  else if (view === "detalle") state.currentEnrollIdx = -1;
  if (companyId !== undefined) state.currentCompanyId = companyId;
  if (view === "empresaDetalle") state.empresaTab = "alumnos";
  render();
}

// ====== Mobile sidebar ======
const sidebar         = document.querySelector(".sidebar");
const hamburgerBtn    = document.getElementById("hamburger");
const sidebarBackdrop = document.getElementById("sidebarBackdrop");

function openSidebar() {
  sidebar.classList.add("open");
  sidebarBackdrop.classList.add("show");
  document.body.style.overflow = "hidden";
}
function closeSidebar() {
  sidebar.classList.remove("open");
  sidebarBackdrop.classList.remove("show");
  document.body.style.overflow = "";
}

hamburgerBtn.addEventListener("click", () => {
  sidebar.classList.contains("open") ? closeSidebar() : openSidebar();
});

// Abrir "Mi cuenta" al hacer clic en el usuario del topbar
const userBox = document.querySelector(".topbar .user");
if (userBox) {
  userBox.style.cursor = "pointer";
  userBox.title = "Mi cuenta";
  userBox.addEventListener("click", () => modalMiCuenta());
}

// ====== Modo oscuro ======
const SUN_ICON  = '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>';
const MOON_ICON = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';
function applyThemeIcon() {
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  const icon = document.getElementById("themeIcon");
  if (icon) icon.innerHTML = dark ? MOON_ICON : SUN_ICON;
}
function toggleTheme() {
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  const next = dark ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem("keynes_theme", next); } catch {}
  applyThemeIcon();
  if (state.view === "dashboard") render(); // repintar gráficos con el tema nuevo
}
document.getElementById("themeToggle")?.addEventListener("click", toggleTheme);
applyThemeIcon();

// Botón de ajustes (engranaje) → abre Mi cuenta
document.getElementById("settingsBtn")?.addEventListener("click", () => modalMiCuenta());
sidebarBackdrop.addEventListener("click", closeSidebar);
document.addEventListener("keydown", e => { if (e.key === "Escape") closeSidebar(); });

// ====== Event: Nav ======
document.getElementById("mainNav").addEventListener("click", e => {
  const item = e.target.closest(".nav-item[data-view]");
  if (!item) return;
  e.preventDefault();
  closeSidebar();
  go(item.dataset.view);
});
document.querySelector(".sidebar-footer").addEventListener("click", e => {
  const item = e.target.closest(".nav-item[data-view]");
  if (!item) return;
  e.preventDefault();
  closeSidebar();
  go(item.dataset.view);
});

// ====== Event: Content ======
content.addEventListener("click", e => {
  // El usuario común no crea, edita ni elimina alumnos/empresas (el servidor también lo rechaza).
  if (!isAdmin() && e.target.closest("[data-delete],[data-edit-student],[data-new-empresa],[data-edit-empresa],[data-delete-empresa]")) return;

  const goBtn = e.target.closest("[data-go]");
  if (goBtn) { e.preventDefault(); go(goBtn.dataset.go); return; }

  const dismissAlertBtn = e.target.closest("[data-dismiss-alert]");
  if (dismissAlertBtn) {
    e.stopPropagation();
    const st = getStudent(dismissAlertBtn.dataset.dismissAlert);
    if (st) {
      if (!st.alertasDismissed) st.alertasDismissed = {};
      st.alertasDismissed[dismissAlertBtn.dataset.alertType] = dismissAlertBtn.dataset.alertKey;
      saveData(); render(); toast("Alerta descartada.");
    }
    return;
  }

  const openBtn = e.target.closest("[data-open]");
  if (openBtn && !e.target.closest("[data-delete]") && !e.target.closest("[data-dismiss-alert]")) { go("detalle", openBtn.dataset.open, 0); return; }

  const tabBtn = e.target.closest("[data-tab]");
  if (tabBtn) {
    state.currentEnrollIdx = tabBtn.dataset.tab === "planilla" ? -1 : parseInt(tabBtn.dataset.tab);
    render(); return;
  }

  const deleteBtn = e.target.closest("[data-delete]");
  if (deleteBtn) { e.stopPropagation(); modalEliminarAlumno(deleteBtn.dataset.delete); return; }

  const addClassBtn = e.target.closest("[data-add-class]");
  if (addClassBtn) { modalAgregarClase(addClassBtn.dataset.addClass, addClassBtn.dataset.topic || ""); return; }

  const toggleHwBtn = e.target.closest("[data-toggle-hw-done]");
  if (toggleHwBtn) {
    const r = findEnrollment(toggleHwBtn.dataset.toggleHwDone);
    const idx = parseInt(toggleHwBtn.dataset.classIdx);
    if (r && r.enr.classes[idx] && r.enr.classes[idx].homework) {
      r.enr.classes[idx].homework.done = !r.enr.classes[idx].homework.done;
      saveData(); render();
    }
    return;
  }

  const editHwBtn = e.target.closest("[data-edit-hw]");
  if (editHwBtn) { modalEditarHomework(editHwBtn.dataset.editHw, editHwBtn.dataset.classIdx); return; }

  const delHwBtn = e.target.closest("[data-del-hw]");
  if (delHwBtn) {
    const r = findEnrollment(delHwBtn.dataset.delHw);
    const idx = parseInt(delHwBtn.dataset.classIdx);
    if (r && r.enr.classes[idx]) {
      delete r.enr.classes[idx].homework;
      saveData(); render();
    }
    return;
  }

  const editClassBtn = e.target.closest("[data-edit-class]");
  if (editClassBtn) { modalEditarClase(editClassBtn.dataset.editClass, editClassBtn.dataset.classIdx); return; }

  const addPayBtn = e.target.closest("[data-add-pay]");
  if (addPayBtn) { e.preventDefault(); modalAgregarPago(addPayBtn.dataset.addPay); return; }

  const markPaidBtn = e.target.closest("[data-mark-paid]");
  if (markPaidBtn) {
    const s = getStudent(markPaidBtn.dataset.markPaid);
    const p = s && (s.payments || [])[parseInt(markPaidBtn.dataset.payIdx)];
    if (p) { p.paid = true; saveData(); toast("Pago marcado como pagado."); render(); }
    return;
  }

  const editPayBtn = e.target.closest("[data-edit-pay]");
  if (editPayBtn) { modalEditarPago(editPayBtn.dataset.editPay, editPayBtn.dataset.payIdx); return; }

  const delClassBtn = e.target.closest("[data-del-class]");
  if (delClassBtn) {
    const enrollId = delClassBtn.dataset.delClass;
    const idx = delClassBtn.dataset.classIdx;
    const r = findEnrollment(enrollId);
    const topic = r ? (r.enr.classes[parseInt(idx)]?.topic || "esta clase") : "esta clase";
    modalConfirmarEliminar({
      titulo: "Eliminar Clase",
      mensaje: `¿Confirmás la eliminación de la clase <b>${esc(topic)}</b>?`,
      onConfirmAttr: "data-confirm-del-class",
      onConfirmValue: `${enrollId}__${idx}`
    });
    return;
  }

  const delPayBtn = e.target.closest("[data-del-pay]");
  if (delPayBtn) {
    const studentId = delPayBtn.dataset.delPay;
    const idx = delPayBtn.dataset.payIdx;
    const s = getStudent(studentId);
    const concept = s ? ((s.payments || [])[parseInt(idx)]?.concept || "este pago") : "este pago";
    modalConfirmarEliminar({
      titulo: "Eliminar Pago",
      mensaje: `¿Confirmás la eliminación del pago <b>${esc(concept)}</b>?`,
      onConfirmAttr: "data-confirm-del-pay",
      onConfirmValue: `${studentId}__${idx}`
    });
    return;
  }

  const informeBtn = e.target.closest("[data-informe-student]");
  if (informeBtn) { modalCopiarInforme(informeBtn.dataset.informeStudent); return; }

  const pdfBtn = e.target.closest("[data-download-pdf]");
  if (pdfBtn) { modalDescargarPDF(pdfBtn.dataset.downloadPdf); return; }

  const certBtn = e.target.closest("[data-certificado]");
  if (certBtn) { modalCertificado(certBtn.dataset.certificado); return; }

  const addAttendBtn = e.target.closest("[data-add-attend]");
  if (addAttendBtn) { modalAgregarAsistencia(addAttendBtn.dataset.addAttend); return; }

  const addAttendGenBtn = e.target.closest("[data-add-attend-gen]");
  if (addAttendGenBtn) { modalAgregarAsistenciaGeneral(addAttendGenBtn.dataset.addAttendGen); return; }

  const editAttendGenBtn = e.target.closest("[data-edit-attend-gen]");
  if (editAttendGenBtn) { modalEditarAsistenciaGeneral(editAttendGenBtn.dataset.editAttendGen, editAttendGenBtn.dataset.attendIdx); return; }

  const delAttendGenBtn = e.target.closest("[data-del-attend-gen]");
  if (delAttendGenBtn) {
    const studentId = delAttendGenBtn.dataset.delAttendGen;
    const idx = delAttendGenBtn.dataset.attendIdx;
    const s = getStudent(studentId);
    const dateStr = s ? fmtDate(((s.attendance || [])[parseInt(idx)] || {}).date || "") : "";
    modalConfirmarEliminar({
      titulo: "Eliminar Registro de Asistencia",
      mensaje: `¿Confirmás la eliminación del registro de asistencia${dateStr ? " del <b>" + dateStr + "</b>" : ""}?`,
      onConfirmAttr: "data-confirm-del-attend-gen",
      onConfirmValue: `${studentId}__${idx}`
    });
    return;
  }

  const editEnrCourseBtn = e.target.closest("[data-edit-enr-course]");
  if (editEnrCourseBtn) { modalEditarCursoEnrollment(editEnrCourseBtn.dataset.editEnrCourse); return; }

  const editEnrDatesBtn = e.target.closest("[data-edit-enr-dates]");
  if (editEnrDatesBtn) { modalEditarFechasCurso(editEnrDatesBtn.dataset.editEnrDates); return; }

  const editEnrTutorsBtn = e.target.closest("[data-edit-enr-tutors]");
  if (editEnrTutorsBtn) { modalEditarTutores(editEnrTutorsBtn.dataset.editEnrTutors); return; }

  const editPayConfigBtn = e.target.closest("[data-edit-pay-config]");
  if (editPayConfigBtn) { modalEditarConfigPago(editPayConfigBtn.dataset.editPayConfig); return; }

  const markCompleteBtn = e.target.closest("[data-mark-complete]");
  if (markCompleteBtn) { modalConfirmarFinalizar(markCompleteBtn.dataset.markComplete); return; }

  const addAttendStudentBtn = e.target.closest("[data-add-attend-student]");
  if (addAttendStudentBtn) { modalAgregarAsistenciaGeneral(addAttendStudentBtn.dataset.addAttendStudent); return; }

  const unmarkCompleteBtn = e.target.closest("[data-unmark-complete]");
  if (unmarkCompleteBtn) {
    const r = findEnrollment(unmarkCompleteBtn.dataset.unmarkComplete);
    if (r) { r.enr.completed = false; saveData(); toast("Finalización desmarcada."); render(); }
    return;
  }

  const newCourseBtn = e.target.closest("[data-new-course]");
  if (newCourseBtn) { if (isAdmin()) modalNuevoCurso(); return; }

  const newEmpresaBtn = e.target.closest("[data-new-empresa]");
  if (newEmpresaBtn) { modalAgregarEmpresa(); return; }

  const viewEmpresaDetailBtn = e.target.closest("[data-view-empresa-detail]");
  if (viewEmpresaDetailBtn) { go("empresaDetalle", undefined, undefined, viewEmpresaDetailBtn.dataset.viewEmpresaDetail); return; }

  const empresaTabBtn = e.target.closest("[data-empresa-tab]");
  if (empresaTabBtn) { state.empresaTab = empresaTabBtn.dataset.empresaTab; render(); return; }

  const claseGrupoBtn = e.target.closest("[data-clase-grupo]");
  if (claseGrupoBtn) { modalRegistrarClaseGrupo(claseGrupoBtn.dataset.claseGrupo); return; }

  const addPagoEmpresaBtn = e.target.closest("[data-add-pago-empresa]");
  if (addPagoEmpresaBtn) { e.preventDefault(); modalAgregarPagoEmpresa(addPagoEmpresaBtn.dataset.addPagoEmpresa); return; }

  // ── Registro de Pagos: cambio de sección y navegación a empresa ──
  const pagosTabBtn = e.target.closest("[data-pagos-tab]");
  if (pagosTabBtn) { state.pagosTab = pagosTabBtn.dataset.pagosTab; render(); return; }

  // ── Soporte y Ayuda: tabs + exportar tutorial ──
  const soporteTabBtn = e.target.closest("[data-soporte-tab]");
  if (soporteTabBtn) { state.soporteTab = soporteTabBtn.dataset.soporteTab; render(); return; }
  const exportTutorialBtn = e.target.closest("[data-export-tutorial]");
  if (exportTutorialBtn) { exportTutorialPDF(); return; }

  const openEmpBtn = e.target.closest("[data-open-empresa]");
  if (openEmpBtn) { e.preventDefault(); go("empresaDetalle", undefined, undefined, openEmpBtn.dataset.openEmpresa); return; }

  // ── Pagos de empresa: marcar pagado / eliminar (por id) ──
  const markPaidEmpBtn = e.target.closest("[data-mark-paid-emp]");
  if (markPaidEmpBtn) {
    const c = getCompany(markPaidEmpBtn.dataset.markPaidEmp);
    const p = c && (c.pagosEmpresa || []).find(x => x.id === markPaidEmpBtn.dataset.payId);
    if (p) { p.paid = true; saveData(); toast("Pago marcado como pagado."); render(); }
    return;
  }

  const editPayEmpBtn = e.target.closest("[data-edit-pay-emp]");
  if (editPayEmpBtn) { modalEditarPagoEmpresa(editPayEmpBtn.dataset.editPayEmp, editPayEmpBtn.dataset.payId); return; }

  const delPayEmpBtn = e.target.closest("[data-del-pay-emp]");
  if (delPayEmpBtn) {
    const c = getCompany(delPayEmpBtn.dataset.delPayEmp);
    const p = c && (c.pagosEmpresa || []).find(x => x.id === delPayEmpBtn.dataset.payId);
    modalConfirmarEliminar({
      titulo: "Eliminar Pago",
      mensaje: `¿Confirmás la eliminación del pago <b>${esc(p ? (p.concept || "este pago") : "este pago")}</b> de ${esc(c ? c.name : "")}?`,
      onConfirmAttr: "data-confirm-del-pay-emp",
      onConfirmValue: `${delPayEmpBtn.dataset.delPayEmp}__${delPayEmpBtn.dataset.payId}`,
    });
    return;
  }

  const informeEmpresaBtn = e.target.closest("[data-informe-empresa]");
  if (informeEmpresaBtn) { modalInformeEmpresa(informeEmpresaBtn.dataset.informeEmpresa); return; }

  const downloadPdfEmpresaBtn = e.target.closest("[data-download-pdf-empresa]");
  if (downloadPdfEmpresaBtn) { modalDescargarPDFEmpresa(downloadPdfEmpresaBtn.dataset.downloadPdfEmpresa); return; }

  const editEmpresaBtn = e.target.closest("[data-edit-empresa]");
  if (editEmpresaBtn) { modalEditarEmpresa(editEmpresaBtn.dataset.editEmpresa); return; }

  const delEmpresaBtn = e.target.closest("[data-delete-empresa]");
  if (delEmpresaBtn) {
    const id = delEmpresaBtn.dataset.deleteEmpresa;
    const cmp = getCompany(id);
    const linked = STUDENTS.filter(s => s.empresaId === id).length;
    if (linked > 0) { toast(`No se puede eliminar: ${linked} alumno${linked !== 1 ? "s" : ""} pertenece${linked === 1 ? "" : "n"} a esta empresa.`); return; }
    modalConfirmarEliminar({
      titulo: "Eliminar Empresa",
      mensaje: `¿Confirmás la eliminación de la empresa <b>${esc(cmp ? cmp.name : id)}</b>?`,
      onConfirmAttr: "data-confirm-del-empresa",
      onConfirmValue: id
    });
    return;
  }

  const viewCourseBtn = e.target.closest("[data-view-course]");
  if (viewCourseBtn) { modalVerTemas(viewCourseBtn.dataset.viewCourse); return; }

  const delCourseBtn = e.target.closest("[data-delete-course]");
  if (delCourseBtn) {
    if (!isAdmin()) return;
    const id = delCourseBtn.dataset.deleteCourse;
    if (STUDENTS.some(s => s.enrollments.some(e => e.courseId === id))) {
      toast("No se puede eliminar: hay alumnos inscriptos en este curso."); return;
    }
    const course = getCourse(id);
    modalConfirmarEliminar({
      titulo: "Eliminar Curso",
      mensaje: `¿Confirmás la eliminación del curso <b>${esc(course ? course.name : id)}</b>?`,
      onConfirmAttr: "data-confirm-del-course",
      onConfirmValue: id
    });
    return;
  }

  const editStudentBtn = e.target.closest("[data-edit-student]");
  if (editStudentBtn) { modalEditarAlumno(editStudentBtn.dataset.editStudent); return; }

  const addEnrollBtn = e.target.closest("[data-add-enrollment]");
  if (addEnrollBtn) { modalAgregarEnrollment(addEnrollBtn.dataset.addEnrollment); return; }

  const removeEnrBtn = e.target.closest("[data-remove-enr]");
  if (removeEnrBtn) { removeEnrBtn.closest(".enrollment-block").remove(); return; }

  const exportDashBtn = e.target.closest("[data-export-dashboard]");
  if (exportDashBtn) { exportDashboardHTML(); return; }

  const exportDashPdfBtn = e.target.closest("[data-export-dashboard-pdf]");
  if (exportDashPdfBtn) { exportDashboardPDF(); return; }

  const exportPagosPdfBtn = e.target.closest("[data-export-pagos-pdf]");
  if (exportPagosPdfBtn) { modalExportPagos(); return; }

  const dashRangeBtn = e.target.closest("[data-dash-range]");
  if (dashRangeBtn) { state.dashRange = dashRangeBtn.dataset.dashRange; render(); return; }

  const registrarPagoBtn = e.target.closest("[data-registrar-pago]");
  if (registrarPagoBtn) { modalRegistrarPagoPanel(); return; }

  // ── Gestión de usuarios (admin) ──
  const newUserBtn = e.target.closest("[data-new-user]");
  if (newUserBtn) { modalNuevoUsuario(); return; }

  const editUserBtn = e.target.closest("[data-edit-user]");
  if (editUserBtn) { modalEditarUsuario(editUserBtn.dataset.editUser); return; }

  const delUserBtn = e.target.closest("[data-del-user]");
  if (delUserBtn) {
    const u = USERS.find(x => x.id === delUserBtn.dataset.delUser);
    modalConfirmarEliminar({
      titulo: "Eliminar Usuario",
      mensaje: `¿Confirmás la eliminación de la cuenta <b>${esc(u ? (u.nombre || u.username) : "")}</b>? No podrá volver a acceder al sistema.`,
      onConfirmAttr: "data-confirm-del-user",
      onConfirmValue: delUserBtn.dataset.delUser,
    });
    return;
  }
});

content.addEventListener("change", e => {
  if (e.target.id === "courseFilterSelect")  { state.courseFilter  = e.target.value; render(); }
  if (e.target.id === "dayFilterSelect")     { state.dayFilter     = e.target.value; render(); }
  if (e.target.id === "empresaFilterSelect") { state.empresaFilter = e.target.value; render(); }
  if (e.target.id === "pagosCourseSelect")   { state.pagosCourse   = e.target.value; render(); }
  if (e.target.id === "pagosEmpresaSelect")  { state.pagosEmpresa  = e.target.value; render(); }
  if (e.target.id === "pagosEstadoSelect")   { state.pagosEstado   = e.target.value; render(); }
  if (e.target.id === "pagosSortSelect")     { state.pagosSort     = e.target.value; render(); }

  const estadoSel = e.target.closest("[data-estado-select]");
  if (estadoSel) {
    const s = getStudent(estadoSel.dataset.estadoSelect);
    if (s) {
      s.estado = ESTADOS.includes(estadoSel.value) ? estadoSel.value : "activo";
      saveData(); toast(`Estado: ${estadoLabel(s.estado)}.`); render();
    }
  }
});

// Grupos desplegables del Registro de Pagos: persistir estado abierto entre renders.
// El evento "toggle" no burbujea; se escucha en fase de captura.
content.addEventListener("toggle", e => {
  const g = e.target.closest && e.target.closest("[data-pay-group]");
  if (!g) return;
  const id = g.dataset.payGroup;
  if (g.open) state.pagosOpen[id] = true; else delete state.pagosOpen[id];
}, true);

// Búsqueda en el panel de pagos (re-render preservando el foco del input)
content.addEventListener("input", e => {
  if (e.target.id === "pagosSearchInput") {
    state.pagosSearch = e.target.value;
    render();
    const el = document.getElementById("pagosSearchInput");
    if (el) { el.focus(); const v = el.value; el.setSelectionRange(v.length, v.length); }
  }
  if (e.target.id === "empresaSearchInput") {
    state.empresaSearch = e.target.value;
    render();
    const el = document.getElementById("empresaSearchInput");
    if (el) { el.focus(); const v = el.value; el.setSelectionRange(v.length, v.length); }
  }
});

content.addEventListener("submit", e => {
  if (e.target.id === "soporteForm") {
    e.preventDefault();
    const fd = new FormData(e.target);
    const asunto = (fd.get("asunto") || "").trim();
    const mensaje = (fd.get("mensaje") || "").trim();
    if (!mensaje) { toast("Escribí un mensaje."); return; }
    const btn = e.target.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    fetch("/api/soporte", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ asunto, mensaje }) })
      .then(async res => {
        const j = await res.json().catch(() => ({}));
        if (!res.ok) { toast(j.error || "No se pudo enviar."); if (btn) btn.disabled = false; return; }
        e.target.reset();
        if (btn) btn.disabled = false;
        toast(j.enviado ? "Mensaje enviado. ¡Gracias!" : "Mensaje recibido. ¡Gracias!");
      })
      .catch(() => { toast("Error de red."); if (btn) btn.disabled = false; });
    return;
  }

  if (e.target.id !== "regForm") return;
  e.preventDefault();
  const fd = new FormData(e.target);
  const nombre = fd.get("nombre").trim();
  const apellido = fd.get("apellido").trim();
  if (!nombre || !apellido) return;

  const enrollments = [];
  e.target.querySelectorAll(".enrollment-block").forEach(block => {
    const i = block.dataset.enr;
    const courseId = fd.get(`enr_course_${i}`);
    if (courseId) {
      enrollments.push({
        enrollId: `ENR-${Date.now()}-${i}`,
        courseId,
        tutors: (fd.get(`enr_tutors_${i}`) || "").split(",").map(t => t.trim()).filter(Boolean),
        startDate: fd.get(`enr_start_${i}`) || "",
        estimatedEnd: fd.get(`enr_end_${i}`) || "",
        completed: false,
        classes: [],
        attendance: []
      });
    }
  });

  const pkgHours = parseInt(fd.get("packageHours") || 0) || null;
  const id = "STU-" + Date.now();
  STUDENTS.push({
    id, name: nombre, surname: apellido,
    phone: fd.get("telefono") || "",
    email: fd.get("email") || "",
    modality: fd.get("modalidad") || "",
    diasClase: fd.getAll("diasClase"),
    horario: fd.get("horario") || "",
    empresaId: fd.get("empresaId") || "",
    contact2Name: fd.get("c2nombre") || "",
    contact2Relation: fd.get("c2parentesco") || "",
    contact2Phone: fd.get("c2telefono") || "",
    caracteristicas: fd.get("caracteristicas") || "",
    estado: "activo",
    payment: { type: fd.get("paytype") || "mensual", amount: parseInt(fd.get("amount") || 0), packageHours: pkgHours },
    payments: [],
    attendance: [],
    enrollments
  });
  saveData();
  toast(`Alumno ${nombre} ${apellido} registrado correctamente.`);
  go("detalle", id, 0);
});

// ====== Event: Modal ======
modalOverlay.addEventListener("click", e => {
  if (e.target === modalOverlay) { closeModal(); return; }

  if (e.target.closest("[data-modal-close]")) { closeModal(); return; }

  const editTopicBtn = e.target.closest("[data-edit-topic]");
  if (editTopicBtn) { if (isAdmin()) modalEditarTema(editTopicBtn.dataset.editTopic, editTopicBtn.dataset.topicIdx); return; }

  const delTopicBtn = e.target.closest("[data-del-topic]");
  if (delTopicBtn) {
    if (!isAdmin()) return;
    const c = getCourse(delTopicBtn.dataset.delTopic);
    const i = parseInt(delTopicBtn.dataset.topicIdx);
    const topic = c && c.topics ? c.topics[i] : "";
    modalConfirmarEliminar({
      titulo: "Eliminar Tema",
      mensaje: `¿Confirmás la eliminación del tema <b>${esc(topic || "")}</b>? Las clases ya registradas con este tema se conservan.`,
      onConfirmAttr: "data-confirm-del-topic",
      onConfirmValue: `${delTopicBtn.dataset.delTopic}__${i}`,
    });
    return;
  }

  const confirmDelTopic = e.target.closest("[data-confirm-del-topic]");
  if (confirmDelTopic) {
    if (!isAdmin()) return;
    const [courseId, idx] = confirmDelTopic.dataset.confirmDelTopic.split("__");
    const c = getCourse(courseId);
    if (c && c.topics) { c.topics.splice(parseInt(idx), 1); saveData(); toast("Tema eliminado."); render(); }
    modalVerTemas(courseId);
    return;
  }

  const confirmDel = e.target.closest("[data-confirm-delete]");
  if (confirmDel) {
    const id = confirmDel.dataset.confirmDelete;
    STUDENTS = STUDENTS.filter(s => s.id !== id);
    saveData(); closeModal(); toast("Alumno eliminado.");
    go("lista");
    return;
  }

  const confirmDelClass = e.target.closest("[data-confirm-del-class]");
  if (confirmDelClass) {
    const [enrollId, idx] = confirmDelClass.dataset.confirmDelClass.split("__");
    const r = findEnrollment(enrollId);
    if (r) { r.enr.classes.splice(parseInt(idx), 1); saveData(); toast("Clase eliminada."); }
    closeModal(); render();
    return;
  }

  const confirmDelPay = e.target.closest("[data-confirm-del-pay]");
  if (confirmDelPay) {
    const [studentId, idx] = confirmDelPay.dataset.confirmDelPay.split("__");
    const s = getStudent(studentId);
    if (s && s.payments) { s.payments.splice(parseInt(idx), 1); saveData(); toast("Pago eliminado."); }
    closeModal(); render();
    return;
  }

  const confirmDelPayEmp = e.target.closest("[data-confirm-del-pay-emp]");
  if (confirmDelPayEmp) {
    const [empresaId, payId] = confirmDelPayEmp.dataset.confirmDelPayEmp.split("__");
    const c = getCompany(empresaId);
    if (c && c.pagosEmpresa) { c.pagosEmpresa = c.pagosEmpresa.filter(p => p.id !== payId); saveData(); toast("Pago eliminado."); }
    closeModal(); render();
    return;
  }

  const confirmDelCourse = e.target.closest("[data-confirm-del-course]");
  if (confirmDelCourse) {
    if (!isAdmin()) return;
    const id = confirmDelCourse.dataset.confirmDelCourse;
    COURSES = COURSES.filter(c => c.id !== id);
    saveData(); closeModal(); toast("Curso eliminado."); render();
    return;
  }

  const confirmDelEmpresa = e.target.closest("[data-confirm-del-empresa]");
  if (confirmDelEmpresa) {
    const id = confirmDelEmpresa.dataset.confirmDelEmpresa;
    COMPANIES = COMPANIES.filter(c => c.id !== id);
    saveData(); closeModal(); toast("Empresa eliminada."); render();
    return;
  }

  const confirmDelUser = e.target.closest("[data-confirm-del-user]");
  if (confirmDelUser) {
    const id = confirmDelUser.dataset.confirmDelUser;
    fetch(`/api/users/${id}`, { method: "DELETE" })
      .then(async res => {
        const j = await res.json().catch(() => ({}));
        if (!res.ok) { toast(j.error || "No se pudo eliminar."); return; }
        toast("Usuario eliminado.");
        await loadUsers(); render();
      })
      .catch(() => toast("Error de red."));
    closeModal();
    return;
  }

  const confirmDelAttend = e.target.closest("[data-confirm-del-attend]");
  if (confirmDelAttend) {
    const [enrollId, idx] = confirmDelAttend.dataset.confirmDelAttend.split("__");
    const r = findEnrollment(enrollId);
    if (r) { r.enr.attendance.splice(parseInt(idx), 1); saveData(); toast("Registro de asistencia eliminado."); }
    closeModal(); render();
    return;
  }

  const confirmDelAttendGen = e.target.closest("[data-confirm-del-attend-gen]");
  if (confirmDelAttendGen) {
    const [studentId, idx] = confirmDelAttendGen.dataset.confirmDelAttendGen.split("__");
    const s = getStudent(studentId);
    if (s && s.attendance) { s.attendance.splice(parseInt(idx), 1); saveData(); toast("Registro de asistencia eliminado."); }
    closeModal(); render();
    return;
  }

  const confirmComplete = e.target.closest("[data-confirm-complete]");
  if (confirmComplete) {
    const r = findEnrollment(confirmComplete.dataset.confirmComplete);
    if (r) { r.enr.completed = true; saveData(); toast("Curso marcado como finalizado."); }
    closeModal(); render();
    return;
  }

  const doPdfBtn = e.target.closest("[data-do-pdf]");
  if (doPdfBtn) {
    const studentId = doPdfBtn.dataset.doPdf;
    const s = getStudent(studentId);
    const incluirCaracteristicas = document.getElementById("chkPdfCaracteristicas")?.checked ?? true;
    const incluirAsistencia = document.getElementById("chkPdfAsistencia")?.checked ?? true;
    const incluirPagos = document.getElementById("chkPdfPagos")?.checked ?? true;
    const observaciones = (document.getElementById("pdfObservaciones")?.value || "").trim();
    const selectedEnrollments = [];
    if (s) {
      modalBox.querySelectorAll('.chk-enr:checked').forEach(chk => {
        const idx = parseInt(chk.dataset.enrIdx);
        selectedEnrollments.push({
          idx,
          tutors: (modalBox.querySelector(`.enr-tutors[data-enr-idx="${idx}"]`)?.value || '')
                    .split(',').map(t => t.trim()).filter(Boolean),
          startDate:    modalBox.querySelector(`.enr-start[data-enr-idx="${idx}"]`)?.value  || '',
          estimatedEnd: modalBox.querySelector(`.enr-end[data-enr-idx="${idx}"]`)?.value    || '',
        });
      });
    }
    const soloAsistencia = document.getElementById("chkPdfSoloAsistencia")?.checked ?? false;
    closeModal();
    downloadPDF(studentId, { incluirCaracteristicas, incluirPagos, incluirAsistencia, observaciones, selectedEnrollments, soloAsistencia });
    return;
  }

  const doPdfEmpresaBtn = e.target.closest("[data-do-pdf-empresa]");
  if (doPdfEmpresaBtn) {
    const empresaId = doPdfEmpresaBtn.dataset.doPdfEmpresa;
    const selectedIds = [...modalBox.querySelectorAll(".chk-pdf-student:checked")].map(c => c.value);
    const incluirAsistencia = document.getElementById("chkEmpPdfAsistencia")?.checked ?? true;
    const incluirPagos      = document.getElementById("chkEmpPdfPagos")?.checked ?? true;
    const incluirCaracteristicas = document.getElementById("chkEmpPdfCaracteristicas")?.checked ?? true;
    const soloAsistencia = document.getElementById("chkEmpPdfSoloAsistencia")?.checked ?? false;
    const selectedCourseIds = [...modalBox.querySelectorAll(".chk-pdf-course:checked")].map(c => c.value);
    closeModal();
    downloadPDFEmpresa(empresaId, selectedIds, { incluirAsistencia, incluirPagos, incluirCaracteristicas, soloAsistencia, selectedCourseIds });
    return;
  }
});

modalOverlay.addEventListener("change", e => {
  const hwToggleChk = e.target.closest("[data-toggle-course-hw]");
  if (hwToggleChk && !isAdmin()) return;
  if (hwToggleChk) {
    const c = getCourse(hwToggleChk.dataset.toggleCourseHw);
    if (c) { c.hasHomework = hwToggleChk.checked; saveData(); toast(c.hasHomework ? "Homework activado." : "Homework desactivado."); }
  }
  const manualToggleChk = e.target.closest("[data-toggle-course-manual]");
  if (manualToggleChk && !isAdmin()) return;
  if (manualToggleChk) {
    const c = getCourse(manualToggleChk.dataset.toggleCourseManual);
    if (c) { c.allowManual = manualToggleChk.checked; saveData(); toast(c.allowManual ? "Carga manual activada." : "Carga manual desactivada."); render(); }
  }
});

modalOverlay.addEventListener("submit", e => {
  if (e.target.id === "certificadoForm") {
    e.preventDefault();
    const fd = new FormData(e.target);
    const tipo = fd.get("tipo") === "ingles" ? "ingles" : "informatica";
    if (tipo === "informatica" && !(fd.get("curso") || "").trim()) { toast("Ingresá el nombre del curso."); return; }
    if (tipo === "ingles" && !(fd.get("sistema") || "").trim()) { toast("Ingresá el sistema (ej. Full Conversation)."); return; }
    const opts = {
      tipo, curso: fd.get("curso"), sector: fd.get("sector"),
      sistema: fd.get("sistema"), nivel: fd.get("nivel"),
      horas: fd.get("horas"), fecha: fd.get("fecha"), lugar: fd.get("lugar"),
    };
    if (fd.get("formato") === "pdf") generarCertificadoPDF(e.target.dataset.student, opts);
    else generarCertificadoPPTX(e.target.dataset.student, opts);
    closeModal();
    return;
  }

  if (e.target.id === "courseNotesForm") {
    e.preventDefault();
    if (!isAdmin()) return;
    const c = getCourse(e.target.dataset.course);
    if (c) { c.notes = (new FormData(e.target).get("notes") || "").trim(); saveData(); toast("Notas del curso guardadas."); }
    return;
  }

  if (e.target.id === "editTopicForm") {
    e.preventDefault();
    if (!isAdmin()) return;
    const c = getCourse(e.target.dataset.course);
    const i = parseInt(e.target.dataset.idx);
    const nuevo = (new FormData(e.target).get("topic") || "").trim();
    if (!c || !c.topics || !c.topics[i] || !nuevo) return;
    const viejo = c.topics[i];
    if (nuevo !== viejo) {
      if (c.topics.includes(nuevo)) { toast("Ya existe un tema con ese nombre."); return; }
      c.topics[i] = nuevo;
      // Actualizar las clases ya registradas con el tema anterior para no desasociarlas
      STUDENTS.forEach(s => (s.enrollments || []).forEach(enr => {
        if (enr.courseId === c.id) (enr.classes || []).forEach(cl => { if (cl.topic === viejo) cl.topic = nuevo; });
      }));
      saveData(); render();
    }
    toast("Tema actualizado.");
    modalVerTemas(c.id);
    return;
  }

  if (e.target.id === "miCuentaForm") {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = { nombre: (fd.get("nombre") || "").trim(), username: (fd.get("username") || "").trim().toLowerCase() };
    const pw = fd.get("password");
    if (pw) body.password = pw;
    const cur = fd.get("currentPassword");
    if (cur) body.currentPassword = cur;
    fetch("/api/me", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(async res => {
        const j = await res.json().catch(() => ({}));
        if (!res.ok) { toast(j.error || "No se pudo guardar."); return; }
        closeModal(); toast("Cuenta actualizada."); await loadMe();
        if (state.view === "usuarios") { await loadUsers(); }
        render();
      })
      .catch(() => toast("Error de red."));
    return;
  }

  if (e.target.id === "userForm") {
    e.preventDefault();
    const fd = new FormData(e.target);
    const mode = e.target.dataset.mode;
    if (mode === "create") {
      const body = {
        nombre:   (fd.get("nombre") || "").trim(),
        username: (fd.get("username") || "").trim().toLowerCase(),
        password: fd.get("password") || "",
        role:     fd.get("role") || "usuario",
      };
      fetch("/api/users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
        .then(async res => {
          const j = await res.json().catch(() => ({}));
          if (!res.ok) { toast(j.error || "No se pudo crear el usuario."); return; }
          closeModal(); toast("Usuario creado."); await loadUsers(); render();
        })
        .catch(() => toast("Error de red."));
    } else {
      const id = e.target.dataset.id;
      const body = {
        nombre:   (fd.get("nombre") || "").trim(),
        username: (fd.get("username") || "").trim().toLowerCase(),
        role:     fd.get("role") || undefined,
        activo:   fd.get("activo") === "on",
      };
      const pw = fd.get("password");
      if (pw) body.password = pw;
      fetch(`/api/users/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
        .then(async res => {
          const j = await res.json().catch(() => ({}));
          if (!res.ok) { toast(j.error || "No se pudo guardar."); return; }
          closeModal(); toast("Usuario actualizado."); await loadUsers(); render();
        })
        .catch(() => toast("Error de red."));
    }
    return;
  }

  if (e.target.id === "addClaseForm") {
    e.preventDefault();
    const fd = new FormData(e.target);
    const r = findEnrollment(e.target.dataset.enr);
    if (r) {
      const date = fd.get("date");
      const startTime = fd.get("startTime") || "";
      const endTime = fd.get("endTime") || "";
      const modality = fd.get("modality") || "";
      let hours = 0;
      if (startTime && endTime) {
        const [sh, sm] = startTime.split(":").map(Number);
        const [eh, em] = endTime.split(":").map(Number);
        hours = Math.max(0, Math.round(((eh * 60 + em) - (sh * 60 + sm)) / 60 * 10) / 10);
      }
      const hwTask = (fd.get("hwTask") || "").trim();
      r.enr.classes.push({
        date, startTime, endTime, modality,
        topic: fd.get("topic"),
        professor: fd.get("professor"),
        observations: fd.get("observations") || "",
        ...(hwTask ? { homework: { task: hwTask, done: false } } : {})
      });
      if (!r.student.attendance) r.student.attendance = [];
      if (!r.student.attendance.some(a => a.date === date)) {
        r.student.attendance.push({ date, present: true, hours });
      }
      saveData(); closeModal(); toast("Clase registrada."); render();
    }
    return;
  }

  if (e.target.id === "editHomeworkForm") {
    e.preventDefault();
    const fd = new FormData(e.target);
    const r = findEnrollment(e.target.dataset.enr);
    const idx = parseInt(e.target.dataset.idx);
    if (r && r.enr.classes[idx] && r.enr.classes[idx].homework) {
      r.enr.classes[idx].homework.task = (fd.get("hwTask") || "").trim();
      saveData(); closeModal(); toast("Homework actualizado."); render();
    }
    return;
  }

  if (e.target.id === "editClaseForm") {
    e.preventDefault();
    const fd = new FormData(e.target);
    const r = findEnrollment(e.target.dataset.enr);
    const idx = parseInt(e.target.dataset.idx);
    if (r && r.enr.classes[idx]) {
      const cl = r.enr.classes[idx];
      const oldDate = cl.date;
      const newDate = fd.get("date");
      const startTime = fd.get("startTime") || "";
      const endTime = fd.get("endTime") || "";
      let hours = cl.date === newDate ? ((r.student.attendance || []).find(a => a.date === oldDate)?.hours || 0) : 0;
      if (startTime && endTime) {
        const [sh, sm] = startTime.split(":").map(Number);
        const [eh, em] = endTime.split(":").map(Number);
        hours = Math.max(0, Math.round(((eh * 60 + em) - (sh * 60 + sm)) / 60 * 10) / 10);
      }
      cl.date = newDate;
      cl.startTime = startTime;
      cl.endTime = endTime;
      cl.modality = fd.get("modality") || "";
      const hwTaskOldEdit = fd.get("hwTaskOld");
      const hwTaskEdit    = fd.get("hwTask");
      if (hwTaskOldEdit !== null) {
        cl.topic = "HOMEWORK\n" + hwTaskOldEdit.trim();
      } else {
        cl.topic = fd.get("topic") || cl.topic;
        if (hwTaskEdit !== null) {
          const trimmedHw = hwTaskEdit.trim();
          if (trimmedHw) {
            cl.homework = { task: trimmedHw, done: cl.homework ? cl.homework.done : false };
          } else {
            delete cl.homework;
          }
        }
      }
      cl.professor = fd.get("professor") || "";
      cl.observations = fd.get("observations") || "";
      if (oldDate !== newDate && r.student.attendance) {
        const att = r.student.attendance.find(a => a.date === oldDate);
        if (att) { att.date = newDate; att.hours = hours; }
      }
      saveData(); closeModal(); toast("Clase actualizada."); render();
    }
    return;
  }

  if (e.target.id === "exportPagosForm") {
    e.preventDefault();
    const scope = e.target.dataset.scope === "empresas" ? "empresas" : "alumnos";
    const years = new Set([...e.target.querySelectorAll(".exp-year:checked")].map(c => c.value));
    const months = new Set([...e.target.querySelectorAll(".exp-month:checked")].map(c => c.value));

    let periodLabel = "Todos los períodos";
    if (years.size || months.size) {
      const yl = years.size ? [...years].sort().join(", ") : "Todos los años";
      const ml = months.size ? [...months].sort().map(m => MESES_PDF.find(x => x[0] === m)[1]).join(", ") : "Todos los meses";
      periodLabel = `${yl} · ${ml}`;
    }
    const formato = e.target.querySelector('input[name="expFormato"]:checked')?.value || "pdf";

    if (scope === "empresas") {
      const companyFilter = e.target.querySelector('input[name="companyFilter"]:checked')?.value || "todas";
      const companyIds = new Set([...e.target.querySelectorAll(".exp-company:checked")].map(c => c.value));
      if (companyFilter === "especificas" && companyIds.size === 0) { toast("Seleccioná al menos una empresa."); return; }
      let filterLabel = "Todas las empresas";
      if (companyFilter === "especificas") {
        const names = COMPANIES.filter(c => companyIds.has(c.id)).map(c => c.name);
        filterLabel = names.length <= 3 ? names.join(", ") : `${names.length} empresas seleccionadas`;
      }
      closeModal();
      const opts = { scope, companyFilter, companyIds, years, months, periodLabel, filterLabel };
      if (formato === "xlsx") exportEmpresasXLSX(opts);
      else exportEmpresasPDF(opts);
      return;
    }

    const studentFilter = e.target.querySelector('input[name="studentFilter"]:checked')?.value || "todos";
    const studentIds = new Set([...e.target.querySelectorAll(".exp-student:checked")].map(c => c.value));
    const excludeEmpresa = !!e.target.querySelector("#expExcludeEmpresa")?.checked;
    if (studentFilter === "especificos" && studentIds.size === 0) { toast("Seleccioná al menos un alumno."); return; }
    let filterLabel = { todos: "Todos los alumnos", pendiente: "Con pago pendiente", alDia: "Sin pendientes (al día)" }[studentFilter];
    if (studentFilter === "especificos") {
      const names = STUDENTS.filter(s => studentIds.has(s.id)).map(s => `${esc(s.name)} ${esc(s.surname)}`);
      filterLabel = names.length <= 3 ? names.join(", ") : `${names.length} alumnos seleccionados`;
    }
    if (excludeEmpresa) filterLabel += " (sin alumnos de empresas)";
    closeModal();
    const opts = { scope, studentFilter, studentIds, excludeEmpresa, years, months, periodLabel, filterLabel };
    if (formato === "xlsx") exportPagosXLSX(opts);
    else exportPagosPDF(opts);
    return;
  }

  if (e.target.id === "panelPagoForm") {
    e.preventDefault();
    const fd = new FormData(e.target);
    const s = getStudent(fd.get("studentId"));
    if (!s) { toast("Seleccioná un alumno."); return; }
    if (!s.payments) s.payments = [];
    s.payments.push({
      date: fd.get("date"),
      concept: fd.get("concept"),
      amount: parseInt(fd.get("amount") || 0),
      paid: fd.get("paid") === "on",
    });
    s.payments.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    saveData(); closeModal(); toast(`Pago registrado para ${s.name} ${s.surname}.`); render();
    return;
  }

  if (e.target.id === "addPagoForm") {
    e.preventDefault();
    const fd = new FormData(e.target);
    const s = getStudent(e.target.dataset.student);
    if (s) {
      if (!s.payments) s.payments = [];
      s.payments.push({
        date: fd.get("date"),
        concept: fd.get("concept"),
        amount: parseInt(fd.get("amount") || 0),
        paid: fd.get("paid") === "on"
      });
      s.payments.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
      saveData(); closeModal(); toast("Pago registrado."); render();
    }
    return;
  }

  if (e.target.id === "editPagoForm") {
    e.preventDefault();
    const fd = new FormData(e.target);
    const s = getStudent(e.target.dataset.student);
    const idx = parseInt(e.target.dataset.idx);
    if (s && s.payments && s.payments[idx]) {
      s.payments[idx].date    = fd.get("date");
      s.payments[idx].concept = fd.get("concept");
      s.payments[idx].amount  = parseInt(fd.get("amount") || 0);
      s.payments[idx].paid    = fd.get("paid") === "on";
      s.payments.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
      saveData(); closeModal(); toast("Pago actualizado."); render();
    }
    return;
  }

  if (e.target.id === "editPagoEmpresaForm") {
    e.preventDefault();
    const fd = new FormData(e.target);
    const c = getCompany(e.target.dataset.empresa);
    const p = c && (c.pagosEmpresa || []).find(x => x.id === e.target.dataset.payId);
    if (p) {
      p.studentId = fd.get("studentId") || null;
      p.date      = fd.get("date");
      p.concept   = fd.get("concept");
      p.amount    = parseInt(fd.get("amount") || 0);
      p.paid      = fd.get("paid") === "on";
      saveData(); closeModal(); toast("Pago actualizado."); render();
    }
    return;
  }

  if (e.target.id === "newCourseForm") {
    e.preventDefault();
    if (!isAdmin()) return;
    const fd = new FormData(e.target);
    const name = fd.get("name").trim();
    if (!name) return;
    const topics = (fd.get("topics") || "").split("\n").map(t => t.trim()).filter(Boolean);
    const id = name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "") + "-" + Date.now();
    COURSES.push({ id, name, topics, hasHomework: fd.get("hasHomework") === "on", allowManual: fd.get("allowManual") === "on", notes: (fd.get("notes") || "").trim() });
    saveData(); closeModal(); toast(`Curso "${name}" creado.`); render();
    return;
  }

  if (e.target.id === "addEmpresaForm") {
    e.preventDefault();
    const fd = new FormData(e.target);
    const nombre = fd.get("nombre").trim();
    if (!nombre) return;
    COMPANIES.push({
      id: "CMP-" + Date.now(),
      name: nombre,
      ruc: fd.get("ruc") || "",
      phone: fd.get("telefono") || "",
      email: fd.get("email") || "",
      address: fd.get("direccion") || "",
      modality: fd.get("modalidad") || "",
      diasClase: fd.getAll("diasClase"),
      horario: fd.get("horario") || "",
      contactName: fd.get("contactNombre") || "",
      contactRole: fd.get("contactCargo") || "",
      contactPhone: fd.get("contactTelefono") || "",
    });
    saveData(); closeModal(); toast(`Empresa "${nombre}" creada.`); render();
    return;
  }

  if (e.target.id === "editEmpresaForm") {
    e.preventDefault();
    const fd = new FormData(e.target);
    const c = getCompany(e.target.dataset.empresa);
    if (!c) return;
    const nombre = fd.get("nombre").trim();
    if (!nombre) return;
    c.name         = nombre;
    c.ruc          = fd.get("ruc") || "";
    c.phone        = fd.get("telefono") || "";
    c.email        = fd.get("email") || "";
    c.address      = fd.get("direccion") || "";
    c.modality     = fd.get("modalidad") || "";
    c.diasClase    = fd.getAll("diasClase");
    c.horario      = fd.get("horario") || "";
    c.contactName  = fd.get("contactNombre") || "";
    c.contactRole  = fd.get("contactCargo") || "";
    c.contactPhone = fd.get("contactTelefono") || "";
    saveData(); closeModal(); toast("Empresa actualizada."); render();
    return;
  }

  if (e.target.id === "addTopicForm") {
    e.preventDefault();
    if (!isAdmin()) return;
    const fd = new FormData(e.target);
    const topic = fd.get("topic").trim();
    const c = getCourse(e.target.dataset.course);
    if (c && topic) { c.topics.push(topic); saveData(); toast("Tema agregado."); modalVerTemas(e.target.dataset.course); }
    return;
  }

  if (e.target.id === "editStudentForm") {
    e.preventDefault();
    const fd = new FormData(e.target);
    const s = getStudent(e.target.dataset.student);
    if (!s) return;
    s.name = fd.get("nombre").trim();
    s.surname = fd.get("apellido").trim();
    s.phone = fd.get("telefono").trim();
    s.email = fd.get("email").trim();
    s.modality = fd.get("modalidad") || "";
    s.diasClase  = fd.getAll("diasClase");
    s.horario    = fd.get("horario") || "";
    s.empresaId  = fd.get("empresaId") || "";
    s.contact2Name = fd.get("c2nombre").trim();
    s.contact2Relation = fd.get("c2parentesco");
    s.contact2Phone = fd.get("c2telefono").trim();
    s.caracteristicas = fd.get("caracteristicas") || "";
    saveData(); closeModal(); toast("Datos actualizados."); render();
    return;
  }

  if (e.target.id === "informeForm") {
    e.preventDefault();
    const fd = new FormData(e.target);
    const s = getStudent(e.target.dataset.student);
    if (!s) return;
    if ((fd.get("formato") || "basico") === "avanzado") {
      const text = buildInformeAvanzado({
        profesor: fd.get("profesor"), horarioGeneral: fd.get("horarioGeneral"),
        nombres: fd.get("nombres"), cursos: fd.get("cursos"), horarioClase: fd.get("horarioClase"),
        inicio: fd.get("inicio"), fin: fd.get("fin"),
        desarrollo: fd.get("desarrollo"), observacion: fd.get("observacion"),
        ausentes: fd.get("ausentes"), siguiente: fd.get("siguiente"),
      });
      if (!text.trim()) { toast("Completá al menos el desarrollo del informe."); return; }
      closeModal(); clipboardWrite(text);
    } else {
      const date = fd.get("date");
      if (!date) { toast("Seleccioná una fecha."); return; }
      const text = buildInformeText(s, date);
      if (!text) { toast("No hay clases registradas en esa fecha."); return; }
      closeModal(); clipboardWrite(text);
    }
    return;
  }

  if (e.target.id === "addAttendForm") {
    e.preventDefault();
    const fd = new FormData(e.target);
    const enrollId = e.target.dataset.enr || fd.get("enrollId") || "";
    const r = findEnrollment(enrollId);
    if (r) {
      if (!r.enr.attendance) r.enr.attendance = [];
      r.enr.attendance.push({
        date: fd.get("date"),
        present: fd.get("present") === "true",
        hours: parseFloat(fd.get("hours") || 0) || 0
      });
      saveData(); closeModal(); toast("Asistencia registrada."); render();
    }
    return;
  }

  if (e.target.id === "addAttendGenForm") {
    e.preventDefault();
    const fd = new FormData(e.target);
    const s = getStudent(e.target.dataset.student);
    if (s) {
      if (!s.attendance) s.attendance = [];
      const obs = (fd.get("observations") || "").trim();
      s.attendance.push({
        date: fd.get("date"),
        present: fd.get("present") === "true",
        hours: parseFloat(fd.get("hours") || 0) || 0,
        ...(obs ? { observations: obs } : {})
      });
      saveData(); closeModal(); toast("Asistencia registrada."); render();
    }
    return;
  }

  if (e.target.id === "editAttendGenForm") {
    e.preventDefault();
    const fd = new FormData(e.target);
    const s = getStudent(e.target.dataset.student);
    const idx = parseInt(e.target.dataset.idx);
    if (s && s.attendance && s.attendance[idx]) {
      s.attendance[idx].date    = fd.get("date");
      s.attendance[idx].present = fd.get("present") === "true";
      s.attendance[idx].hours   = parseFloat(fd.get("hours") || 0) || 0;
      const obs = (fd.get("observations") || "").trim();
      if (obs) { s.attendance[idx].observations = obs; } else { delete s.attendance[idx].observations; }
      saveData(); closeModal(); toast("Asistencia actualizada."); render();
    }
    return;
  }

  if (e.target.id === "editEnrCourseForm") {
    e.preventDefault();
    const fd = new FormData(e.target);
    const r = findEnrollment(e.target.dataset.enr);
    if (!r) return;
    r.enr.courseId = fd.get("courseId");
    saveData(); closeModal(); toast("Curso actualizado."); render();
    return;
  }

  if (e.target.id === "editEnrDatesForm") {
    e.preventDefault();
    const fd = new FormData(e.target);
    const r = findEnrollment(e.target.dataset.enr);
    if (!r) return;
    r.enr.startDate = fd.get("startDate") || "";
    r.enr.estimatedEnd = fd.get("endDate") || "";
    saveData(); closeModal(); toast("Fechas actualizadas."); render();
    return;
  }

  if (e.target.id === "editEnrTutorsForm") {
    e.preventDefault();
    const fd = new FormData(e.target);
    const r = findEnrollment(e.target.dataset.enr);
    if (!r) return;
    r.enr.tutors = (fd.get("tutors") || "").split(",").map(t => t.trim()).filter(Boolean);
    saveData(); closeModal(); toast("Tutores actualizados."); render();
    return;
  }

  if (e.target.id === "editPayConfigForm") {
    e.preventDefault();
    const fd = new FormData(e.target);
    const s = getStudent(e.target.dataset.student);
    if (!s) return;
    const pkgHours = parseInt(fd.get("packageHours") || 0) || null;
    s.payment = {
      type:         fd.get("paytype") || "mensual",
      amount:       parseInt(fd.get("amount") || 0),
      packageHours: pkgHours,
    };
    saveData(); closeModal(); toast("Configuración de pago actualizada."); render();
    return;
  }

  if (e.target.id === "addEnrollForm") {
    e.preventDefault();
    const fd = new FormData(e.target);
    const s = getStudent(e.target.dataset.student);
    if (!s) return;
    s.enrollments.push({
      enrollId: `ENR-${Date.now()}`,
      courseId: fd.get("courseId"),
      tutors: (fd.get("tutors") || "").split(",").map(t => t.trim()).filter(Boolean),
      startDate: fd.get("startDate") || "",
      estimatedEnd: fd.get("endDate") || "",
      completed: false,
      classes: [],
      attendance: []
    });
    state.currentEnrollIdx = s.enrollments.length - 1;
    saveData(); closeModal(); toast("Curso agregado al alumno."); render();
    return;
  }

  if (e.target.id === "claseGrupoForm") {
    e.preventDefault();
    const fd = new FormData(e.target);
    const empresaId = e.target.dataset.empresa;
    const courseId  = fd.get("courseId");
    const date      = fd.get("date");
    const startTime = fd.get("startTime") || "";
    const endTime   = fd.get("endTime") || "";
    const modality  = fd.get("modality") || "";
    const topic     = (fd.get("topic") || "").trim();
    const professor = (fd.get("professor") || "").trim();
    const observations = fd.get("observations") || "";

    if (!courseId) { toast("Seleccioná un curso."); return; }
    if (!topic)    { toast("Ingresá el desarrollo temático."); return; }
    if (!professor){ toast("Ingresá el nombre del profesor."); return; }

    let hours = 0;
    if (startTime && endTime) {
      const [sh, sm] = startTime.split(":").map(Number);
      const [eh, em] = endTime.split(":").map(Number);
      hours = Math.max(0, Math.round(((eh * 60 + em) - (sh * 60 + sm)) / 60 * 10) / 10);
    }

    const selectedStudentIds = fd.getAll("studentIds");
    if (selectedStudentIds.length === 0) { toast("Seleccioná al menos un alumno."); return; }

    let count = 0;
    selectedStudentIds.forEach(studentId => {
      const s = getStudent(studentId);
      if (!s) return;
      const enr = s.enrollments.find(enr => enr.courseId === courseId);
      if (!enr) return;
      if (!enr.classes) enr.classes = [];
      enr.classes.push({ date, startTime, endTime, modality, topic, professor, observations });
      if (!s.attendance) s.attendance = [];
      if (!s.attendance.some(a => a.date === date)) {
        s.attendance.push({ date, present: true, hours });
      }
      count++;
    });

    if (count > 0) {
      saveData(); closeModal();
      toast(`Clase registrada para ${count} alumno${count !== 1 ? "s" : ""}.`);
      render();
    } else {
      toast("Ningún alumno seleccionado tiene inscripción en el curso elegido.");
    }
    return;
  }

  if (e.target.id === "informeEmpresaForm") {
    e.preventDefault();
    const fd = new FormData(e.target);
    const date = fd.get("date");
    const empresaId = e.target.dataset.empresa;
    if (!date) return;
    const selectedStudentIds = [...modalBox.querySelectorAll(".student-informe-chk:checked")].map(c => c.value);
    const observations = (document.getElementById("informeObs")?.value || "").trim();
    const text = buildInformeEmpresaText(empresaId, date, selectedStudentIds, observations);
    if (!text) { toast("No hay clases registradas en esa fecha para los alumnos seleccionados."); return; }
    closeModal();
    clipboardWrite(text);
    return;
  }

  if (e.target.id === "pagoEmpresaForm") {
    e.preventDefault();
    const fd       = new FormData(e.target);
    const amount   = parseInt(fd.get("amount") || "0") || 0;
    const paid     = fd.get("paid") === "1";
    const studentId = fd.get("studentId");
    if (!amount) { toast("Ingresá un monto."); return; }
    const payment = {
      date:    fd.get("date") || "",
      concept: (fd.get("concept") || "").trim(),
      amount,
      paid
    };
    // Todo pago de empresa (general o por alumno) va al registro de la empresa
    const empresaId = e.target.dataset.empresa;
    const c = getCompany(empresaId);
    if (!c) return;
    if (!c.pagosEmpresa) c.pagosEmpresa = [];
    c.pagosEmpresa.push({ ...payment, id: "p" + Date.now(), studentId: studentId || null });
    saveData();
    closeModal();
    toast("Pago registrado correctamente.");
    render();
    return;
  }
});

// ====== Event: Search (global, con toggle Alumno/Empresa) ======
function runGlobalSearch(val) {
  if (state.searchType === "empresa") {
    state.empresaSearch = val;
    if (state.view !== "empresas") state.view = "empresas";
  } else {
    state.search = val;
    if (state.view !== "lista") state.view = "lista";
  }
  render();
  const el = document.getElementById("globalSearch");
  if (el) { el.focus(); const v = el.value; el.setSelectionRange(v.length, v.length); }
}

document.getElementById("globalSearch").addEventListener("input", e => runGlobalSearch(e.target.value));

document.getElementById("searchType").addEventListener("change", e => {
  state.searchType = e.target.value;
  const inp = document.getElementById("globalSearch");
  inp.placeholder = e.target.value === "empresa"
    ? "Buscar empresa por nombre, RUC, correo…"
    : "Buscar por nombre o apellido…";
  runGlobalSearch(inp.value);
});

// ====== Indicador de estado de guardado ======
(function () {
  let hideT;
  const LABEL = { saving: "Guardando…", saved: "Guardado", offline: "Sin conexión" };
  document.addEventListener("keynes:save", e => {
    const el = document.getElementById("saveStatus");
    if (!el) return;
    const status = e.detail;
    clearTimeout(hideT);
    el.hidden = false;
    el.className = "save-status " + status;
    el.textContent = LABEL[status] || "";
    if (status === "saved") hideT = setTimeout(() => { el.hidden = true; }, 2000);
  });
})();

// ====== Init ======
try { sessionStorage.removeItem("keynes_pw_tmp"); } catch (e) {}  // limpiar la contraseña temporal del login/2FA
// Boot: 1) loadMe (rápido, define el rol) → pintar YA desde cache (localStorage) →
//       2) loadData refresca del servidor en segundo plano y re-renderiza.
loadMe()
  .then(() => { if (loadFromCache()) render(); })   // pintado instantáneo si hay cache
  .then(() => loadData())
  .then(() => render());

// ====== Auto-sync entre dispositivos ======
async function syncData() {
  // No refrescar mientras se está guardando (evita race condition)
  if (isSaving()) return;
  // No pollear en segundo plano (pestaña oculta) — ahorra lecturas
  if (document.hidden) return;
  // No refrescar si hay un modal/formulario abierto
  if (!modalOverlay.hidden) return;
  // No refrescar si el usuario está escribiendo en un campo
  const active = document.activeElement;
  if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT")) return;

  // Poll barato: pedir SOLO la versión (1 fila leída). Cargar todo solo si cambió.
  let serverVersion;
  try {
    const r = await fetch("/api/version");
    if (!r.ok) return;
    serverVersion = (await r.json()).version;
  } catch { return; }
  if (serverVersion === _dataVersion) return;   // sin cambios: no leer toda la base

  const scrollY = window.scrollY;
  await loadDelta(_dataVersion);   // solo trae lo cambiado desde nuestra versión
  render();
  requestAnimationFrame(() => window.scrollTo(0, scrollY));
}

// Al volver a la pestaña (cambió algo en otro dispositivo/tab)
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") syncData();
});

// Polling de respaldo cada 60 s (solo lee la versión; barato)
setInterval(syncData, 60_000);
