'use strict';
// seed-demo.js — Carga datos de MUESTRA para probar el sistema.
//
// Todos los nombres, telefonos, correos y montos son INVENTADOS. No hay ni un
// dato de una persona real. Uso:
//
//   node db/seed-demo.js
//
// Escribe sobre la base que indique TURSO_DATABASE_URL (por defecto keynes.db).

const { createClient } = require('@libsql/client');
const path = require('path');
// (fs ya no hace falta: el esquema lo prepara el propio servidor)

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || ('file:' + path.join(__dirname, '..', 'keynes.db')),
  authToken: process.env.TURSO_AUTH_TOKEN || undefined,
});

// ── Personajes de muestra ────────────────────────────────────
const EMPRESAS = [
  { id: 'emp-01', nombre: 'Comercial del Este S.A.', ruc: '80012345-6', telefono: '021-555-0100',
    email: 'capacitacion@comercialdeleste.example', direccion: 'Avda. Ejemplo 1234, Asuncion',
    modalidad: 'presencial', dias: 'martes,jueves', horario: '08:00-10:00',
    contacto: 'Rosa Villalba', cargo: 'Recursos Humanos', contactoTel: '0981-555-101' },
  { id: 'emp-02', nombre: 'Industrias Guarani S.R.L.', ruc: '80098765-4', telefono: '021-555-0200',
    email: 'rrhh@industriasguarani.example', direccion: 'Ruta 2 Km 18, Capiata',
    modalidad: 'virtual', dias: 'miercoles', horario: '18:00-20:00',
    contacto: 'Hugo Benitez', cargo: 'Jefe de Personal', contactoTel: '0981-555-201' },
];

const NOMBRES = [
  ['Lucia', 'Aguero'], ['Mateo', 'Riveros'], ['Camila', 'Duarte'], ['Joaquin', 'Melgarejo'],
  ['Valentina', 'Ojeda'], ['Thiago', 'Cabrera'], ['Renata', 'Sosa'], ['Bruno', 'Alvarenga'],
  ['Micaela', 'Ferreira'], ['Alejandro', 'Zarate'], ['Sofia', 'Bogado'], ['Diego', 'Escobar'],
];

const CURSOS = ['excel-avanzado', 'excel-basico', 'power-bi', 'ingles-basico', 'ingles-intermedio'];
const TEMAS = {
  'excel-avanzado':   ['Tablas dinamicas', 'BUSCARV y BUSCARX', 'Macros basicas', 'Power Query', 'Dashboards'],
  'excel-basico':     ['Formato de celdas', 'Formulas basicas', 'Graficos', 'Filtros y orden'],
  'power-bi':         ['Carga de datos', 'Modelo relacional', 'Medidas DAX', 'Publicacion'],
  'ingles-basico':    ['Present simple', 'Vocabulario del trabajo', 'Listening 1', 'Speaking: presentarse'],
  'ingles-intermedio':['Past perfect', 'Reported speech', 'Business writing', 'Mock interview'],
};
const PROFES = ['Prof. Aranda', 'Prof. Caballero', 'Prof. Nunez'];

const dia = (mes, d) => `2026-${String(mes).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

// El esquema base vive en schema.sql, pero varias columnas (estado, tipo_pago,
// pagos_alumno, hashes de sincronizacion...) las agrega initDB() al arrancar.
// En vez de duplicar esa lista acá -que se desactualizaria sola-, se levanta el
// servidor un instante y se le pide /login, que es lo que dispara initDB().
async function prepararEsquema() {
  const app = require(path.join(__dirname, '..', 'server.js'));
  const s = app.listen(0);
  await new Promise(r => s.once('listening', r));
  await fetch('http://127.0.0.1:' + s.address().port + '/login').catch(() => {});
  await new Promise(r => s.close(r));
}

async function main() {
  await prepararEsquema();

  console.log('Cargando datos de muestra (todos ficticios)...\n');

  for (const e of EMPRESAS) {
    await db.execute({
      sql: `INSERT OR REPLACE INTO empresas
            (id,nombre,ruc,telefono,email,direccion,modalidad,dias_clase,horario,contacto_nombre,contacto_cargo,contacto_telefono)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [e.id, e.nombre, e.ruc, e.telefono, e.email, e.direccion, e.modalidad, e.dias, e.horario, e.contacto, e.cargo, e.contactoTel],
    });
  }
  console.log(`  ${EMPRESAS.length} empresas`);

  let nClases = 0, nPagos = 0, nAsist = 0;

  for (let i = 0; i < NOMBRES.length; i++) {
    const [nombre, apellido] = NOMBRES[i];
    const id = `demo-${String(i + 1).padStart(2, '0')}`;
    // Un tercio son alumnos de empresa; el resto, particulares
    const empresaId = i % 3 === 0 ? EMPRESAS[i % EMPRESAS.length].id : '';
    const estado = i === 10 ? 'pausado' : (i === 11 ? 'finalizado' : 'activo');
    const monto = 250000 + (i % 4) * 50000;

    await db.execute({
      sql: `INSERT OR REPLACE INTO alumnos
            (id,nombre,apellido,telefono,email,modalidad,dias_clase,horario,empresa_id,
             contacto2_nombre,contacto2_relacion,contacto2_telefono,caracteristicas,
             estado,tipo_pago,monto_pago,alertas_dismissed)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'{}')`,
      args: [id, nombre, apellido, `0981-555-${String(300 + i).padStart(3, '0')}`,
             `${nombre.toLowerCase()}.${apellido.toLowerCase()}@ejemplo.com`,
             i % 4 === 0 ? 'virtual' : 'presencial',
             ['lunes,miercoles', 'martes,jueves', 'sabado'][i % 3],
             ['08:00-10:00', '14:00-16:00', '18:00-20:00'][i % 3],
             empresaId,
             i % 5 === 0 ? 'Marta Gimenez' : '', i % 5 === 0 ? 'madre' : '', i % 5 === 0 ? '0981-555-999' : '',
             i % 2 === 0 ? 'Necesita refuerzo en ejercicios practicos.' : '',
             estado, 'mensual', monto],
    });

    // Una o dos inscripciones por alumno
    const cursos = [CURSOS[i % CURSOS.length]];
    if (i % 4 === 0) cursos.push(CURSOS[(i + 2) % CURSOS.length]);

    for (let j = 0; j < cursos.length; j++) {
      const cursoId = cursos[j];
      const enrollId = `${id}-e${j + 1}`;
      await db.execute({
        sql: `INSERT OR REPLACE INTO inscripciones
              (inscripcion_id,alumno_id,curso_id,tutores,tipo_pago,monto_pago,fecha_inicio,fecha_fin_estimada,completado)
              VALUES (?,?,?,?,'mensual',0,?,?,?)`,
        args: [enrollId, id, cursoId, PROFES[i % PROFES.length], dia(3, 2), dia(8, 30), estado === 'finalizado' ? 1 : 0],
      });

      const temas = TEMAS[cursoId] || ['Clase'];
      const cuantas = 4 + (i % 4);
      for (let k = 0; k < cuantas; k++) {
        await db.execute({
          sql: `INSERT OR REPLACE INTO clases
                (id,inscripcion_id,fecha,hora_inicio,hora_fin,modalidad,tema,profesor,observaciones,homework_tarea,homework_hecho)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          args: [`${enrollId}-CL-${k}`, enrollId, dia(4, 1 + k * 3), '18:00', '20:00',
                 i % 4 === 0 ? 'virtual' : 'presencial',
                 temas[k % temas.length], PROFES[i % PROFES.length],
                 k % 2 === 0 ? 'Avanzo bien con los ejercicios.' : '',
                 k % 3 === 0 ? `Practica ${k + 1}` : '', k % 3 === 0 && k < cuantas - 1 ? 1 : 0],
        });
        nClases++;
      }
    }

    // Asistencias
    for (let k = 0; k < 6; k++) {
      const presente = !(k === 3 && i % 3 === 0);
      await db.execute({
        sql: `INSERT INTO asistencias_generales (alumno_id,fecha,presente,horas,observaciones) VALUES (?,?,?,?,?)`,
        args: [id, dia(4, 1 + k * 3), presente ? 1 : 0, presente ? 2 : 0, presente ? '' : 'Aviso con anticipacion.'],
      });
      nAsist++;
    }

    // Pagos: algunos meses pagados, el ultimo pendiente
    const meses = ['Marzo', 'Abril', 'Mayo', 'Junio'];
    for (let k = 0; k < meses.length; k++) {
      await db.execute({
        sql: `INSERT OR REPLACE INTO pagos_alumno (id,alumno_id,fecha,concepto,monto,pagado) VALUES (?,?,?,?,?,?)`,
        args: [`${id}-PAY-${k}`, id, dia(3 + k, 5), `Cuota ${meses[k]}`, monto, k < meses.length - 1 ? 1 : 0],
      });
      nPagos++;
    }
  }

  console.log(`  ${NOMBRES.length} alumnos`);
  console.log(`  ${nClases} clases`);
  console.log(`  ${nAsist} asistencias`);
  console.log(`  ${nPagos} pagos`);
  console.log('\nListo. Arranca con:  npm start');
  console.log('Usuario: admin   Contrasena: la que hayas puesto en APP_PASSWORD\n');
}

// process.exit explicito: server.js deja un setInterval vivo (limpieza del
// rate limit) que si no dejaria el proceso colgado al terminar la carga.
main()
  .then(() => process.exit(0))
  .catch(e => { console.error('Error:', e.message); process.exit(1); });
