// B13-A · guardas puras de la migración de departamentos SQLite -> SQL Server.
//
// Este módulo NO abre conexiones, NO lee ficheros y NO escribe nada: son
// funciones que reciben datos y devuelven o lanzan. Todo el "qué se puede
// hacer" de B13-A vive aquí para poder probarlo sin base de datos, que es la
// única forma de comprobar los abortes antes de que exista algo que abortar.
//
// Los valores esperados están escritos a mano y NO se deducen del origen: si
// alguien cambiase la SQLite, el migrador tiene que seguir fallando en lugar
// de declarar bueno lo que encuentre. La auditoría de B13-A es la autoridad.

export const EXPECTED_DATABASE = 'SIFHA_Tickets_DEV';

// El TLD `.invalid` no es un descuido de la auditoría: es la ruta de contenedor
// del volumen `ticket_dev_data`. La SQLite local del host es OTRO fichero con
// otros datos, y migrar el equivocado dejaría departments incoherentes con los
// usuarios que se migrarán después (que necesitan department_id 1, 2 y 23).
export const SOURCE_SQLITE_PATH = '/app/backend/data/tickets.db';

// Identidad que no se permite ni aunque el resto de guardas pase. `sa` puede
// saltarse cualquier permiso y no deja rastro de qué hizo: la migración se
// declara explícitamente como no-permisiva, así que se rechaza por su nombre.
export const FORBIDDEN_LOGINS = ['sa'];

// `db_owner` y `sysadmin` pueden saltarse la restricción de IDENTITY_INSERT que
// esta migración necesita para poder abortar, así que también se rechazan.
export const FORBIDDEN_ROLES = ['sysadmin', 'db_owner', 'db_ddladmin'];

// ---------------------------------------------------------------------------
// Identidad EXCLUSIVA de migración
// ---------------------------------------------------------------------------

/**
 * Nombre de la variable de entorno que declara cuál es la ÚNICA identidad
 * autorizada a ejecutar la migración.
 *
 * NO contiene contraseña: es una allowlist de un solo nombre, sin ningún otro
 * valor. Por eso no se imprime nunca, ni en los logs ni en los mensajes de
 * error de esta migración: solo se compara. La credencial de esa identidad vive
 * en el secret store del contenedor y no se documenta ni se commitea.
 *
 * El nombre real del login NO está en el código: el auditor de privilegios
 * rejectionsó elevar `sifha_ticket_dev`, así que la migración usa una identidad
 * dedicada aparte y este fichero no la conoce.
 */
export const MIGRATION_LOGIN_ENV_VAR = 'B13A_MIGRATION_LOGIN';

/**
 * Permisos EFECTIVOS que la identidad de migración necesita sobre
 * `dbo.departments`, y solo sobre esa tabla.
 *
 * - `SELECT`: la verificación del destino y la comparación dentro de la
 *   transacción de escritura.
 * - `INSERT`: las 25 filas del manifiesto.
 * - `ALTER`: a nivel de OBJETO, y es lo que exige `SET IDENTITY_INSERT` y
 *   `DBCC CHECKIDENT`. Sin ALTER la migración llega hasta el final y revienta
 *   al activar IDENTITY_INSERT, con la transacción ya abierta.
 *
 * No se comprueban aquí porque el migrador NO otorga permisos: comprueba que los
 * tiene, y los GRANT/REVOKE son un procedimiento administrativo aparte, antes y
 * después de la ventana.
 */
export const REQUIRED_WRITE_PERMISSIONS = Object.freeze(['SELECT', 'INSERT', 'ALTER']);

// La tabla objetivo de esos permisos, tal y como la llama SQL Server. Va aquí
// para que el mensaje de error y la prueba no puedan divergir del SQL.
export const MIGRATION_TARGET_OBJECT = 'dbo.departments';

// 25 filas, con los huecos 8, 17, 22, 24 y 27 preservados. Renumerar para dejar
// 1..25 rompería las referencias de los usuarios ya migrados.
export const EXPECTED_DEPARTMENT_COUNT = 25;

export const APPROVED_DEPARTMENT_IDS = Object.freeze([
  1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 18,
  19, 20, 21, 23, 25, 26, 28, 29, 30,
]);

// Los usuarios que se migrarán en B13-B referencian estos tres. Si el
// manifiesto no los trae, la migración siguiente ni siquiera puede empezar.
export const REQUIRED_DEPARTMENT_IDS = Object.freeze([1, 2, 23]);

// `sqlite_sequence.seq` de la fuente. Se conserva en el destino para que el
// próximo id automático sea 481 y no choque con nada que ya exista.
export const EXPECTED_SQLITE_SEQUENCE = 480;

/**
 * Interruptor del requisito 23, deliberadamente en `false`.
 *
 * YA NO ES UNA CUESTIÓN DE DISEÑO, ES UN HECHO MEDIDO. El probe real en SQL
 * Server DEV hizo un INSERT explícito con id=478 y `DBCC CHECKIDENT` falló con
 * error 2557 por permisos; al hacer ROLLBACK, `dbo.departments` volvió a 0 filas
 * pero `last_value` SE QUEDÓ EN 478.
 *
 * O sea: un INSERT explícito con `IDENTITY_INSERT` AVANZA el contador de
 * identidad, y el ROLLBACK NO lo restaura. La garantía que este interruptor
 * daba por supuesta era falsa. Por eso la carga (Fase 1) ya no hace DBCC en
 * absoluto: el reseed es una Fase 2 aparte, fuera de la transacción y todavía
 * sin implementar como ruta ordinaria.
 */
export const RESEED_ROLLBACK_PROVEN = false;

/**
 * `last_value` que tiene que tener `dbo.departments` ANTES de la Fase 1.
 *
 * Es el estado real heredado de DEV (0 filas, identidad 44), y por eso es la
 * precondición de la carga. Si al empezar no es exactamente esto, el migrador
 * NO toca nada y exige revisión manual.
 */
export const EXPECTED_DESTINATION_LAST_VALUE = 44;

/**
 * `last_value` que significa "B13-A terminado": la Fase 2 habría hecho
 * `DBCC CHECKIDENT (dbo.departments, RESEED, 480)`, dejando el próximo id
 * automático en 481.
 *
 * Solo se usa para RECONOCER el estado final. El migrador no lo produce: la Fase
 * 2 todavía no existe como ruta ejecutable.
 */
export const EXPECTED_FINAL_LAST_VALUE = EXPECTED_SQLITE_SEQUENCE;

// Los cuatro estados de B13-A. Los tres primeros son coherentes y el cuarto es
// "no toques nada, que esto lo mira una persona".
export const MIGRATION_STATES = Object.freeze({
  /** 0 filas / identidad 44: se puede cargar. */
  CARGA_PENDIENTE: 'CARGA_PENDIENTE',
  /** 25 filas exactas / identidad 44: la carga está hecha, falta el reseed. */
  CARGA_CONFIRMADA_RESEED_PENDIENTE: 'CARGA_CONFIRMADA_RESEED_PENDIENTE',
  /** 25 filas exactas / identidad 480: terminado. */
  COMPLETADO: 'COMPLETADO',
  /** Cualquier otra cosa. Nunca se escribe ni se corrige desde aquí. */
  RECUPERACION_MANUAL: 'RECUPERACION_MANUAL',
});

// dbo.departments.name es NVARCHAR(100). SQLite no tiene longitud máxima, así
// que el recorte hay que(validarlo) aquí o SQL Server lo rechazaría a mitad de
// la transacción, después de haber insertado parte del manifiesto.
export const NAME_MAX_LENGTH = 100;

// dbo.departments.description es NVARCHAR(MAX): no hay recorte, pero se acota
// la longitud a un valor que no admita absurdidades ni truncamiento.
export const DESCRIPTION_MAX_LENGTH = 8000;

const ISO_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export class MigrationGuardError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MigrationGuardError';
  }
}

function fail(message) {
  throw new MigrationGuardError(message);
}

/**
 * Un error de `mssql`/`tedious` lleva dentro el nombre del servidor y, a veces,
 * la cadena de conexión completa. Imprimirlo tal cual escribiría en la consola y
 * en el registro de CI el host de la red privada, así que aquí se deja solo el
 * número y el mensaje de SQL Server.
 */
export function safeErrorMessage(error) {
  if (!error) return 'error desconocido';
  const raw = typeof error === 'string' ? error : (error.message || String(error));
  const number = error && error.number ? ` (error ${error.number})` : '';
  return scrubPrivateData(`${raw}${number}`);
}

/**
 * Sustituye cualquier cosa que parezca infraestructura privada por un marcador.
 * Se aplica a TODO lo que se imprime, no solo a los errores de SQL Server: un
 * `console.log` de una ruta o de un mensaje de driver puede arrastrar el host.
 */
export function scrubPrivateData(text) {
  return String(text)
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<host-redactado>')
    .replace(/[a-z0-9-]{2,}(?:\.[a-z0-9-]{2,})*\.(?:internal|local|corp|lan|intranet)\b/gi, '<host-redactado>')
    .replace(/\b[a-z0-9-]{2,}(?:\\+[a-z0-9-]{2,})+\b/gi, '<instancia-redactada>');
}

/** Solo se acepta `--execute`. Cualquier otra bandera es un error de dedo. */
export function assertExecuteIntent(args = []) {
  const known = ['--execute'];
  const unknown = args.filter((value) => !known.includes(value));
  if (unknown.length) {
    fail(`Opción no reconocida: ${unknown.join(', ')}. Solo se admite --execute.`);
  }
  return { execute: args.includes('--execute') };
}

/** Requisito 3: sin DB_CLIENT=mssql el migrador ni siquiera se plantea. */
export function assertEngineIsMssql(env = process.env) {
  const client = String(env.DB_CLIENT || '').trim().toLowerCase();
  if (client !== 'mssql') {
    fail(
      `DB_CLIENT debe ser "mssql" para migrar (valor actual: "${client || '(vacío)'}"). `
      + 'La migración escribe en SQL Server; con SQLite no se hace nada.'
    );
  }
  return true;
}

/** Requisito 4: el nombre configurado tiene que ser el DEV exacto. */
export function assertConfiguredDatabase(database) {
  const name = String(database || '').trim();
  if (name !== EXPECTED_DATABASE) {
    fail(`DB_DATABASE="${name || '(vacío)'}" no es ${EXPECTED_DATABASE}. No se continúa.`);
  }
  return true;
}

/**
 * Requisitos 4 y 5: lo que la SERVIDOR dice, no lo que el `.env` pedía. Un
 * `DB_DATABASE` correcto con un destino equivocado en la sesión (un synonym, un
 * `USE` en el login, un AG) solo se detecta preguntando a la conexión.
 */
export function assertConnectionIdentity(identity = {}) {
  const db = String(identity.database || '').trim();
  const login = String(identity.login || '').trim();

  if (db !== EXPECTED_DATABASE) {
    fail(`La conexión está en "${db || '(desconocida)'}" y no en ${EXPECTED_DATABASE}. Se aborta.`);
  }

  const loginNormal = login.toLowerCase();
  const forbidden = FORBIDDEN_LOGINS.find((candidate) => candidate === loginNormal);
  if (forbidden) {
    fail(`La identidad "${forbidden}" no puede ejecutar esta migración. Se aborta.`);
  }

  for (const role of identity.roles || []) {
    const roleNormal = String(role).toLowerCase();
    if (FORBIDDEN_ROLES.includes(roleNormal)) {
      fail(`La identidad tiene el rol "${roleNormal}", que puede saltarse las restricciones. Se aborta.`);
    }
  }

  return { database: db, login };
}

/**
 * Lee la allowlist de identidad de migración del entorno.
 *
 * Sin valor por defecto a propósito: `undefined` y `''` significan lo mismo,
 * "no declarada", que es exactamente lo que la guarda siguiente rechaza para
 * `--execute`. El dry-run no llama a esta función para decidir nada.
 */
export function readMigrationLoginAllowlist(env = process.env) {
  return String(env?.[MIGRATION_LOGIN_ENV_VAR] ?? '').trim();
}

/**
 * Requisito 2 (parte 1): la identidad de migración tiene que estar DECLARADA
 * antes de abrir conexión, para que un `--execute` mal hecho falle sin tocar
 * SQL Server.
 *
 * El mensaje nombra la variable pero no su valor: el valor es el nombre de una
 * identidad y no hace falta imprimirlo para arreglar nada.
 */
export function assertMigrationLoginIsConfigured(allowlistLogin) {
  const declared = String(allowlistLogin ?? '').trim();
  if (!declared) {
    fail(
      `--execute exige una identidad de migración autorizada y ${MIGRATION_LOGIN_ENV_VAR} no está definida.\n`
      + 'Esa variable es una allowlist con un solo nombre de identidad, SIN contraseña. '
      + 'Declárala por procedimiento administrativo antes de la ventana de migración.\n'
      + 'El dry-run NO la necesita: se puede auditar sin ella.'
    );
  }
  return true;
}

/**
 * Requisito 2 (parte 2): la sesión tiene que ser EXACTAMENTE la identidad
 * autorizada.
 *
 * La comparación es exacta, no con `toLowerCase()`: un login de SQL Server
 * aceptaría `MIGRACION` por `migracion` según la intercalación del servidor, y
 * aquí no se quiere heredar esa ambigüedad. Si son distintos, aborta.
 *
 * No se imprime ni el valor declarado ni el de la sesión.
 */
export function assertMigrationIdentityAllowed({ allowlistLogin, sessionLogin } = {}) {
  const declared = String(allowlistLogin ?? '').trim();
  const session = String(sessionLogin ?? '').trim();

  assertMigrationLoginIsConfigured(declared);

  if (!session) {
    fail(
      'No se pudo leer la identidad de la sesión (ORIGINAL_LOGIN() vacío), '
      + 'así que no hay forma de comprobar si es la identidad de migración autorizada. Se aborta.'
    );
  }

  if (session !== declared) {
    fail(
      'La identidad de esta sesión no es la identidad de migración autorizada. Se aborta sin escribir.\n'
      + `Comprueba que ${MIGRATION_LOGIN_ENV_VAR} contiene la identidad que realmente usa esta conexión `
      + 'y que la conexión se abre con ella. Si no sabes cuál es, no la pongas a ojo: es un '
      + 'procedimiento administrativo, y adivinar daría una falsa sensación de control.'
    );
  }

  return true;
}

/**
 * Requisito 4: los tres permisos efectivos sobre `dbo.departments` tienen que
 * estar ahí ANTES de abrir la transacción de escritura.
 *
 * Se lee con `HAS_PERMS_BY_NAME`, que es lo que SQL Server realmente tiene en
 * cuenta (permisos efectivos, no los concedidos), así que un permiso heredado o
 * denegado por mandato se detecta igual que uno ausente.
 *
 * `null` o `undefined` cuentan como falta de permiso, no como permiso: es lo que
 * devuelve `HAS_PERMS_BY_NAME` cuando el objeto no existe o no se puede leer, y
 * en ambos casos la escritura no va a poder hacerse.
 */
export function assertWritePermissions(permissions = {}) {
  const missing = REQUIRED_WRITE_PERMISSIONS.filter((name) => Number(permissions[name]) !== 1);

  if (missing.length) {
    fail(
      `Faltan permisos efectivos sobre ${MIGRATION_TARGET_OBJECT}: ${missing.join(', ')}.\n`
      + `HAS_PERMS_BY_NAME debe devolver 1 para ${REQUIRED_WRITE_PERMISSIONS.join(', ')} `
      + `y ha devuelto otra cosa para: ${missing.join(', ')}.\n`
      + 'ALTER a nivel de objeto es el que exigen SET IDENTITY_INSERT y DBCC CHECKIDENT.\n'
      + 'El migrador NO otorga permisos ni los eleva: concede y revoca son un '
      + 'procedimiento administrativo aparte, antes y después de la ventana.'
    );
  }
  return true;
}

/** Requisito 6: la tabla tiene que estar vacía; si no, no se inserta ni una fila. */
export function assertDestinationIsEmpty(rowCount) {
  const count = Number(rowCount);
  if (!Number.isSafeInteger(count) || count < 0) {
    fail(`No se pudo leer el número de filas de dbo.departments (valor: ${String(rowCount)}).`);
  }
  if (count !== 0) {
    fail(
      `dbo.departments tiene ${count} filas y debe tener 0. `
      + 'La migración solo copia a una tabla vacía para no duplicar ni mezclar datos.'
    );
  }
  return true;
}

/** Requisito 7 y 12: la fuente es la del contenedor, nunca la local del host. */
export function assertSourcePath(path) {
  const resolved = String(path || '').replace(/\\/g, '/');
  if (resolved !== SOURCE_SQLITE_PATH) {
    fail(
      `La SQLite de origen debe ser ${SOURCE_SQLITE_PATH} (recibido: "${resolved || '(vacío)'}"). `
      + 'La copia local del host contiene otros datos y no es la fuente autorizada.'
    );
  }
  return true;
}

/**
 * Convierte el `created_at` de SQLite al literal que se envía a SQL Server.
 *
 * La fuente guarda TEXT ISO UTC con milisegundos (`...T23:57:50.291Z`). El `Z`
 * NO se envía: `DATETIME2` no guarda zona horaria, y con `useUTC: true`
 * tedious lee sus componentes como UTC. Mandar la `Z` a un CONVERT style 126
 * aborta, y mandarla a un 127 depende de la versión. Se quita después de
 * validar el formato, que es donde sí significa algo.
 */
export function toSqlServerDateLiteral(value) {
  const text = String(value ?? '');
  if (!ISO_MILLISECONDS.test(text)) {
    fail(`created_at "${text}" no es TEXT ISO UTC con milisegundos (AAAA-MM-DDTHH:MM:SS.mmmZ).`);
  }
  const literal = text.slice(0, -1);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) {
    fail(`created_at "${text}" no es una fecha real.`);
  }
  return literal;
}

/**
 * Compara el `created_at` leído de SQL Server con el de la fuente.
 *
 * `CONVERT(nvarchar, datetime2, 126)` devuelve `AAAA-MM-DD HH:MM:SS.mmm`, con
 * ESPACIO como separador, mientras que la fuente usa `T`. Si se compararan tal
 * cual, la validación dentro de la transacción fallaría siempre aunque los
 * valores fueran idénticos. Aquí se iguala la forma a la de la fuente.
 */
export function normalizeSqlServerDateLiteral(value) {
  if (value === null || value === undefined) return value;
  const text = value instanceof Date ? value.toISOString() : String(value);
  const trimmed = text.endsWith('Z') ? text.slice(0, -1) : text;
  return trimmed.replace(' ', 'T');
}

/**
 * Requisito 7: valida el manifiesto leído de la SQLite ANTES de que exista una
 * transacción de escritura en el otro motor. Devuelve el mismo manifiesto con
 * las fechas normalizadas, o lanza con el primer problema encontrado.
 */
export function validateDepartmentManifest(manifest) {
  const rows = manifest?.rows;
  if (!Array.isArray(rows)) {
    fail('El manifiesto no contiene filas.');
  }

  // --- recuento -----------------------------------------------------------
  if (rows.length !== EXPECTED_DEPARTMENT_COUNT) {
    fail(`La fuente tiene ${rows.length} departamentos y la auditoría aprueba ${EXPECTED_DEPARTMENT_COUNT}.`);
  }

  // --- ids: enteros, únicos y exactamente los aprobados -------------------
  const ids = rows.map((row) => row?.id);
  for (const id of ids) {
    if (!Number.isSafeInteger(id) || id <= 0) {
      fail(`Hay un id de departamento que no es un entero positivo: ${JSON.stringify(id)}.`);
    }
  }
  const uniqueIds = new Set(ids);
  if (uniqueIds.size !== ids.length) {
    fail('La fuente tiene ids de departamento duplicados.');
  }

  const sorted = [...ids].sort((a, b) => a - b);
  const approved = [...APPROVED_DEPARTMENT_IDS];
  const sameIds = sorted.length === approved.length
    && sorted.every((value, index) => value === approved[index]);
  if (!sameIds) {
    fail(
      'Los ids de la fuente no son los aprobados por la auditoría.\n'
      + `  origen:   ${sorted.join(',')}\n`
      + `  aprobado: ${approved.join(',')}`
    );
  }

  for (const required of REQUIRED_DEPARTMENT_IDS) {
    if (!uniqueIds.has(required)) {
      fail(`Falta el departamento ${required}, que necesitan los usuarios que se migrarán después.`);
    }
  }

  // --- nombres: únicos dos veces, porque SQL Server no distingue mayúsculas -
  const names = rows.map((row) => row?.name);
  for (const name of names) {
    if (typeof name !== 'string' || name.trim() === '') {
      fail(`Hay un departamento con nombre vacío o no textual: ${JSON.stringify(name)}.`);
    }
    if (name !== name.trim()) {
      fail(`El nombre "${name}" empieza o termina con espacios; SQLite los conserva y SQL Server también.`);
    }
    if ([...name].length > NAME_MAX_LENGTH) {
      fail(`El nombre "${name}" excede los ${NAME_MAX_LENGTH} caracteres de NVARCHAR(100).`);
    }
  }
  const exactNames = new Set(names);
  if (exactNames.size !== names.length) {
    fail('La fuente tiene nombres de departamento duplicados.');
  }
  // La UQ_departments_name de SQL Server usa la intercalación del servidor, que
  // normalmente no distingue mayúsculas: dos nombres que solo se diferencian en
  // el caso NO caben en esa restricción aunque en SQLite sí.
  const folded = new Map();
  for (const name of names) {
    const key = name.toLocaleLowerCase('en-US');
    folded.set(key, (folded.get(key) || 0) + 1);
  }
  const collisions = [...folded.entries()].filter(([, total]) => total > 1).map(([key]) => key);
  if (collisions.length) {
    fail(`Nombres que solo difieren en mayúsculas y colisionarían en SQL Server: ${collisions.join(', ')}.`);
  }

  // --- description: NULL o texto ------------------------------------------
  for (const row of rows) {
    if (row.description !== null && typeof row.description !== 'string') {
      fail(`description del departamento ${row.id} no es texto ni NULL.`);
    }
    if (typeof row.description === 'string' && row.description.length > DESCRIPTION_MAX_LENGTH) {
      fail(`description del departamento ${row.id} excede los ${DESCRIPTION_MAX_LENGTH} caracteres.`);
    }
  }

  // --- active: 0 o 1, nunca otra cosa -------------------------------------
  for (const row of rows) {
    if (row.active !== 0 && row.active !== 1) {
      fail(`active del departamento ${row.id} es ${JSON.stringify(row.active)} y solo admite 0 o 1.`);
    }
  }

  // --- created_at ---------------------------------------------------------
  for (const row of rows) {
    if (typeof row.created_at !== 'string') {
      fail(`created_at del departamento ${row.id} no es TEXT.`);
    }
    toSqlServerDateLiteral(row.created_at);
  }

  // --- sqlite_sequence y estado del fichero ------------------------------
  const sequence = manifest.sequence;
  if (Number(sequence) !== EXPECTED_SQLITE_SEQUENCE) {
    fail(
      `sqlite_sequence de departments es ${String(sequence)} y la auditoría aprueba ${EXPECTED_SQLITE_SEQUENCE}. `
      + 'El valor se conserva en el destino: si cambia, el próximo id automático sería otro.'
    );
  }

  if (!Array.isArray(manifest.foreignKeyViolations) || manifest.foreignKeyViolations.length !== 0) {
    const detail = JSON.stringify(manifest.foreignKeyViolations ?? null);
    fail(`PRAGMA foreign_key_check de la fuente no está limpio: ${detail}`);
  }

  if (manifest.journalMode !== 'wal') {
    fail(
      `La fuente está en journal_mode="${manifest.journalMode}" y no en "wal". `
      + 'Sin WAL no se puede garantizar una instantánea coherente con la que la app está usando.'
    );
  }

  return {
    rows: rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      active: row.active,
      created_at: toSqlServerDateLiteral(row.created_at),
    })),
    sequence: EXPECTED_SQLITE_SEQUENCE,
    walBytes: manifest.walBytes ?? 0,
  };
}

/**
 * Requisito 20 (parte 1): comparar las filas leídas contra el manifiesto, y
 * devolver las DIFERENCIAS en vez de lanzar.
 *
 * Se separa de `compareManifestToRows` porque la clasificación de estados
 * necesita la misma comparación pero SIN lanzar: un destino con filas raras no
 * es un fallo de la migración, es un `RECUPERACION_MANUAL` que hay que
 * describir para que una persona lo mire.
 */
export function diffManifestToRows(manifest, rows) {
  const actual = [...(rows || [])].sort((a, b) => Number(a.id) - Number(b.id));
  const expected = [...(manifest?.rows || [])].sort((a, b) => a.id - b.id);
  const diffs = [];

  if (actual.length !== expected.length) {
    diffs.push(`hay ${actual.length} filas y el manifiesto tiene ${expected.length}`);
    return diffs;
  }

  for (let index = 0; index < expected.length; index += 1) {
    const want = expected[index];
    const got = actual[index];

    if (Number(got.id) !== want.id) {
      diffs.push(`id ${want.id}: en destino ${got.id}`);
      continue;
    }
    if (got.name !== want.name) {
      diffs.push(`nombre ${want.id}: "${got.name}" != "${want.name}"`);
    }
    if ((got.description ?? null) !== want.description) {
      diffs.push(`description ${want.id}: difiere`);
    }
    if (Number(got.active) !== want.active) {
      diffs.push(`active ${want.id}: ${got.active} != ${want.active}`);
    }
    const gotDate = normalizeSqlServerDateLiteral(got.created_at);
    if (gotDate !== want.created_at) {
      diffs.push(`created_at ${want.id}: "${gotDate}" != "${want.created_at}"`);
    }
  }

  for (const required of REQUIRED_DEPARTMENT_IDS) {
    if (!actual.some((row) => Number(row.id) === required)) {
      diffs.push(`falta el departamento ${required}`);
    }
  }

  return diffs;
}

/** Requisito 20: la comparación de lo que hay dentro de la transacción. */
export function compareManifestToRows(manifest, rows) {
  const diffs = diffManifestToRows(manifest, rows);
  if (diffs.length) {
    fail('La comparación dentro de la transacción ha fallado:\n  - ' + diffs.join('\n  - '));
  }
  return true;
}

/**
 * Precondición de escritura de la Fase 1, comprobada con una conexión nueva
 * justo antes de abrir la transacción.
 *
 * La clasificación de estados ya dijo que el destino está en CARGA_PENDIENTE,
 * pero entre esa lectura y la escritura ha podido pasar otra cosa. Es la última
 * línea de defensa: si la tabla no está vacía, o la identidad no es la que la
 * carga da por hecho, no se escribe ni una fila.
 */
export function assertLoadBaseline({ rowCount, identityLastValue } = {}) {
  assertDestinationIsEmpty(rowCount);

  const identity = Number(identityLastValue);
  if (identity !== EXPECTED_DESTINATION_LAST_VALUE) {
    fail(
      `Antes de la Fase 1, last_value de ${MIGRATION_TARGET_OBJECT} debe ser `
      + `${EXPECTED_DESTINATION_LAST_VALUE} y es ${String(identityLastValue)}. `
      + 'La carga no se escribe sobre una identidad que no reconoce: eso es '
      + 'RECUPERACION_MANUAL y lo tiene que resolver alguien por procedimiento aprobado.'
    );
  }
  return true;
}

// ---------------------------------------------------------------------------
// AFINIDAD DE SESIÓN · POR QUÉ ESTÁ ESTO Y POR QUÉ NO ES OPCIONAL
//
// `IDENTITY_INSERT` y `XACT_ABORT` son estado de SESIÓN en SQL Server: viven en
// la conexión física (lo que `@@SPID` identifica), no en la base de datos. El
// ROLLBACK no los restaura y ningún INSERT posterior los cambia.
//
// La librería `mssql` no da sesiones: su `Connection` ES un POOL de conexiones
// TDS. Toma una prestada y la devuelve al pool en cada `connection.request()`, y
// `new Transaction(connection)` toma OTRA y la reserva hasta el COMMIT o el
// ROLLBACK. Su propia documentación lo dice: "Once you create a new
// Request/Transaction/Prepared Statement, a new TDS connection is acquired from
// the pool".
//
// De ahí el error 544 del primer `--execute` de DEV: el `SET IDENTITY_INSERT ... ON`
// se envió por el pool y los 25 INSERT por la Transaction, y no eran la misma
// sesión.
//
// Y de ahí el segundo `--execute`, que NO arregló poner el pool a `min:1/max:1`.
// Fijar el pool NO es una garantía: con `max:1` sigue habiendo una sola conexión,
// peroPrestarla y devolverla no es lo mismo que reservarla. Lo que sí reserva es
// la Transaction: mientras `_acquiredConnection` está puesta,
// `Transaction.acquire()` devuelve SIEMPRE esa misma conexión
// (`base/transaction.js:67`) y se niega a dar ninguna antes del `begin()`
// (`ENOTBEGUN`). Por eso la Fase 1 hace el ON, los INSERT, las validaciones y el
// OFF por dentro de la Transaction: no hay pool en medio que pueda repartir.
//
// Y el OFF va ANTES del COMMIT a propósito, porque el COMMIT suelta la conexión
// al pool (`tedious/transaction.js:65`). Después del COMMIT ya no hay sesión que
// apagar: hay una conexión prestada que puede ser de otro.
//
// ---------------------------------------------------------------------------
// LO QUE NO SE PUEDE COMPROBAR, Y POR QUÉ NO SE INVENTA NADA EN SU LUGAR
//
// Antes esta Fase 1 exigía, antes del primer INSERT, que
// `SESSIONPROPERTY('IdentityInsert')` devolviera `dbo.departments`, y abortaba si
// no. Esa comprobación era FALSA y abortaba SIEMPRE, en el 100% de las ejecuciones.
// Medido contra SIFHA_Tickets_DEV con el diagnóstico de esta misma carpeta:
//
//   SESSIONPROPERTY('IdentityInsert')   -> NULL   (BaseType NULL)
//   SESSIONPROPERTY('IDENTITY_INSERT')  -> NULL   (BaseType NULL)
//   SESSIONPROPERTY('ANSI_NULLS')       -> 1      (control: el probe funciona)
//
// La causa está en la documentación de la propia función: `SESSIONPROPERTY`
// devuelve los SET OPTIONS de la sesión, y su lista es `ANSI_NULLS`,
// `ANSI_PADDING`, `ANSI_WARNINGS`, `ARITHABORT`, `CONCAT_NULL_YIELDS_NULL`,
// `NUMERIC_ROUNDABORT` y `QUOTED_IDENTIFIER`. Para "cualquier otro nombre" la
// documentación dice literalmente `NULL = Input is not valid`.
//
// O sea: SQL Server NO expone el estado de IDENTITY_INSERT en ninguna lectura, y
// para un nombre no válido no da error, devuelve NULL. La guarda traducía ese
// NULL a "IDENTITY_INSERT OFF" y abortaba. No estaba midiendo el estado: estaba
// midiendo su propia ignorance. Por eso los intentos 2 y 3 fallaron igual, con
// el rediseño de afinidad ya puesto: el rediseño arreglaba algo que no era el
// problema.
//
// Lo que SÍ es comprobable, y es lo que queda:
//
//   1. Que el `SET IDENTITY_INSERT ... ON` no dé error. Esa sentencia ES la
//      prueba: si faltara ALTER responde 297/1088, y si otra tabla de esta
//      sesión ya lo tuviera, responde 8108/8107 nombrándola. Los dos son errores
//      que `mssql` lanza, así que "no saltó excepción" significa "el ON se puso".
//   2. Que el `@@SPID` sea el mismo antes y después. Eso SÍ es el estado real de
//      la sesión, y es lo que demuestra que el ON y los INSERT van por la misma
//      conexión física.
//   3. Que el primer INSERT pase. Si el ON no hubiera surtido efecto, SQL Server
//      responde 544, y como la Fase 1 lleva `XACT_ABORT ON` dentro de una
//      transacción, eso deshace las 25 filas: 0 confirmadas. El fallo ya es
//      seguro por construcción, y por eso la comprobación previa no era
//      imprescindible para la seguridad: solo era una barrera que nunca dejaba
//      pasar.
//
// Lo que NO se usa, y por qué:
//
//   - El truco del error 8107 (pedir el ON de otra tabla y leer el nombre del
//     mensaje) funciona, pero necesita ALTER sobre otro objeto y muta estado de
//     sesión que no es el nuestro. Para una comprobación preventiva no compensa.
//   - Un `INSERT` de prueba con id explícito es exactamente lo que esta fase
//     tiene prohibido, y además avanza `last_value` aunque se deshaga.
//
// Las dos guards de IDENTITY_INSERT se eliminaron en lugar de sustituirlas: no
// hay otra lectura que consultar y una comprobación inventada daría una falsa
// sensación de control, que es peor que no comprobar.
// ---------------------------------------------------------------------------

function formatSessionId(sessionId) {
  const asNumber = Number(sessionId);
  return Number.isSafeInteger(asNumber) ? String(asNumber) : 'desconocida';
}

/**
 * Exige que las lecturas de `@@SPID` de dentro de la misma Transaction salgan
 * de la MISMA sesión física.
 *
 * Es la única comprobación de sesión que queda, y es una comprobación real: no
 * razona sobre el pool ni sobre el estado de `IDENTITY_INSERT`, pregunta a
 * SQL Server qué conexión está ejecutando.
 *
 * Dos `@@SPID` distintos son, por definición, dos sesiones distintas, y dos
 * sesiones tienen dos `IDENTITY_INSERT` independientes. Como el ON y los INSERT
 * van los dos por la Transaction, que por contrato usa una sola conexión
 * (`base/transaction.js:67`), esta guarda verifica ese contrato en tiempo de
 * ejecución. Si alguna vez fallara, la librería no se estaría comportando como su
 * fuente declara y eso hay que saberlo ANTES de escribir, no después.
 *
 * NO comprueba que el `IDENTITY_INSERT` esté puesto, porque eso no se puede
 * consultar en SQL Server: ver el bloque de arriba.
 */
export function assertSamePhysicalSession(expected = {}, actual = {}) {
  // `Number(null)` es 0 y `Number('')` también, así que un SPID ausente se
  // comprobaría como un número cualquiera. Se rechaza antes de convertir.
  const legible = (sessionId) => (
    sessionId !== null
    && sessionId !== undefined
    && String(sessionId).trim() !== ''
    && Number.isSafeInteger(Number(sessionId))
  );

  if (!legible(expected.sessionId) || !legible(actual.sessionId)) {
    fail(
      'No se pudo leer @@SPID para comprobar la sesión de la carga. Sin ese dato no '
      + 'se puede garantizar que el INSERT y el SET IDENTITY_INSERT van por la misma '
      + 'conexión física, y sin esa garantía la Fase 1 no escribe.'
    );
  }

  const expectedId = Number(expected.sessionId);
  const actualId = Number(actual.sessionId);

  if (expectedId !== actualId) {
    fail(
      `Dentro de la misma Transaction, una lectura devolvió SPID ${expectedId} y otra `
      + `SPID ${actualId}. Son conexiones físicas distintas, y eso no debería poder pasar: `
      + 'una Transaction de mssql usa una sola conexión desde el begin() hasta el '
      + 'commit()/rollback(). Si aparece, la librería no se comporta como su fuente '
      + `declara y no se puede garantizar que el INSERT y el SET IDENTITY_INSERT van por `
      + 'la misma sesión. No se escribe ninguna fila.'
    );
  }
  return true;
}

/**
 * Máquina de estados de B13-A, en forma pura.
 *
 * No lee nada ni escribe nada: recibe lo que se ha observado y devuelve el
 * estado. Que sea pura es lo que permite comprobar los cuatro estados en las
 * pruebas, incluido el `RECUPERACION_MANUAL` que es el estado real de DEV ahora
 * mismo (0 filas, identidad 478), sin necesitar una base de datos para
 * reproducirlo.
 *
 *   CARGA_PENDIENTE ................... 0 filas / last_value 44
 *   CARGA_CONFIRMADA_RESEED_PENDIENTE . 25 exactas / last_value 44
 *   COMPLETADO ....................... 25 exactas / last_value 480
 *   RECUPERACION_MANUAL .............. cualquier otra cosa
 *
 * Las filas tienen que COINCIDIR con el manifiesto, no solo ser 25: 25 filas
 * equivocadas no son "carga confirmada", son algo que hay que mirar.
 */
export function classifyDestinationState({ rowCount, identityLastValue, manifest, rows } = {}) {
  const asCount = Number.isSafeInteger(Number(rowCount)) && Number(rowCount) >= 0 ? Number(rowCount) : null;
  const asIdentity = Number.isSafeInteger(Number(identityLastValue)) && Number(identityLastValue) >= 0
    ? Number(identityLastValue)
    : null;

  const manual = (reason, extra = {}) => ({
    state: MIGRATION_STATES.RECUPERACION_MANUAL,
    reason,
    rowCount: asCount,
    identityLastValue: asIdentity,
    ...extra,
  });

  if (asCount === null) {
    return manual(`No se pudo leer COUNT(*) de ${MIGRATION_TARGET_OBJECT} (valor: ${String(rowCount)}).`);
  }
  if (asIdentity === null) {
    return manual(
      `No se pudo leer last_value de ${MIGRATION_TARGET_OBJECT} (valor: ${String(identityLastValue)}).`
    );
  }

  const expectedCount = Number.isSafeInteger(manifest?.rows?.length)
    ? manifest.rows.length
    : EXPECTED_DEPARTMENT_COUNT;

  if (asCount === 0) {
    if (asIdentity === EXPECTED_DESTINATION_LAST_VALUE) {
      return {
        state: MIGRATION_STATES.CARGA_PENDIENTE,
        reason: `0 filas y last_value=${EXPECTED_DESTINATION_LAST_VALUE}: la Fase 1 puede empezar.`,
        rowCount: asCount,
        identityLastValue: asIdentity,
      };
    }
    // Este es el caso REAL de DEV hoy: 0 filas pero identidad 478, que dejó el
    // INSERT explícito del probe y que el ROLLBACK no devolvió a 44.
    return manual(
      `0 filas pero last_value=${asIdentity} y se esperaba ${EXPECTED_DESTINATION_LAST_VALUE}. `
      + 'La identidad no está donde la carga da por hecho: no se escribe nada. '
      + 'Hace falta una restauración administrativa aprobada antes de la Fase 1.'
    );
  }

  if (asCount !== expectedCount) {
    return manual(
      `${MIGRATION_TARGET_OBJECT} tiene ${asCount} filas y el manifiesto tiene ${expectedCount}: `
      + 'datos parciales o inesperados. No se continúa.'
    );
  }

  // Hay 25 filas: o son las del manifiesto, o no son nada.
  const diffs = diffManifestToRows(manifest, rows);
  if (diffs.length) {
    const detalle = diffs.slice(0, 8).join('; ');
    const mas = diffs.length > 8 ? ` (+${diffs.length - 8} más)` : '';
    return manual(
      `${asCount} filas pero NO son las del manifiesto: ${detalle}${mas}. `
      + 'No se continúa y no se corrige nada desde aquí.',
      { diffs }
    );
  }

  if (asIdentity === EXPECTED_DESTINATION_LAST_VALUE) {
    return {
      state: MIGRATION_STATES.CARGA_CONFIRMADA_RESEED_PENDIENTE,
      reason: `${asCount} filas exactas y last_value=${EXPECTED_DESTINATION_LAST_VALUE}: `
        + `la carga está confirmada y el reseed a ${EXPECTED_FINAL_LAST_VALUE} está pendiente.`,
      rowCount: asCount,
      identityLastValue: asIdentity,
    };
  }

  if (asIdentity === EXPECTED_FINAL_LAST_VALUE) {
    return {
      state: MIGRATION_STATES.COMPLETADO,
      reason: `${asCount} filas exactas y last_value=${EXPECTED_FINAL_LAST_VALUE}: B13-A completado.`,
      rowCount: asCount,
      identityLastValue: asIdentity,
    };
  }

  return manual(
    `${asCount} filas exactas pero last_value=${asIdentity}, que no es ni `
    + `${EXPECTED_DESTINATION_LAST_VALUE} (carga) ni ${EXPECTED_FINAL_LAST_VALUE} (completado). `
    + 'Se requiere revisión manual.'
  );
}
