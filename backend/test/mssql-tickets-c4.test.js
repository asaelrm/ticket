// C4 · POST /api/tickets, GET /api/tickets y GET /api/tickets/:id sobre el
// contrato async (DB_CLIENT=mssql).
//
// La suite corre con DB_CLIENT=sqlite (test/setup.js), así que aquí se comprueba
// lo que SÍ puede comprobarse sin un SQL Server real:
//
//   1. Fuente: los tres manejadores eligen la rama mssql ANTES de la primera
//      consulta y el bloque MSSQL no toca la fachada `db` (que es un Proxy que
//      lanza), ni el SQL de SQLite (strftime, LIMIT, lastInsertRowid, ON
//      CONFLICT).
//   2. Comportamiento: las funciones exportadas se llaman con un contrato falso
//      que registra SQL y parámetros, de modo que se verifica que el SQL usa
//      @nombre, CONVERT(...,127), CAST(...,date) y OFFSET/FETCH, y que los
//      resultados se normalizan como los de SQLite (BIT -> 1/0).
//   3. POST: la numeración, el INSERT, los adjuntos, el historial y la
//      actualización de updated_at se emiten en el orden correcto, y un fallo
//      dentro de la transacción compensa los ficheros escritos en disco.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import config from '../src/config.js';
import { createTicketMssql, listTicketsMssql, ticketDetailMssql } from '../src/routes/tickets.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

function entre(fuente, inicioMarca, finMarca) {
  const i = fuente.indexOf(inicioMarca);
  assert.ok(i > -1, `falta la marca de inicio: ${inicioMarca}`);
  const j = fuente.indexOf(finMarca, i + 1);
  assert.ok(j > i, `falta la marca de fin: ${finMarca}`);
  return fuente.slice(i, j);
}

/** Contrato falso: registra cada consulta y responde según `reglas`. */
function fakeContract(reglas = []) {
  const calls = [];
  async function run(kind, sql, params) {
    calls.push({ kind, sql, params: params ?? {} });
    for (const [re, respuesta] of reglas) {
      if (!re.test(sql)) continue;
      return typeof respuesta === 'function' ? respuesta({ kind, sql, params }) : respuesta;
    }
    if (kind === 'queryMany') return [];
    if (kind === 'insert') return { id: 1, rowsAffected: 1 };
    if (kind === 'execute') return { rowsAffected: 1 };
    return null;
  }
  const contract = {
    calls,
    queryOne: (sql, params) => run('queryOne', sql, params),
    queryMany: (sql, params) => run('queryMany', sql, params),
    execute: (sql, params) => run('execute', sql, params),
    insertAndGetId: (sql, params) => run('insert', sql, params),
    async transactionAsync(callback) {
      return callback(contract);
    },
  };
  return contract;
}

const buscar = (c, re) => c.calls.filter((call) => re.test(call.sql));
const valores = (c) => c.calls.flatMap((call) => Object.values(call.params || {}));

const TICKET_ROW = {
  id: 5,
  ticket_number: 'TCK-000001',
  title: 'Impresora atascada',
  description: 'No saca papel',
  status: 'OPEN',
  priority: 'HIGH',
  reporter_id: 77,
  assigned_to_id: null,
  created_at: '2026-01-05T10:00:00.000Z',
  is_overdue: 0,
  resolution_notified: true,
};

const usuarioAdmin = { id: 9, name: 'Ada', last_name: 'Lovelace', permissions: ['ticket.view.all'], department_id: null };

/** Quita los comentarios: el bloque explica a propósito por qué `db.prepare` ya
 *  no puede usarse, y una aserción sobre el texto comentado no prueba nada. */
function sinComentarios(texto) {
  return texto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\r\n]*/g, '');
}

describe('C4 · fuente de la rama MSSQL', () => {
  const fuente = readFileSync(new URL('../src/routes/tickets.js', import.meta.url), 'utf8');
  const bloque = entre(fuente, 'Rama MSSQL de los tres endpoints', 'Contadores din');
  const codigo = sinComentarios(bloque);

  it('el bloque MSSQL no toca la fachada legacy `db`', () => {
    assert.doesNotMatch(codigo, /\bdb\./, '`db` es un Proxy que lanza con DB_CLIENT=mssql');
    assert.doesNotMatch(codigo, /\.prepare\(/);
    assert.doesNotMatch(codigo, /lastInsertRowid/);
  });

  it('el bloque MSSQL no usa SQL de SQLite', () => {
    assert.doesNotMatch(codigo, /strftime\(/, 'strftime no existe en SQL Server');
    assert.doesNotMatch(codigo, /\bLIMIT\s+\d/, 'SQL Server usa OFFSET/FETCH');
    assert.doesNotMatch(codigo, /ON CONFLICT/, 'ON CONFLICT es de SQLite');
    assert.doesNotMatch(codigo, /INSERT OR REPLACE/);
    // El concat de SQLite es `a || ' ' || b`; en JS los `||` son operadores
    // legítimos, así que se comprueba el idioma dentro del SQL y no el operador.
    assert.doesNotMatch(codigo, /\|\|\s*'\s'\s*\|\|/, 'la concatenación de SQLite debe ser CONCAT');
    assert.match(codigo, /CONCAT\(/);
    assert.match(codigo, /OFFSET @offset ROWS FETCH NEXT @take ROWS ONLY/);
    assert.match(codigo, /CONVERT\(datetime2\(3\)/);
    assert.match(codigo, /CONVERT\(date, t\.created_at\) =/);
    assert.match(codigo, /SYSUTCDATETIME\(\)/, 'now() de SQLite no existe; SQL Server usa SYSUTCDATETIME');
  });

  it('los tres manejadores eligen la rama mssql antes de la primera consulta', () => {
    const post = entre(fuente, 'router.post(', "router.get('/',");
    const lista = entre(fuente, "router.get('/', asyncHandler", "router.get('/export'");
    const detalle = entre(fuente, "router.get('/:id', asyncHandler", "router.get('/:id/articles'");

    assert.match(post, /config\.dbClient === 'mssql'/);
    assert.match(post, /createTicketMssql\(/);
    assert.match(post, /err\.attachments/, 'el mensaje de adjuntos se responde en el manejador');
    assert.match(post, /res\.status\(201\)/);

    assert.match(lista, /config\.dbClient === 'mssql'/);
    assert.match(lista, /listTicketsMssql\(req, viewOnlyOwn/);

    assert.match(detalle, /config\.dbClient === 'mssql'/);
    assert.match(detalle, /ticketDetailMssql\(req/);
    assert.match(detalle, /res\.status\(404\)/, 'sin ticket visible debe seguir siendo un 404');
  });
});

describe('C4 · GET /api/tickets sobre el contrato', () => {
  it('emite @nombre, CONVERT estilos 127/23 y OFFSET/FETCH, y pagina', async () => {
    const req = {
      user: usuarioAdmin,
      query: {
        status: 'OPEN',
        priority: 'HIGH,CRITICAL',
        search: 'correo',
        date: '2026-01-05',
        from: '2026-01-01',
        to: '2026-01-31',
        page: '2',
        perPage: '10',
        sort: 'priority',
        dir: 'asc',
      },
    };
    const c = fakeContract([
      [/^SELECT COUNT\(\*\) AS n/, { n: 40 }],
      [/OFFSET @offset/, [{ id: 1, resolution_notified: true }, { id: 2, resolution_notified: 0 }]],
    ]);

    const res = await listTicketsMssql(req, false, c);

    assert.deepEqual(
      { total: res.total, page: res.page, perPage: res.perPage, pages: res.pages },
      { total: 40, page: 2, perPage: 10, pages: 4 },
    );
    assert.equal(res.data[0].resolution_notified, 1, 'BIT debe volver 1, no true');
    assert.equal(res.data[1].resolution_notified, 0, 'BIT debe volver 0, no false');

    const [count] = buscar(c, /^SELECT COUNT\(\*\) AS n/);
    assert.match(count.sql, /FROM tickets t/);
    assert.doesNotMatch(count.sql, /LIMIT/);
    assert.equal(count.params.offset, undefined, 'el COUNT no lleva paginación');

    const [lista] = buscar(c, /OFFSET @offset/);
    assert.match(lista.sql, /ORDER BY CASE t\.priority/, 'sort=priority debe ordenar por prioridad');
    assert.match(lista.sql, /OFFSET @offset ROWS FETCH NEXT @take ROWS ONLY/);
    assert.doesNotMatch(lista.sql, /strftime\(/);
    assert.doesNotMatch(lista.sql, /db\.prepare/);
    assert.doesNotMatch(lista.sql, /LIKE \?/);
    assert.match(lista.sql, /CONVERT\(date, t\.created_at\) = CAST\(@p\d+ AS date\)/);
    assert.match(lista.sql, /t\.created_at >= CONVERT\(datetime2\(3\), @p\d+, 127\)/);
    assert.match(lista.sql, /t\.created_at <= CONVERT\(datetime2\(3\), @p\d+, 127\)/);
    assert.equal(lista.params.offset, 10, 'página 2 con perPage 10');
    assert.equal(lista.params.take, 10);

    const p = { ...lista.params };
    const valoresBuscados = Object.values(p);
    for (const esperado of ['%correo%', 'OPEN', 'HIGH', 'CRITICAL', '2026-01-05', '2026-01-01T00:00:00.000Z', '2026-01-31T23:59:59.999Z']) {
      assert.ok(valoresBuscados.includes(esperado), `falta el parámetro ${esperado}: ${JSON.stringify(valoresBuscados)}`);
    }
    assert.ok(valoresBuscados.length >= 8, 'cada condición debe llevar su propio parámetro');
  });

  it('view=my-teams sin equipos produce 1 = 0 y con equipos une por los ids', async () => {
    const sinEquipos = fakeContract([
      [/FROM team_members/, []],
      [/^SELECT COUNT\(\*\) AS n/, { n: 0 }],
      [/OFFSET @offset/, []],
    ]);
    await listTicketsMssql({ user: usuarioAdmin, query: { view: 'my-teams' } }, false, sinEquipos);
    assert.match(buscar(sinEquipos, /OFFSET @offset/)[0].sql, /1 = 0/, 'sin equipos no debe devolver todo');

    const conEquipos = fakeContract([
      [/FROM team_members/, [{ team_id: 3 }, { team_id: 5 }]],
      [/^SELECT COUNT\(\*\) AS n/, { n: 1 }],
      [/OFFSET @offset/, [{ id: 1 }]],
    ]);
    await listTicketsMssql({ user: usuarioAdmin, query: { view: 'my-teams' } }, false, conEquipos);
    const [lista] = buscar(conEquipos, /OFFSET @offset/);
    assert.match(lista.sql, /t\.assigned_team_id IN \(@p\d+, @p\d+\)/);
    assert.ok(valores(conEquipos).includes(3) && valores(conEquipos).includes(5));
  });

  it('viewOnlyOwn limita al reportante con parámetro nombrado', async () => {
    const c = fakeContract([
      [/^SELECT COUNT\(\*\) AS n/, { n: 0 }],
      [/OFFSET @offset/, []],
    ]);
    await listTicketsMssql({ user: { ...usuarioAdmin, id: 42 }, query: {} }, true, c);
    const [count] = buscar(c, /^SELECT COUNT\(\*\) AS n/);
    assert.match(count.sql, /t\.reporter_id = @p0/);
    assert.equal(count.params.p0, 42);
  });
});

describe('C4 · GET /api/tickets/:id sobre el contrato', () => {
  // `SELECT ta.*, …` / `SELECT tc.*, …` / `SELECT th.*, …`: los tres SELECT de
  // detalle comparten subconsultas entre sí, así que se distinguen por la
  // columna raíz y no por la tabla que aparece dentro.
  const ADJUNTOS = /SELECT ta\.\*, CONCAT\(u\.name/;
  const COMENTARIOS = /SELECT tc\.\*, CONCAT\(u\.name/;
  const HISTORIAL = /SELECT th\.\*, CONCAT\(u\.name/;

  const reglas = [
    [/WHERE t\.id = @id/, TICKET_ROW],
    [ADJUNTOS, [{ id: 11, is_internal: 0, comment_id: null }]],
    [COMENTARIOS, [{ id: 21, is_internal: true, message: 'nota interna' }]],
    [HISTORIAL, [{ id: 31, action: 'CREATED' }]],
  ];

  it('devuelve null sin tocar el resto de consultas si no hay ticket', async () => {
    const c = fakeContract([[ /WHERE t\.id = @id/, null ]]);
    const res = await ticketDetailMssql({ user: usuarioAdmin, params: { id: '5' } }, c);
    assert.equal(res, null);
    assert.equal(c.calls.length, 1, 'no debe consultar adjuntos/comentarios de un ticket inexistente');
  });

  it('devuelve null si el usuario no puede verlo (404 en el manejador)', async () => {
    const c = fakeContract(reglas);
    const res = await ticketDetailMssql(
      { user: { id: 1, permissions: [] }, params: { id: '5' } },
      c,
    );
    assert.equal(res, null, 'reportante 77 no puede ver el ticket del usuario 1');
    assert.equal(c.calls.length, 1);
  });

  it('normaliza BIT, filtra notas internas y arma `can`', async () => {
    const conPermiso = fakeContract(reglas);
    const admin = await ticketDetailMssql(
      {
        user: { ...usuarioAdmin, permissions: ['ticket.view.all', 'ticket.close', 'ticket.comment', 'ticket.note'] },
        params: { id: '5' },
      },
      conPermiso,
    );
    assert.ok(admin);
    assert.equal(admin.ticket.resolution_notified, 1);
    assert.equal(admin.comments[0].is_internal, 1, 'BIT de ticket_comments también a entero');
    assert.deepEqual(
      { close: admin.can.close, note: admin.can.note, manage: admin.can.manage, comment: admin.can.comment },
      { close: true, note: true, manage: false, comment: true },
    );
    const [adj] = buscar(conPermiso, ADJUNTOS);
    assert.match(adj.sql, /@canSeeInternal = 1/);
    assert.deepEqual(adj.params, { ticketId: 5, canSeeInternal: 1 });
    assert.doesNotMatch(buscar(conPermiso, COMENTARIOS)[0].sql, /AND tc\.is_internal = 0/);

    const sinPermiso = fakeContract(reglas);
    const empleado = await ticketDetailMssql(
      { user: { id: 77, permissions: [] }, params: { id: '5' } },
      sinPermiso,
    );
    assert.ok(empleado, 'el reportante sí ve su ticket');
    assert.equal(empleado.can.note, false);
    assert.equal(empleado.can.close, false);
    assert.match(buscar(sinPermiso, COMENTARIOS)[0].sql, /AND tc\.is_internal = 0/);
    assert.match(
      buscar(sinPermiso, HISTORIAL)[0].sql,
      /NOT IN \('NOTE_ADDED','NOTE_ATTACHMENT_ADDED'\)/,
    );
    assert.equal(buscar(sinPermiso, ADJUNTOS)[0].params.canSeeInternal, 0);
  });
});

describe('C4 · POST /api/tickets sobre el contrato', () => {
  const reglasBase = [
    [/UPDATE dbo\.sequences/, { value: 42 }],
    [/WHERE \[key\] = @key/, null],
    [/FROM settings/, []],
    [/SELECT id FROM categories/, ({ params }) => (params.id === 999 ? null : { id: 3 })],
    [/INSERT INTO tickets/, { id: 5, rowsAffected: 1 }],
    [/WHERE t\.id = @id/, TICKET_ROW],
  ];

  it('reserva el número y escribe ticket, historial y updated_at en la transacción', async () => {
    const c = fakeContract([
      ...reglasBase.slice(0, 5),
      // La relectura final devuelve el ticket recién creado, con su número.
      [/WHERE t\.id = @id/, { ...TICKET_ROW, ticket_number: 'TCK-000042' }],
    ]);
    const res = await createTicketMssql(
      { body: { title: 'Conector suelto', description: 'Se mueve', category_id: 3, priority: 'HIGH' }, user: usuarioAdmin, files: [] },
      c,
    );

    assert.equal(res.ticket.ticket_number, 'TCK-000042');
    assert.deepEqual(res.attachments, []);

    const [secuencia] = buscar(c, /UPDATE dbo\.sequences/);
    assert.match(secuencia.sql, /WITH \(UPDLOCK, HOLDLOCK\)/, 'C3 decide la numeración; no se duplica aquí');
    assert.match(secuencia.sql, /OUTPUT INSERTED\.value AS value/);
    assert.equal(secuencia.params.name, 'ticket_number');

    const [ins] = buscar(c, /INSERT INTO tickets/);
    assert.match(ins.sql, /OUTPUT INSERTED\.id AS id/);
    assert.doesNotMatch(ins.sql, /lastInsertRowid|\?/);
    assert.equal(ins.params.ticketNumber, 'TCK-000042');
    assert.equal(ins.params.reporterId, 9);
    assert.equal(ins.params.categoryId, 3);
    assert.equal(ins.params.priority, 'HIGH');
    // HIGH = 24 h por defecto (settings vacío -> DEFAULT_SLA_HOURS).
    const desfase = Math.abs(Date.parse(ins.params.slaDueAt) - Date.now());
    assert.ok(Math.abs(desfase - 24 * 3600 * 1000) < 120_000, `slaDueAt=${ins.params.slaDueAt}`);

    const historial = buscar(c, /INSERT INTO ticket_history/).map((call) => call.params.action);
    assert.ok(historial.includes('CREATED'), `historial=${JSON.stringify(historial)}`);

    assert.ok(buscar(c, /UPDATE tickets SET updated_at = @now/).length === 1, 'updated_at se toca dentro de la transacción');

    const [staff] = buscar(c, /p\.code = 'ticket\.view\.all'/);
    assert.ok(staff, 'debe avisar al personal con ticket.view.all');
    assert.equal(staff.kind, 'queryMany');

    const orden = c.calls.findIndex((call) => /INSERT INTO tickets/.test(call.sql));
    const creacion = c.calls.findIndex((call) => call.params && call.params.action === 'CREATED');
    assert.ok(orden < creacion, 'el ticket debe existir antes de su historial');
  });

  it('un fallo de adjuntos dentro de la transacción compensa los ficheros de disco', async () => {
    const c = fakeContract([
      ...reglasBase.slice(0, 5),
      [/INSERT INTO ticket_attachments/, () => { throw new Error('fallo provocado'); }],
      [/WHERE t\.id = @id/, TICKET_ROW],
    ]);
    const antes = readdirSync(config.uploadDir);

    await assert.rejects(
      createTicketMssql(
        { body: { title: 'Con adjunto', description: 'D', category_id: 3 }, user: usuarioAdmin, files: [{ buffer: PNG, originalname: 'una.png' }] },
        c,
      ),
      (err) => {
        assert.equal(err.attachments, true, 'el manejador distingue este error de un 500 genérico');
        assert.equal(err.message, 'Error al guardar los archivos adjuntos');
        assert.equal(err.status, 500);
        return true;
      },
    );

    assert.deepEqual(readdirSync(config.uploadDir), antes, 'el rollback no puede deshacer writeFileSync: hay que borrarlo a mano');
    assert.ok(buscar(c, /INSERT INTO ticket_attachments/).length === 1);
  });

  it('valida como el camino SQLite: campos, categoría, departamento y ficheros', async () => {
    await assert.rejects(
      createTicketMssql({ body: { description: 'sin título', category_id: 3 }, user: usuarioAdmin, files: [] }, fakeContract(reglasBase)),
      (err) => err.name === 'ValidationError',
    );

    await assert.rejects(
      createTicketMssql({ body: { title: 'T', description: 'D', category_id: 999 }, user: usuarioAdmin, files: [] }, fakeContract(reglasBase)),
      (err) => err.status === 400 && err.message === 'Categoría inválida',
    );

    const conDepartamento = fakeContract([
      ...reglasBase.slice(0, 5),
      [/SELECT id FROM departments/, null],
    ]);
    await assert.rejects(
      createTicketMssql({ body: { title: 'T', description: 'D', category_id: 3, department_id: 999 }, user: usuarioAdmin, files: [] }, conDepartamento),
      (err) => err.status === 400 && err.message === 'Departamento inválido',
    );

    const muchos = Array.from({ length: config.uploads.maxFilesPerTicket + 1 }, (_, i) => ({
      buffer: PNG,
      originalname: `f${i}.png`,
    }));
    await assert.rejects(
      createTicketMssql({ body: { title: 'T', description: 'D', category_id: 3 }, user: usuarioAdmin, files: muchos }, fakeContract(reglasBase)),
      (err) => err.status === 400 && err.message === `Máximo ${config.uploads.maxFilesPerTicket} archivos por ticket`,
    );

    await assert.rejects(
      createTicketMssql(
        { body: { title: 'T', description: 'D', category_id: 3 }, user: usuarioAdmin, files: [{ buffer: Buffer.from('%PDF-1.7'), originalname: 'malicioso.png' }] },
        fakeContract(reglasBase),
      ),
      (err) => err.status === 400,
    );
  });
});
