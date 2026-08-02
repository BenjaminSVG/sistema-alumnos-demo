-- =============================================================
--  KEYNES Education & Technology — Esquema SQL (SQLite)
--
--  Diagrama de relaciones:
--
--   ALUMNOS ──┐
--             ├──> INSCRIPCIONES <──── CURSOS
--             │         │
--             │         ├──> CLASES
--             │         ├──> ASISTENCIAS
--             │         └──> PAGOS
--             └── (directa, via inscripciones.alumno_id)
--
--  Relación n:n ALUMNOS ↔ CURSOS implementada por INSCRIPCIONES.
--  TEMAS pertenece a CURSOS (lista de temas predefinidos).
-- =============================================================

-- ────────────────────────────────────────
--  TABLA: CURSOS
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cursos (
  id     TEXT PRIMARY KEY,
  nombre TEXT NOT NULL
);

-- ────────────────────────────────────────
--  TABLA: TEMAS  (temas predefinidos de un curso)
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS temas (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  curso_id    TEXT    NOT NULL REFERENCES cursos(id) ON DELETE CASCADE,
  orden       INTEGER NOT NULL DEFAULT 0,
  descripcion TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_temas_curso ON temas(curso_id);

-- ────────────────────────────────────────
--  TABLA: EMPRESAS
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS empresas (
  id                 TEXT PRIMARY KEY,
  nombre             TEXT NOT NULL,
  ruc                TEXT DEFAULT '',
  telefono           TEXT DEFAULT '',
  email              TEXT DEFAULT '',
  direccion          TEXT DEFAULT '',
  modalidad          TEXT DEFAULT '',
  dias_clase         TEXT DEFAULT '',        -- días separados por coma
  horario            TEXT DEFAULT '',
  contacto_nombre    TEXT DEFAULT '',
  contacto_cargo     TEXT DEFAULT '',
  contacto_telefono  TEXT DEFAULT ''
);

-- ────────────────────────────────────────
--  TABLA: ALUMNOS
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alumnos (
  id                  TEXT PRIMARY KEY,
  nombre              TEXT NOT NULL,
  apellido            TEXT NOT NULL,
  telefono            TEXT DEFAULT '',
  email               TEXT DEFAULT '',
  modalidad           TEXT DEFAULT '',       -- 'presencial' | 'virtual' | ''
  dias_clase          TEXT DEFAULT '',       -- días separados por coma
  horario             TEXT DEFAULT '',
  empresa_id          TEXT DEFAULT '',
  contacto2_nombre    TEXT DEFAULT '',
  contacto2_relacion  TEXT DEFAULT '',
  contacto2_telefono  TEXT DEFAULT '',
  caracteristicas     TEXT DEFAULT ''
);

-- ────────────────────────────────────────
--  TABLA: INSCRIPCIONES  (tabla puente n:n ALUMNOS ↔ CURSOS)
--  Una fila = un alumno inscripto en un curso.
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inscripciones (
  inscripcion_id      TEXT PRIMARY KEY,
  alumno_id           TEXT    NOT NULL REFERENCES alumnos(id)  ON DELETE CASCADE,
  curso_id            TEXT    NOT NULL REFERENCES cursos(id)   ON DELETE RESTRICT,
  tutores             TEXT    DEFAULT '',    -- lista separada por coma
  tipo_pago           TEXT    DEFAULT 'mensual',  -- mensual | por clase | curso completo | paquete
  monto_pago          INTEGER DEFAULT 0,
  horas_paquete       INTEGER,              -- solo para tipo_pago = 'paquete'
  fecha_inicio        TEXT    DEFAULT '',
  fecha_fin_estimada  TEXT    DEFAULT '',
  completado          INTEGER DEFAULT 0     -- 0 = en curso, 1 = finalizado
);
CREATE INDEX IF NOT EXISTS idx_insc_alumno ON inscripciones(alumno_id);
CREATE INDEX IF NOT EXISTS idx_insc_curso  ON inscripciones(curso_id);

-- ────────────────────────────────────────
--  TABLA: CLASES  (sesiones dictadas por inscripción)
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clases (
  id              TEXT PRIMARY KEY,
  inscripcion_id  TEXT NOT NULL REFERENCES inscripciones(inscripcion_id) ON DELETE CASCADE,
  fecha           TEXT DEFAULT '',
  hora_inicio     TEXT DEFAULT '',
  hora_fin        TEXT DEFAULT '',
  modalidad       TEXT DEFAULT '',
  tema            TEXT DEFAULT '',
  profesor        TEXT DEFAULT '',
  observaciones   TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_clases_insc ON clases(inscripcion_id);

-- ────────────────────────────────────────
--  TABLA: ASISTENCIAS_GENERALES  (asistencia por alumno, sin asociar a un curso)
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS asistencias_generales (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  alumno_id     TEXT    NOT NULL REFERENCES alumnos(id) ON DELETE CASCADE,
  fecha         TEXT    DEFAULT '',
  presente      INTEGER DEFAULT 1,
  horas         REAL    DEFAULT 0,
  observaciones TEXT    DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_asist_gen_alumno ON asistencias_generales(alumno_id);

-- Nota: las tablas legacy `pagos` y `asistencias` (por inscripción) fueron
-- reemplazadas por `pagos_alumno` y `asistencias_generales`. Ya no se crean;
-- initDB() las elimina si existían (una vez migrados los datos).

-- =============================================================
--  DATOS DE MUESTRA  (INSERT OR IGNORE para no duplicar)
-- =============================================================

-- Cursos
INSERT OR IGNORE INTO cursos (id, nombre) VALUES ('excel-avanzado',   'Excel Avanzado');
INSERT OR IGNORE INTO cursos (id, nombre) VALUES ('excel-basico',     'Excel Básico');
INSERT OR IGNORE INTO cursos (id, nombre) VALUES ('excel-financiero', 'Excel Financiero');
INSERT OR IGNORE INTO cursos (id, nombre) VALUES ('power-bi',         'Power BI');
INSERT OR IGNORE INTO cursos (id, nombre) VALUES ('ingles-basico',    'Inglés Básico');
INSERT OR IGNORE INTO cursos (id, nombre) VALUES ('ingles-intermedio','Inglés Intermedio');
INSERT OR IGNORE INTO cursos (id, nombre) VALUES ('duolingo',         'Duolingo');

-- Control de versión de datos (previene que clientes con datos viejos sobreescriban el servidor)
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO meta (key, value) VALUES ('data_version', '1');


