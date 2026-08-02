// Verifica el arreglo de XSS almacenado y evita que se reintroduzca.
//
// El riesgo real: un usuario COMÚN puede escribir observaciones de clase,
// tema, profesor y tareas. Todo eso se pinta con innerHTML. Sin escapar, ese
// usuario ejecuta código en la sesión del ADMIN que abra la ficha del alumno
// (crear usuarios admin, llevarse pagos descifrados). O sea: escalada de
// privilegios, no un simple "popup molesto".
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

// ── 1. esc() / escBr() neutralizan payloads reales ──
// Solo el bloque de escape: lo anterior toca window/localStorage y no corre en Node.
const cabecera = SRC.slice(
  SRC.indexOf('// ====== Escape de HTML ======'),
  SRC.indexOf('// ====== Estado ======'));
const { esc, escBr } = (new Function(cabecera + '\nreturn { esc, escBr };'))();

const PAYLOADS = [
  '<script>alert(1)</script>',
  '<img src=x onerror="fetch(\'/api/users\')">',
  '"><svg onload=alert(1)>',
  "'><iframe src=javascript:alert(1)>",
  '<a href="javascript:alert(1)">x</a>',
];
for (const p of PAYLOADS) {
  const out = esc(p);
  assert.ok(!out.includes('<'), `esc() deja "<" sin escapar en: ${p}`);
  assert.ok(!out.includes('>'), `esc() deja ">" sin escapar en: ${p}`);
  assert.ok(!out.includes('"'), `esc() deja comillas sin escapar en: ${p}`);
  assert.ok(!/'/.test(out),    `esc() deja apóstrofo sin escapar en: ${p}`);
}
assert.equal(esc(null), '', 'esc(null) = cadena vacía');
assert.equal(esc('a & b'), 'a &amp; b', 'escapa &');
// escBr respeta los saltos de línea PERO escapa primero
assert.equal(escBr('a\n<b>'), 'a<br>&lt;b&gt;', 'escBr escapa antes de convertir saltos');

// ── 2. Auditoría estática: ningún dato de usuario sin escapar en HTML ──
const DATA = /\b(name|surname|phone|email|caracteristicas|horario|address|ruc|contactName|contactRole|contactPhone|topic|professor|observations|task|concept|notes|nombre|apellido|username|tutors|asunto|mensaje)\b/;
const SAFE = /^(esc|escBr|fmtDate|Number|String|initials|colorFor|renderTopicHtml|_certXmlEsc)\s*\(/;

// Falsos positivos revisados uno por uno: no llegan a innerHTML como HTML.
const OK = new Set([
  'renderTopicText(i.cl.topic)',                       // texto plano (WhatsApp)
  'name',                                              // selector querySelector([name="..."])
  'mensaje',                                           // HTML ya armado y escapado por quien llama
  'previewTopics',                                     // fragmento ya escapado al construirse
  'more',                                              // literal generado por el código
]);

const fallas = [];
SRC.split('\n').forEach((line, i) => {
  if (!/[<>]/.test(line)) return;                       // solo líneas que generan HTML
  const re = /\$\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g;
  let m;
  while ((m = re.exec(line))) {
    const e = m[1].trim();
    if (!DATA.test(e) || SAFE.test(e) || OK.has(e)) continue;
    if (/\besc\(|\bescBr\(/.test(e)) continue;          // ya escapa por dentro
    if (/"selected"|"checked"|=== ?"|!== ?"/.test(e)) continue;  // solo emite selected/checked
    if (/c\.topics\.length|enrollments\.length/.test(e)) continue; // números
    if (/^course\.allowManual \?/.test(e)) continue;      // data-topic="" vacío, sin dato
    if (/^DIAS\.map\(/.test(e)) continue;                 // arreglo fijo del código
    fallas.push(`app.js:${i + 1} → \${${e.slice(0, 90)}}`);
  }
});
assert.equal(fallas.length, 0,
  `Hay datos de usuario sin escapar en plantillas HTML:\n  ` + fallas.join('\n  '));

// ── 3. Los campos que escribe un usuario común están escapados ──
for (const campo of ['cl.observations', 'cl.professor', 'a.observations', 'hw.task']) {
  const suelto = new RegExp('\\$\\{' + campo.replace('.', '\\.') + '(\\s*\\|\\||\\s*\\})');
  assert.ok(!suelto.test(SRC), `${campo} aparece sin esc() — es escritura de usuario común`);
}

console.log('PASS xss: esc/escBr neutralizan payloads + 0 datos sin escapar en HTML');
