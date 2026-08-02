# Decisiones de diseño

Por qué el sistema es como es. Incluye lo que se descartó y lo que se haría distinto.

---

## Por qué sin framework

No hay React, Vue, Svelte ni build step. HTML, CSS y JavaScript plano, servidos tal cual.

**El contexto:** una persona desarrollando y manteniendo el sistema, para una academia con un
puñado de usuarios simultáneos. El sistema tiene que seguir funcionando dentro de tres años,
posiblemente sin que nadie le toque nada en el medio.

**Qué se gana:**

- **Cero mantenimiento de herramientas.** No hay bundler que actualizar, ni configuración que se
  rompa al subir de versión, ni `node_modules` de 300 MB que se vuelva inconsistente.
- **Se depura lo que se escribió.** El código que corre en el navegador es el mismo que está en
  el repositorio. Sin *source maps*, sin transpilación, sin capas.
- **Despliegue trivial.** Copiar archivos. No hay paso de compilación que pueda fallar en
  producción y no en local.
- **Tres dependencias de producción.** La superficie de ataque por cadena de suministro es
  mínima, y `npm audit` no es un ritual semanal.

**Qué se pierde:**

- `public/app.js` tiene 7.100 líneas. Un framework lo habría partido en componentes.
- No hay reactividad: los cambios de estado exigen volver a dibujar a mano.
- Sin sistema de tipos.

**El veredicto honesto:** para un equipo de varias personas o una interfaz mucho más grande, la
decisión sería la contraria. En esta escala, la simplicidad operativa ganó. Si el archivo sigue
creciendo, el primer paso sería partirlo en módulos ES nativos — que ya funcionan en el
navegador, sin build.

---

## Por qué SQLite (Turso) y no Postgres

- Los datos son **relacionales de verdad** —alumnos, cursos, inscripciones, clases, pagos— así
  que una base documental habría complicado las consultas sin dar nada a cambio.
- El volumen es chico: cientos de alumnos, miles de clases. SQLite sobra.
- **Turso** da SQLite gestionado, replicado y con capa gratuita generosa. No hay servidor de base
  de datos que administrar.
- El mismo motor corre en local contra un archivo. Las pruebas no necesitan Docker ni un servicio
  aparte: `file:test.db` y listo.

La contrapartida es que el plan gratuito cobra por filas escritas, lo que obligó a ser cuidadoso
con la amplificación de escrituras. Terminó siendo una buena presión de diseño.

---

## Sincronización: un `POST` con todo el estado

Suena mal a primera vista. La alternativa clásica —un endpoint REST por entidad— habría dado
peticiones más chicas, pero también:

- Sin transacción que las abarque a todas, un fallo a mitad de camino deja datos inconsistentes.
- Cambiar un alumno suele tocar sus inscripciones, sus clases y sus pagos a la vez. Con endpoints
  separados eso son cuatro peticiones que pueden fallar por separado.

El diseño actual manda **solo lo que cambió** —firma por entidad, más una lista explícita de
borrados— dentro de una sola transacción, con control de versión optimista.

Un cambio de teléfono manda un alumno, no ciento veintiocho. Y si dos personas guardan a la vez,
la segunda recibe un `409`, hace *merge* con el servidor y reintenta. Nadie pierde trabajo.

---

## `localStorage` como caché de pintado

La aplicación dibuja desde `localStorage` **antes** de que responda la red. Se siente instantánea.

Eso tuvo un costo que conviene documentar: **enmascaraba fallas de la API**. Si la sesión
caducaba, la aplicación mostraba datos viejos y parecía funcionar, pero sin nombre de usuario y
sin menú de administrador. El síntoma visible no se parecía en nada a la causa.

Se resolvió haciendo que `/api/*` responda 401 en vez de redirigir, y que el cliente ante un 401
limpie la caché y vaya al login. La caché sigue, pero ya no puede mentir.

**Lección:** una optimización que oculta errores se paga en horas de diagnóstico, y se paga
tarde.

---

## Migraciones idempotentes, sin herramienta

Las migraciones son un arreglo de sentencias SQL que corren al arrancar, cada una envuelta en un
`try` que ignora el error si ya se aplicó:

```js
"ALTER TABLE alumnos ADD COLUMN estado TEXT DEFAULT 'activo'",
```

Sin números de versión, sin tabla de estado, sin CLI. Agregar una columna es agregar una línea.

**Por qué alcanza:** una sola base de producción, un solo desarrollador, y `ALTER TABLE ADD
COLUMN` es idempotente si se ignora el error de "ya existe".

**Dónde no alcanzaría:** con varios entornos que puedan divergir, o migraciones que transformen
datos y no puedan repetirse. Para esos casos hay banderas explícitas en una tabla `meta`, que es
como se manejan el cifrado inicial y el recifrado.

---

## Certificados: PDF y PPTX del mismo origen

La academia entregaba certificados hechos a mano en PowerPoint. El sistema los genera, pero el
fondo tenía que ser **idéntico** al de la plantilla original.

La solución fue extraer la imagen de fondo del propio `.pptx` —que no es más que un ZIP con XML
adentro— y usarla como fondo del PDF. Los dos formatos salen del mismo píxel.

Las plantillas se sirven desde módulos base64 en vez de archivos sueltos, porque la configuración
de archivos incluidos del hosting no los tomaba de forma confiable. Un `require` siempre lo
resuelve el empaquetador.

---

## Amplificación de escrituras: medir antes de optimizar

El consumo de escrituras en Turso subía sin explicación aparente. La causa: guardar un alumno
borraba y reinsertaba **todas** sus asistencias, **todos** sus pagos y **todas** las clases de
todas sus inscripciones — aunque solo hubiera cambiado el teléfono.

Antes de tocar nada se instrumentó la base con *triggers* que cuentan `INSERT` y `DELETE`
reales, y se midió el mismo escenario con la optimización activada y desactivada:

| Operación | Antes | Después |
|---|---|---|
| Tomar asistencia de un día | 97 filas | 41 |
| Editar teléfono y horario | 96 filas | 0 |

La solución: una firma por colección hija; se reescribe solo la que cambió.

**Lo que quedó sin hacer, a propósito:** las 41 filas restantes son la propia colección que
cambió. Bajarlas requiere comparar fila por fila en vez de reemplazar la colección entera. Es un
cambio bastante más grande y el consumo actual no lo justifica.

---

## Pruebas sin framework

24 archivos, `assert` nativo, un ejecutor de 25 líneas. Cada prueba levanta el servidor real en
un puerto efímero y le pega por HTTP.

Sin Jest, sin Vitest, sin *mocks*. Las pruebas ejercitan el sistema de verdad: base de datos
real —un archivo SQLite—, servidor real, peticiones reales.

**La práctica que más valor dio:** verificar cada prueba **rompiendo el código a propósito**.
Una prueba que pasa a la primera no demuestra nada hasta que se la ve fallar por la razón
correcta.

Ese paso encontró un arnés de prueba que no probaba nada: cargaba el código del cliente en un
contexto aislado y leía una copia del estado en vez del estado real del módulo. Pasaba igual con
el código roto. Sin la verificación deliberada, habría quedado ahí dando una falsa sensación de
cobertura.

---

## Qué se haría distinto

Con la perspectiva de haberlo mantenido un tiempo:

1. **Partir `app.js` desde el principio.** No en componentes de framework, pero sí en módulos ES
   por área. 7.100 líneas en un archivo son navegables, pero ya incomodan.
2. **Definir `ENCRYPTION_KEY` desde el día uno.** Dejar que el cifrado colgara de
   `SESSION_SECRET` fue una bomba de tiempo: rotar ese secreto —algo que uno hace por seguridad,
   sin pensarlo— habría dejado los datos ilegibles para siempre.
3. **Escapar el HTML desde la primera línea de interfaz.** Agregarlo después obligó a revisar 145
   puntos de una vez, con el riesgo de romper los que no eran HTML.
4. **Medir antes de suponer.** La amplificación de escrituras estuvo meses a la vista sin que
   nadie la contara. Bastaron unos *triggers* para verla.
5. **Probar la restauración del respaldo el mismo día que se hace el respaldo.** Estuvo enviándose
   por correo semanas antes de que alguien verificara que servía para recuperar.
