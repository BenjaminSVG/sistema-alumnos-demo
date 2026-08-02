// El servidor NO debe entregar su propio codigo fuente a un usuario autenticado.
// Antes `express.static(__dirname)` servia el directorio entero: server.js,
// seed.js, schema.sql, los tests y el package.json.
process.env.TURSO_DATABASE_URL = 'file:test.db';
const assert = require('assert');
const path = require('path');
process.env.SESSION_SECRET = 'test-secret';
process.env.APP_PASSWORD = 'Demo!1234!';
const app = require(path.join(__dirname, '..', 'server.js'));

const login = (b, u, p) => fetch(b + '/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `username=${u}&password=${encodeURIComponent(p)}` });
const ckOf = r => { const s = r.headers.get('set-cookie'); return s ? s.split(';')[0] : null; };
const get = (b, p, ck) => fetch(b + p, { headers: ck ? { Cookie: ck } : {}, redirect: 'manual' });

// Archivos que NO se pueden servir nunca, ni con sesion valida
const PROHIBIDOS = [
  '/server.js', '/package.json', '/package-lock.json', '/vercel.json',
  '/db/seed.js', '/db/schema.sql',
  '/scripts/push-to-production.js', '/scripts/check-prod.js', '/scripts/backup.ps1',
  '/test/test_logs.js', '/keynes.db', '/.env.local',
  // Rutas de antes de ordenar el proyecto en carpetas: tampoco deben servirse
  '/seed.js', '/schema.sql', '/push-to-production.js', '/check-prod.js', '/backup.ps1',
];

// Lo que la app SI necesita para funcionar
const NECESARIOS = ['/', '/styles.css', '/app.js', '/data.js', '/cert-template.png'];

(async () => {
  const server = app.listen(0); await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  // Usuario autenticado: es el caso peligroso. Sin sesion ya redirigia al login.
  const ck = ckOf(await login(base, 'admin', 'Demo!1234!'));
  assert.ok(ck, 'la sesion se abrio');

  for (const ruta of PROHIBIDOS) {
    const r = await get(base, ruta, ck);
    assert.notEqual(r.status, 200, `${ruta} NO debe servirse (dio ${r.status})`);
    const cuerpo = await r.text().catch(() => '');
    assert.ok(!cuerpo.includes('SESSION_SECRET') && !cuerpo.includes('TURSO_AUTH_TOKEN'),
              `${ruta} filtro contenido sensible`);
  }

  // Y la app tiene que seguir funcionando igual
  for (const ruta of NECESARIOS) {
    const r = await get(base, ruta, ck);
    assert.equal(r.status, 200, `${ruta} debe seguir sirviendose (dio ${r.status})`);
  }
  // La raiz devuelve la app, no un listado de directorio
  const home = await (await get(base, '/', ck)).text();
  assert.ok(home.includes('<title>') && home.includes('app.js'), 'la raiz sirve index.html');

  // Sin sesion, la raiz manda al login
  assert.equal((await get(base, '/', null)).status, 302, 'sin sesion la raiz redirige');

  // ── Ninguna credencial escrita en el codigo ──────────────
  // La contrasena del sistema estuvo escrita en server.js, en dos scripts y en
  // .env.example, todos versionados en GitHub. Este guardia evita que vuelva.
  // Los tests quedan afuera: ahi es un dato de prueba que ellos mismos definen.
  const fsx = require('fs');
  const RAIZ = path.join(__dirname, '..');
  const archivos = [];
  (function walk(dir, rel) {
    for (const e of fsx.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'test', 'referencias', 'backups', '.vercel'].includes(e.name)) continue;
      const abs = path.join(dir, e.name), r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(abs, r);
      else if (/\.(js|ps1|json|sql|html|css|example)$/.test(e.name) && !/^package-lock/.test(e.name)) archivos.push([r, abs]);
    }
  })(RAIZ, '');

  const SOSPECHOSO = /Keynes!\d{4}!/;
  const conCredencial = archivos.filter(([, abs]) => SOSPECHOSO.test(fsx.readFileSync(abs, 'utf8')));
  assert.deepStrictEqual(conCredencial.map(([r]) => r), [],
    'Hay una contrasena escrita en el codigo versionado. Movela a una variable de entorno.');
  assert.ok(archivos.length > 5, 'el escaneo recorrio archivos de verdad');

  server.close();
  console.log('PASS fuente: el codigo no se descarga, sigue sirviendose y no tiene credenciales escritas');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
