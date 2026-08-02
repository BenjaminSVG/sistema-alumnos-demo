# Seguridad

Cómo está protegido el sistema, contra qué, y qué se decidió no proteger.

El sistema guarda datos de menores de edad y de empresas cliente: nombres, teléfonos, correos,
contactos de familiares, observaciones de clase y montos de pago. Eso define las prioridades.

---

## Contra qué se protege

| Amenaza | Control |
|---|---|
| Alguien sin cuenta entra al sistema | Cookie firmada; toda ruta privada exige sesión válida |
| Fuerza bruta contra el login | 10 intentos por IP cada 15 minutos |
| Robo de la base de datos | Cifrado AES-256-GCM en reposo de los campos sensibles |
| Un profesor mira los pagos | Filtrado en el servidor, no en la interfaz |
| Un profesor ejecuta código en la sesión del administrador | Escape de HTML en 145 puntos |
| Robo de una sesión ya abierta | Vencimiento del token; cambiar la contraseña lo invalida |
| Alguien estudia el código para buscar la vuelta | El servidor no expone sus propios archivos |
| Un certificado falsificado | Firma HMAC verificable públicamente |
| Inyección SQL | Consultas siempre parametrizadas |
| Pérdida de datos | Respaldo diario cifrado en tránsito, con restauración probada |

---

## Autenticación

### La cookie

```
HttpOnly · SameSite=Strict · Secure (bajo HTTPS) · Path=/
```

`HttpOnly` es lo que impide que un XSS se lleve la sesión: el JavaScript de la página no puede
leer la cookie. `SameSite=Strict` corta los ataques CSRF sin necesidad de tokens aparte.

### El token

```
userId . vencimiento . HMAC-SHA256(userId.vencimiento.hash_de_contraseña, SESSION_SECRET)
```

Tres propiedades que da esta forma:

1. **Vence.** El token lleva su propia fecha de expiración, verificada en cada petición.
2. **Cambiar la contraseña cierra todas las sesiones.** La firma incluye el hash de la
   contraseña; al cambiarla, todos los tokens emitidos antes dejan de validar. Antes de esto la
   única forma real de cortarle el acceso a alguien era desactivar su usuario.
3. **No se puede falsificar** sin `SESSION_SECRET`.

La verificación usa `crypto.timingSafeEqual`, que tarda lo mismo con una firma casi correcta que
con una completamente equivocada.

### Contraseñas

`scrypt` con **N = 2¹⁷**, sal aleatoria por usuario, formato versionado `sal:hash:N`.

El costo queda guardado junto al hash, así que se puede subir con el tiempo: al iniciar sesión,
si el hash guardado usa un costo viejo, se recalcula con el nuevo de forma transparente. El
usuario no se entera y no hay que forzar cambios de contraseña.

### Segundo factor

TOTP (RFC 6238) implementado a mano — base32, HMAC-SHA1, ventana de tiempo — sin dependencias.
Compatible con Google Authenticator y Authy. El secreto se guarda cifrado.

---

## Cifrado en reposo

**AES-256-GCM**, clave derivada con `scrypt`. GCM además autentica: si el dato fue alterado, el
descifrado falla en vez de devolver basura.

Se cifra todo lo que identifica o expone a una persona:

| Tabla | Campos |
|---|---|
| `alumnos` | teléfono, correo, contacto secundario (nombre, relación, teléfono), observaciones |
| `empresas` | teléfono, correo, dirección, contacto |
| `clases` | observaciones |
| `asistencias_generales` | observaciones |
| `pagos_alumno` · `pagos_empresa` | concepto y monto |
| `soporte_mensajes` | asunto y mensaje |
| `usuarios` | secreto TOTP |

No se cifran nombre ni apellido: se usan para ordenar y buscar del lado de la base.

### Rotación de clave

Durante mucho tiempo el cifrado colgaba de `SESSION_SECRET`, así que rotar ese secreto habría
dejado los datos ilegibles para siempre. Hoy:

- `ENCRYPTION_KEY` es la clave principal.
- Si existe y difiere de `SESSION_SECRET`, esta última queda como **clave secundaria de solo
  lectura**.
- Al leer se prueba la clave actual y, si no abre, la anterior.
- Una migración de un solo paso recifra todo con la nueva.

**Regla central:** un valor que no se puede descifrar con ninguna clave conocida **se deja
intacto**. Nunca se escribe encima de algo ilegible — eso convertiría un dato recuperable en uno
perdido. Mientras la migración no termine, el sistema funciona igual, así que quedarse a mitad
de camino no rompe nada.

---

## Autorización

Dos roles: `admin` y `usuario`.

Lo importante no es qué ve cada uno, sino **dónde se decide**. Ocultar un botón no es un control
de acceso: cualquiera puede armar la petición a mano. Acá el servidor:

- **Filtra al leer.** `GET /api/data` para un usuario común devuelve los alumnos sin sus pagos.
  El dato no llega al navegador, así que no hay nada que inspeccionar.
- **Descarta al escribir.** En `POST /api/data`, los campos que un usuario común no puede tocar
  se ignoran, y sus listas de borrado se vacían. Puede registrar clases, asistencia y tareas;
  nada más.
- **Rechaza las rutas de administración** con 403.

Además, el sistema se niega a quedarse sin administradores: no se puede desactivar, degradar ni
eliminar al último admin activo, ni quitarse a uno mismo el rol.

---

## XSS

Es la vulnerabilidad más peligrosa de este sistema, y conviene entender por qué.

Toda la interfaz se construye con *template literals* que terminan en `innerHTML`. Un usuario
común escribe observaciones de clase, temas, nombre del profesor y tareas. Si ese texto llega sin
escapar al HTML, ese usuario **ejecuta código en la sesión del administrador** que abra la ficha
del alumno: crear usuarios administradores, leer los pagos descifrados, lo que sea.

No es un cartelito molesto: es escalada de privilegios.

El control tiene dos partes:

1. **Escape en 145 puntos**, respetando los contextos que no son HTML. Escapar un texto que va a
   un PDF, a una celda de Excel, a un mensaje de WhatsApp o a un nombre de archivo mostraría
   `&amp;` al usuario. Esos casos se revisaron uno por uno.
2. **Una prueba que audita el código.** Recorre cada línea que genera HTML buscando
   interpolaciones de datos de usuario sin escapar, con una lista revisada de excepciones
   legítimas. Si alguien agrega un campo sin escapar, la prueba falla.

---

## Sesión caducada: por qué importa el código de respuesta

Cuando la sesión no vale, `/api/*` responde **401 con JSON**. Nunca un redirect al login.

Redirigir parece inofensivo, pero rompe la aplicación de una forma difícil de diagnosticar:
`fetch()` sigue el redirect solo, recibe un **200 con el HTML del login**, y el código que
esperaba JSON falla en silencio. El resultado es una aplicación que parece funcionando —muestra
datos viejos de la caché local— pero sin nombre de usuario, sin menú de administrador y sin
poder guardar nada.

Esa falla existió y llevó tiempo diagnosticarla, porque el síntoma visible (falta el menú) no se
parecía en nada a la causa (la cookie ya no valía). Hoy el cliente detecta el 401, limpia la
caché local —para no mostrarle a la próxima persona los datos de la anterior— y va al login.

Las páginas HTML sí siguen redirigiendo: ahí es el comportamiento correcto.

---

## Exposición del código

El servidor sirve **solo** los archivos que el navegador necesita, cada uno con su ruta
explícita: `styles.css`, `app.js`, `data.js`, `index.html`, `login.html` y las plantillas del
certificado.

Antes servía el directorio entero, lo que entregaba `server.js`, el esquema SQL, los scripts de
despliegue y las pruebas a cualquier usuario autenticado. Un profesor podía descargarse el código
y estudiar tranquilo el modelo de permisos.

Una prueba automatizada verifica, **con sesión válida** —que es el caso peligroso—, que ninguno
de esos archivos se sirva y que los que la aplicación necesita sigan funcionando.

---

## Certificados verificables

El QR de cada certificado apunta a una página pública que valida su autenticidad **sin consultar
la base de datos**:

- Los datos del certificado viajan codificados en la propia URL.
- Junto a ellos va una firma HMAC generada con el secreto del servidor.
- La página recomputa la firma y compara.

Alterar un nombre, una nota o una fecha invalida la firma. Y como no hay consulta a la base, la
verificación no expone ningún otro dato ni requiere cuenta.

Emitir un certificado sí requiere sesión: el endpoint que firma está protegido.

---

## Respaldo

Un respaldo que nunca se restauró no es un respaldo. Este se prueba de forma automatizada:

1. Se carga un alumno con inscripción, clases con tareas, asistencias con observaciones y pagos,
   más una empresa con sus pagos.
2. Se intercepta **el archivo exacto** que sale por correo.
3. Se borran las siete tablas de datos.
4. Se restaura desde ese archivo.
5. Se compara el resultado con el original, campo por campo.

El respaldo sale **descifrado**, a propósito: uno cifrado no serviría para recuperar si se
perdiera la clave. La contrapartida es que el buzón que lo recibe hay que cuidarlo como se cuida
la base.

La restauración se manda en tandas de 25 alumnos. Un respaldo real de 128 alumnos con su
historial ronda 1,2 MB contra un límite de 2 MB: mandarlo entero funcionaría hoy y fallaría
dentro de un año, justo el día que hace falta.

---

## Registro de actividad

Se registra quién entró, quién falló al entrar, quién creó, editó o borró cada alumno, curso,
empresa y usuario. Una vez por día ese registro se envía por correo y la tabla se vacía.

**Nunca se registran** contraseñas, secretos TOTP, montos de pago ni direcciones IP.

La tabla es una **cola de un día**, no un archivo histórico: el archivo permanente es el correo.
El borrado ocurre **solo después** de que el proveedor confirma el envío; si el correo falla, las
filas quedan y salen al día siguiente.

No hay pantalla para ver la bitácora dentro del sistema, y es deliberado: ese visor mostraría
texto escrito por usuarios comunes y sería una superficie nueva de XSS apuntando directo a la
sesión del administrador. El correo resuelve la misma necesidad sin abrir esa puerta.

---

## Lo que no se hace

Decisiones conscientes, no olvidos:

- **Sin caché en el borde para `/api/data`.** Son datos por usuario. El riesgo de servirle a una
  persona los datos de otra no compensa la latencia que se ahorraría.
- **Sin registro público.** Las cuentas las crea un administrador. No hay recuperación de
  contraseña por correo: la reinicia un administrador.
- **Sin rate limit general por IP.** Solo el login. Detrás de Vercel, el control de tráfico
  general se resuelve mejor en el borde que en la aplicación.
- **Sin auditoría inmutable.** La bitácora es operativa, no forense.
- **Sin paginación.** Con el volumen actual —cientos de alumnos— la interfaz responde bien.
  Agregarla antes de necesitarla sería complejidad sin beneficio.

---

## Reportar un problema

Si encontrás una vulnerabilidad, abrí un *issue* sin detalles de explotación y se coordina el
resto por privado.
