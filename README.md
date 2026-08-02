# Sistema de Gestión Académica — Keynes Education & Technology

Sistema de gestión para una academia de capacitación en Paraguay: alumnos, cursos, empresas
cliente, asistencias, pagos, informes y emisión de certificados con verificación por QR.

Está **en producción**, usándose todos los días para administrar más de un centenar de alumnos.

Este repositorio es una **versión de demostración**: mismo código, con datos de muestra
inventados. No contiene información de ninguna persona real.

---

## Índice

- [Qué resuelve](#qué-resuelve)
- [Tecnología](#tecnología)
- [Arquitectura](#arquitectura)
- [Seguridad](#seguridad)
- [Rendimiento](#rendimiento)
- [Modelo de datos](#modelo-de-datos)
- [Pruebas](#pruebas)
- [Cómo ejecutarlo](#cómo-ejecutarlo)
- [Documentación adicional](#documentación-adicional)

---

## Qué resuelve

Una academia con clases particulares y capacitaciones a empresas necesita llevar, por alumno:
qué cursos hace, qué clases se dictaron y sobre qué temas, si asistió, cuánto debe y cuánto pagó,
y al terminar, emitir un certificado verificable.

Antes eso vivía en planillas de cálculo repartidas entre varias personas. El sistema reemplaza
esas planillas y agrega lo que ellas no podían dar:

- **Roles diferenciados.** Los profesores registran clases y asistencia, pero no ven ni tocan
  los pagos. El control es del servidor, no de la interfaz.
- **Informes automáticos** por alumno, listos para enviar por WhatsApp o exportar a Excel.
- **Certificados** en PDF y PowerPoint, con un QR que cualquiera puede verificar sin cuenta.
- **Trabajo simultáneo** de varias personas sin pisarse los cambios.
- **Respaldo diario** por correo, con restauración probada.

---

## Tecnología

**Sin framework de frontend.** No hay React, ni Vue, ni build step. HTML, CSS y JavaScript
plano, servidos tal cual. La decisión está explicada en
[docs/DECISIONES.md](docs/DECISIONES.md#por-qué-sin-framework).

| Capa | Elección |
|---|---|
| Servidor | Node.js + Express 4 |
| Base de datos | Turso (libSQL / SQLite distribuido) |
| Frontend | JavaScript sin framework, sin bundler |
| Hosting | Vercel (funciones serverless) |
| Correo | Resend API |
| PDF / PPTX / QR | jsPDF, JSZip y qrcodejs, cargados bajo demanda desde CDN |
| Pruebas | Node nativo (`assert`), sin framework |

**Tres dependencias de producción en total:**

```json
"@libsql/client": "^0.14.0",
"compression":    "^1.8.1",
"express":        "^4.18.2"
```

### Tamaño

| | |
|---|---|
| `server.js` | 1.970 líneas · 25 endpoints |
| `public/app.js` | 7.100 líneas (toda la interfaz) |
| `public/data.js` | 443 líneas (sincronización y caché) |
| `test/` | 1.940 líneas · 24 archivos de prueba |

---

## Arquitectura

```
Navegador
   │  HTML + CSS + JS plano, sin build
   │  localStorage como caché de pintado instantáneo
   ▼
Vercel (función serverless)
   │  Express: 25 endpoints
   │  Auth por cookie firmada · cifrado en reposo · roles
   ▼
Turso (libSQL)
   │  SQLite distribuido
   └─ 9 tablas · sincronización incremental por versión
```

### Sincronización: una sola versión para todos

El estado completo se sirve por `GET /api/data` y se guarda por `POST /api/data`. Para que dos
personas trabajando a la vez no se pisen, cada escritura corre dentro de una transacción que
**toma el lock antes de leer la versión**:

1. El cliente manda su `clientVersion` junto con los cambios.
2. El servidor abre la transacción, lee la versión actual y compara.
3. Si no coinciden, responde `409` y el cliente hace *merge* con el servidor y reintenta.
4. Si coinciden, escribe todo y sube la versión.

Sin ese orden, la lectura de la versión y la de los IDs existentes no serían atómicas, y un
guardado concurrente podía borrar el alumno que otra persona acababa de crear.

### Sincronización incremental (delta)

Recargar el estado entero en cada consulta es caro. `GET /api/data?since=N` devuelve solo lo
que cambió desde la versión `N`:

- Cada entidad guarda en qué versión se modificó (`updated_v`).
- Los borrados dejan **lápidas** en una tabla `deletions`, para que el cliente sepa qué eliminar.
- Fuera de una ventana de 500 versiones, el servidor responde el estado completo.

### Guardado parcial

El cliente mantiene una firma de cada entidad y envía **solo las que cambiaron**, más una lista
explícita de borrados. Un cambio en un alumno no reenvía los otros ciento veintisiete.

---

## Seguridad

Detalle completo en **[docs/SEGURIDAD.md](docs/SEGURIDAD.md)**. Resumen:

### Autenticación

- Cookie `HttpOnly`, `SameSite=Strict`, `Secure` bajo HTTPS. El JavaScript del navegador
  nunca puede leerla.
- Token firmado con HMAC-SHA256: `userId.vencimiento.HMAC(userId.vencimiento.hash_de_contraseña)`.
- **Atar la firma al hash de la contraseña hace que cambiarla cierre todas las sesiones abiertas.**
  Sin eso, la única forma de cortarle el acceso a alguien era desactivar su usuario.
- Contraseñas con `scrypt`, N=2^17, sal por usuario, y *rehash* transparente al iniciar sesión
  si el hash guardado usa un costo viejo.
- Comparaciones con `crypto.timingSafeEqual`.
- Segundo factor TOTP (RFC 6238) implementado sin dependencias externas.
- Límite de 10 intentos de login por IP cada 15 minutos.

### Cifrado en reposo

Teléfonos, correos, direcciones, contactos, observaciones de clase y montos de pago se guardan
cifrados con **AES-256-GCM**. Un volcado robado de la base no es legible.

La clave admite **rotación**: al definir una clave nueva, la anterior queda disponible solo para
descifrar y una migración recifra todo una vez. Regla central de esa migración: *un valor que no
se puede descifrar con ninguna clave conocida se deja intacto* — nunca se escribe encima de algo
ilegible, porque eso convierte un dato recuperable en uno perdido.

### Autorización

Los permisos se aplican **en el servidor**, no escondiendo botones:

| | admin | usuario |
|---|---|---|
| Ver y editar pagos | sí | **no** |
| Crear/editar/borrar alumnos, empresas, cursos | sí | **no** |
| Registrar clases, asistencia y tareas | sí | sí |
| Gestionar usuarios | sí | **no** |

Un usuario común que arme el `POST` a mano recibe igual un rechazo: los campos que no le
corresponden se descartan del lado del servidor.

### XSS

Toda la interfaz se arma con *template literals* que terminan en `innerHTML`. Cada dato de
usuario pasa por una función de escape — **145 puntos** —, respetando los contextos que no son
HTML (PDF, Excel, WhatsApp, nombres de archivo), donde escapar mostraría `&amp;` al usuario.

Una prueba automatizada recorre el código buscando datos de usuario sin escapar dentro de
plantillas HTML y falla si aparece uno nuevo.

### Otros controles

- `/api/*` responde **401 JSON**, nunca un redirect al login. Redirigir hacia HTML dejaba a
  `fetch()` recibiendo un 200 con la página de login, y la aplicación seguía andando a medias
  con datos de la caché.
- El servidor **no expone su propio código**: solo se sirven los archivos que el navegador
  necesita, cada uno con su ruta explícita.
- Certificados verificables sin base de datos: el QR lleva los datos y una firma HMAC que la
  página pública recomputa.
- Cabeceras `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`.
- Consultas siempre parametrizadas; las listas de IDs generan solo marcadores `?`.
- Ninguna credencial escrita en el código. Una prueba automatizada lo verifica.

---

## Rendimiento

### Amplificación de escrituras

El plan gratuito de Turso cobra por filas escritas. El código original, al guardar un alumno,
borraba y reinsertaba **todas** sus asistencias, **todos** sus pagos y **todas** las clases de
todas sus inscripciones — aunque solo hubiera cambiado el teléfono.

La solución fue guardar una firma por colección hija y reescribir únicamente la que cambió.

Medido con *triggers* que cuentan `INSERT` y `DELETE` reales, sobre un alumno con 20 asistencias,
20 clases y 8 pagos:

| Operación | Antes | Después | |
|---|---|---|---|
| Tomar asistencia de un día | 97 filas | **41** | −58 % |
| Editar teléfono y horario | 96 filas | **0** | −100 % |

Las 41 filas restantes son la propia colección que cambió. Bajar de ahí requiere comparar fila
por fila en vez de reemplazar la colección entera.

### Otras decisiones

- **Pintado instantáneo**: la aplicación dibuja desde `localStorage` antes de que responda la red.
- **Firma por entidad**: si el contenido no cambió, no se reescribe la fila.
- **Compresión** de las respuestas.
- **Bibliotecas pesadas bajo demanda**: jsPDF, JSZip y qrcodejs solo se descargan si el usuario
  genera un certificado.
- **Sin caché en el borde para `/api/data`**: son datos por usuario y el riesgo de servir los de
  una persona a otra no compensa el ahorro.

---

## Modelo de datos

```
EMPRESAS ──┐
           │
ALUMNOS ───┼──> INSCRIPCIONES <──── CURSOS ──── TEMAS
   │       │          │
   │       │          └──> CLASES
   ├──> ASISTENCIAS_GENERALES
   └──> PAGOS_ALUMNO
```

Nueve tablas. `INSCRIPCIONES` resuelve la relación *n:n* entre alumnos y cursos. Las asistencias
y los pagos cuelgan del alumno, no de la inscripción: un alumno que cursa dos materias asiste y
paga una sola vez.

Las migraciones son idempotentes y corren al arrancar: cada `ALTER TABLE` se intenta y se ignora
si la columna ya existe. Sin herramienta de migraciones, sin estado que se pueda desincronizar.

---

## Pruebas

**24 archivos, sin framework.** Cada uno levanta el servidor real en un puerto efímero, le pega
por HTTP y verifica. Se ejecutan en serie con `npm test` y en GitHub Actions en cada push.

```
test_2fa               test_encryption          test_partial
test_backup_cron       test_enc_migration       test_rehash
test_backup_restore    test_enc_rotacion        test_restore_cliente
test_cert_verify       test_fuente              test_restore_tandas
test_cursos_readonly   test_hidepay             test_rutas
test_delta             test_logs                test_seguridad
test_multiuser         test_optim               test_selfaccount
test_pagosempresa      test_writeopt            test_xss
```

Algunos que vale la pena mirar:

- **`test_backup_restore`** — carga un alumno con todo su historial, intercepta el archivo exacto
  que sale por correo, borra las siete tablas de datos, restaura desde ese archivo y compara el
  resultado con el original. Un respaldo que nunca se restauró no es un respaldo.
- **`test_enc_rotacion`** — recorre `clave A` → `clave A+B` → `clave B con secreto rotado` en
  procesos separados, verificando que los datos sigan legibles después de rotar.
- **`test_restore_cliente`** — ejecuta la función real del navegador dentro de un contexto `vm`
  con los objetos del navegador simulados y su `fetch` apuntando al servidor de verdad.
- **`test_xss`** — auditoría estática: recorre el código buscando datos de usuario sin escapar.
- **`test_writeopt`** — verifica que tomar asistencia no reescriba las clases.

### Cada prueba fue verificada rompiendo el código a propósito

Una prueba que pasa a la primera no demuestra nada hasta que se la ve fallar. Antes de dar por
buena cada una, se introdujo deliberadamente el error que debía detectar y se confirmó que
fallaba. Ese paso encontró un arnés de prueba que no probaba nada: leía una copia del estado en
vez del estado real del módulo, y pasaba igual con el código roto.

---

## Cómo ejecutarlo

```bash
git clone https://github.com/BenjaminSVG/keynes-sistema-demo.git
cd keynes-sistema-demo
npm install

cp .env.example .env      # y editá los valores
node db/seed-demo.js      # carga 12 alumnos de muestra, todos inventados
npm start                 # http://localhost:3000
```

Entrá con el usuario `admin` y la contraseña que hayas puesto en `APP_PASSWORD`.

Para las pruebas:

```bash
npm test
```

### Variables de entorno

| Variable | Obligatoria | Para qué |
|---|---|---|
| `APP_PASSWORD` | sí | Contraseña del primer administrador |
| `SESSION_SECRET` | en producción | Firma de las cookies de sesión |
| `ENCRYPTION_KEY` | recomendada | Cifrado en reposo. Si falta, se usa `SESSION_SECRET` |
| `TURSO_DATABASE_URL` | no | Por defecto, un archivo SQLite local |
| `TURSO_AUTH_TOKEN` | solo con Turso | |
| `RESEND_API_KEY` | no | Respaldo y bitácora por correo |
| `CRON_SECRET` | no | Protege el endpoint del respaldo automático |

Sin `APP_PASSWORD`, el sistema **no** usa una contraseña por defecto: genera una aleatoria y la
informa por consola.

---

## Documentación adicional

- **[docs/SEGURIDAD.md](docs/SEGURIDAD.md)** — modelo de amenazas y cada control en detalle.
- **[docs/DECISIONES.md](docs/DECISIONES.md)** — por qué sin framework, por qué SQLite, qué se
  descartó y qué se haría distinto.

---

## Sobre esta versión

Copia de demostración del sistema en producción. Diferencias con el original:

- Datos de muestra inventados en lugar de los reales.
- Sin credenciales, claves ni direcciones de correo reales.
- Historial de git nuevo desde cero.
- Sin los scripts de despliegue propios de la instalación en producción.

El código de la aplicación es el mismo.

---

Desarrollado por [Benjamín Arévalo](https://github.com/BenjaminSVG).
