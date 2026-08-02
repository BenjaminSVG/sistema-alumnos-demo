// Cada archivo que el navegador descarga, servido de verdad y con el contenido
// correcto. Existe porque al ordenar el proyecto en carpetas (public/, cert/,
// db/) cualquier ruta mal actualizada en server.js rompe el sitio en produccion
// sin que ningun otro test se entere: todos los demas hablan con la API.
process.env.TURSO_DATABASE_URL = 'file:test.db';
const assert = require('assert');
const path = require('path');
process.env.SESSION_SECRET = 'test-secret';
process.env.APP_PASSWORD = 'Demo!1234!';
const app = require(path.join(__dirname, '..', 'server.js'));

const login = (b) => fetch(b + '/login', { method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: 'username=admin&password=' + encodeURIComponent('Demo!1234!') });

(async () => {
  const server = app.listen(0); await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  // ── Publicas: sin sesion ─────────────────────────────────
  const publicas = [
    ['/login',       t => t.includes('<form') && /password/i.test(t), 'formulario de login'],
    ['/styles.css',  t => t.includes('{') && t.includes(':'),         'hoja de estilos'],
    ['/app.js',      t => t.includes('function esc(') && t.includes('modalMiCuenta'), 'app del cliente'],
    ['/data.js',     t => t.includes('restoreBackup') && t.includes('loadData'),      'capa de datos'],
    ['/verificar',   t => t.length > 0,                               'verificador de certificados'],
  ];
  for (const [ruta, ok, que] of publicas) {
    const r = await fetch(base + ruta);
    assert.equal(r.status, 200, `${ruta} deberia servirse (dio ${r.status})`);
    const t = await r.text();
    assert.ok(ok(t), `${ruta} respondio 200 pero su contenido no parece ${que}`);
  }

  // ── Binarios del certificado: se sirven desde modulos base64 ──
  const png = await fetch(base + '/cert-template.png');
  assert.equal(png.status, 200, 'cert-template.png se sirve');
  const bPng = Buffer.from(await png.arrayBuffer());
  assert.ok(bPng.length > 1000, 'el png no viene vacio');
  assert.equal(bPng.subarray(1, 4).toString(), 'PNG', 'los bytes son de un PNG real');

  const pptx = await fetch(base + '/cert-template.pptx');
  assert.equal(pptx.status, 200, 'cert-template.pptx se sirve');
  const bPptx = Buffer.from(await pptx.arrayBuffer());
  assert.ok(bPptx.length > 1000, 'el pptx no viene vacio');
  assert.equal(bPptx.subarray(0, 2).toString(), 'PK', 'los bytes son de un zip/pptx real');

  // ── Privadas: con sesion ─────────────────────────────────
  const ck = (await login(base)).headers.get('set-cookie').split(';')[0];
  assert.ok(ck, 'la sesion se abrio');

  const home = await fetch(base + '/', { headers: { Cookie: ck }, redirect: 'manual' });
  assert.equal(home.status, 200, 'la raiz sirve la app con sesion');
  const html = await home.text();
  assert.ok(html.includes('app.js') && html.includes('data.js'), 'index.html referencia sus scripts');
  assert.ok(html.includes('styles.css'), 'index.html referencia la hoja de estilos');

  const me = await fetch(base + '/api/me', { headers: { Cookie: ck } });
  assert.equal(me.status, 200, '/api/me responde con sesion');
  assert.equal((await me.json()).username, 'admin', 'devuelve el usuario');

  // ── initDB leyo db/schema.sql: si la ruta estuviera mal, no habria tablas ──
  const datos = await fetch(base + '/api/data', { headers: { Cookie: ck } }).then(r => r.json());
  assert.ok(Array.isArray(datos.courses) && datos.courses.length > 0,
            'los cursos del schema.sql estan cargados (se leyo db/schema.sql)');

  server.close();
  console.log('PASS rutas: todos los archivos servidos existen y traen el contenido correcto');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
