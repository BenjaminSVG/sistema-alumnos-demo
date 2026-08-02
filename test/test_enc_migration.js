process.env.TURSO_DATABASE_URL = 'file:test.db';
// Datos en claro preexistentes -> al arrancar con ENCRYPTION_KEY se cifran una vez, sin perdida.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
for (const f of ['test.db', 'test.db-wal', 'test.db-shm']) { try { fs.unlinkSync(f); } catch {} }
const ROOT = path.join(__dirname, '..');
const { createClient } = require(path.join(ROOT, 'node_modules/@libsql/client'));

(async () => {
  // DB con datos EN CLARO (como produccion hoy)
  const db = createClient({ url: 'file:' + path.join(ROOT, 'test.db') });
  await db.executeMultiple(fs.readFileSync(path.join(ROOT, 'db', 'schema.sql'), 'utf8'));
  await db.execute("ALTER TABLE alumnos ADD COLUMN estado TEXT DEFAULT 'activo'");
  await db.execute("CREATE TABLE IF NOT EXISTS pagos_alumno (id TEXT PRIMARY KEY, alumno_id TEXT, fecha TEXT, concepto TEXT, monto INTEGER, pagado INTEGER)");
  await db.execute("INSERT INTO alumnos (id, nombre, apellido, telefono, email, caracteristicas) VALUES ('A1','Juan','Perez','+595 971 555','juan@mail.com','nota privada')");
  await db.execute("INSERT INTO pagos_alumno (id, alumno_id, fecha, concepto, monto, pagado) VALUES ('A1-PAY-0','A1','2026-01-05','Enero',250000,1)");
  db.close();

  process.env.SESSION_SECRET = 'test-secret';
  process.env.APP_PASSWORD   = 'Demo!1234!';
  process.env.ENCRYPTION_KEY = 'clave-estable-migracion-xyz-000';
  const app = require(path.join(ROOT, 'server.js'));
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const ck = await fetch(base + '/login', { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=admin&password=Demo!1234!',
  }).then(r => r.headers.get('set-cookie').split(';')[0]);

  const data = await fetch(base + '/api/data', { headers: { Cookie: ck } }).then(r => r.json()); // dispara migracion
  const s = data.students.find(x => x.id === 'A1');
  assert.equal(s.phone, '+595 971 555', 'telefono legible tras migracion');
  assert.equal(s.caracteristicas, 'nota privada', 'caracteristicas legibles');
  assert.equal(s.payments[0].amount, 250000, 'monto legible');
  assert.equal(s.payments[0].concept, 'Enero', 'concepto legible');

  const db2 = createClient({ url: 'file:' + path.join(ROOT, 'test.db') });
  const raw = await db2.execute("SELECT telefono, caracteristicas FROM alumnos WHERE id='A1'");
  db2.close();
  assert.ok(String(raw.rows[0].telefono).startsWith('enc:v1:'), 'datos viejos quedaron cifrados en DB');
  assert.ok(!String(raw.rows[0].caracteristicas).includes('privada'), 'nota ya no legible en DB');

  server.close();
  console.log('PASS: migracion cifra datos existentes sin perdida');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
