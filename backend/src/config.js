import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function bool(v, fallback = false) {
  if (v === undefined || v === null || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function int(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function requestedDbClient(v) {
  const client = String(v || 'sqlite').trim().toLowerCase();
  if (!['sqlite', 'mssql'].includes(client)) {
    throw new Error(`DB_CLIENT no soportado: "${client}". Se admite "sqlite" o "mssql".`);
  }
  return client;
}

// Motor que pide el entorno (lo consumen los scripts de migración y la
// validación de arranque). `DB_CLIENT=mssql` NO implica por sí solo que el
// proceso vaya a hablar con SQL Server: eso lo decide `dbClient`.
export function mssqlRuntimeRequested(env = process.env) {
  return requestedDbClient(env.DB_CLIENT) === 'mssql';
}

// Activación explícita del runtime MSSQL. Sin `MSSQL_RUNTIME=true` el proceso
// sigue sobre SQLite aunque `DB_CLIENT=mssql`, porque la migración por fases aún
// no ha convertido todos los módulos ni se ha aplicado el esquema MSSQL. Es la
// puerta que la fase de cutover abrirá cuando el runtime esté completo.
export function mssqlRuntimeActivated(env = process.env) {
  return bool(env.MSSQL_RUNTIME, false);
}

// Motor real de ejecución. Solo devuelve 'mssql' cuando además de pedirlo se ha
// activado explícitamente; en cualquier otro caso el runtime usa SQLite, que es
// donde vive la única fuente de verdad mientras no se complete el cutover. Un
// valor inválido de DB_CLIENT detiene el arranque en el import de la
// configuración, antes de abrir ninguna conexión.
export function dbClient(v, env = process.env) {
  const requested = requestedDbClient(v);
  if (requested === 'mssql' && !mssqlRuntimeActivated(env)) return 'sqlite';
  return requested;
}

// Mantenimiento programado (SLA vencido, escalaciones automáticas y poda de
// notificaciones). Activo por defecto. `JOBS_ENABLED=false` lo desactiva por
// completo, lo que permite una prueba de arranque contra SQL Server que NO
// escriba en la base al iniciarse (el job inicial se ejecuta nada más arrancar).
export function jobsEnabled(env = process.env) {
  return bool(env.JOBS_ENABLED, true);
}

const rootDir = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Validación de arranque.
//
// En producción el proceso tiene que NEGARSE a arrancar con una configuración
// incompleta. Antes solo se comprobaba que SESSION_SECRET existiera, y tanto
// ese como el resto de credenciales tenían valores por defecto escritos en el
// repositorio: un despliegue que olvidara una variable arrancaba igual, pero
// con secretos públicos y, en el seed, con cuentas de contraseña conocida.
//
// Estas reglas son puras (reciben un entorno, devuelven textos) para poder
// probarlas sin arrancar nada.
// ---------------------------------------------------------------------------

// 32 bytes aleatorios son 256 bits de entropía. Por debajo, un secreto
// adivinable o reutilizado de otro entorno acaba firmando cookies ajenas.
export const MIN_SESSION_SECRET_LENGTH = 32;

// El administrador es la primera credencial que existe en una instalación
// nueva, así que su contraseña tiene que ser larga de verdad.
export const MIN_ADMIN_PASSWORD_LENGTH = 12;

// Solo para desarrollo y pruebas. Es público: vive en el repositorio y en el
// compose de desarrollo, así que en producción se rechaza siempre.
export const DEV_SESSION_SECRET = 'ticket-dev-secret-change-me';

const KNOWN_SECRETS = new Set([
  DEV_SESSION_SECRET,
  'desarrollo-local-ticket',
  'cambie-este-secreto-en-produccion-1234567890',
]);

// Marcas de un valor de ejemplo copiado de un .env.example o de la
// documentación. Un secreto generado al azar no contiene ninguna.
const PLACEHOLDER_MARKS = [
  'cambie', 'cambiar', 'change-me', 'changeme', 'change',
  'pon-aqui', 'pon aqui', 'ponaqui', 'placeholder', 'example', 'ejemplo',
  'su-cadena', 'su-cadena-secreta', 'tusecreto', 'tu-secreto',
  'xxxxxxxx', 'aaaaaaaa',
];

export const GENERATE_SECRET_HINT =
  'Genere uno con: node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'base64url\'))"';

function truthy(v) {
  return bool(v, false);
}

function isPlaceholder(value) {
  const v = String(value).toLowerCase();
  if (KNOWN_SECRETS.has(v)) return true;
  if (PLACEHOLDER_MARKS.some((mark) => v.includes(mark))) return true;
  // 'abcabcabc...' o 'aaaaaaaa...': un patrón corto repetido no es aleatorio.
  return /^(.{1,8}?)\1{2,}$/.test(v);
}

export function checkSessionSecret(value) {
  const secret = (value || '').trim();
  if (!secret) {
    return `SESSION_SECRET no está definido. Defínalo con un valor aleatorio. ${GENERATE_SECRET_HINT}`;
  }
  // Antes que la longitud: decir "es el secreto de desarrollo, que es público"
  // es más útil que "mide 27 caracteres".
  if (isPlaceholder(secret)) {
    return `SESSION_SECRET parece un valor de ejemplo (está en el repositorio o copiado de la documentación). ${GENERATE_SECRET_HINT}`;
  }
  if (secret.length < MIN_SESSION_SECRET_LENGTH) {
    return `SESSION_SECRET tiene ${secret.length} caracteres y se exigen ${MIN_SESSION_SECRET_LENGTH}. ${GENERATE_SECRET_HINT}`;
  }
  return null;
}

export function checkAdminPassword(value) {
  const pwd = (value || '').trim();
  // No querer crear el administrador no es un error: la cuenta puede existir
  // ya, o querer crearla a mano.
  if (!pwd) return null;
  if (pwd.length < MIN_ADMIN_PASSWORD_LENGTH) {
    return `SEED_ADMIN_PASSWORD tiene ${pwd.length} caracteres y se exigen ${MIN_ADMIN_PASSWORD_LENGTH}.`;
  }
  if (isPlaceholder(pwd)) {
    return 'SEED_ADMIN_PASSWORD parece un valor de ejemplo copiado de la documentación.';
  }
  return null;
}

function isLocalUrl(value) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?/i.test(String(value || '').trim());
}

export function collectStartupProblems(env = process.env) {
  const errors = [];
  const warnings = [];

  // Desarrollo y pruebas arrancan con lo mínimo. Solo producción es la barrera.
  if ((env.NODE_ENV || 'development') !== 'production') return { errors, warnings };

  const secretProblem = checkSessionSecret(env.SESSION_SECRET);
  if (secretProblem) errors.push(secretProblem);

  const adminProblem = checkAdminPassword(env.SEED_ADMIN_PASSWORD);
  if (adminProblem) errors.push(adminProblem);

  if (truthy(env.SEED_DEMO_ACCOUNTS)) {
    errors.push(
      'SEED_DEMO_ACCOUNTS=true no se permite en producción: las cuentas de demostración '
      + 'se crean con contraseñas conocidas.'
    );
  }

  const publicUrl = (env.PUBLIC_URL || '').trim();
  if (!publicUrl) {
    errors.push(
      'PUBLIC_URL no está definido. Los enlaces de las notificaciones, incluido el de '
      + 'restablecer contraseña, se construyen con un origen por defecto y no llegan a nadie.'
    );
  } else if (!/^https?:\/\/\S+$/i.test(publicUrl)) {
    errors.push(`PUBLIC_URL no es una URL válida: "${publicUrl}".`);
  } else if (isLocalUrl(publicUrl)) {
    warnings.push(`PUBLIC_URL apunta a ${publicUrl}: los enlaces salientes se quedan en esta máquina.`);
  }

  if (isLocalUrl(env.CORS_ORIGIN)) {
    warnings.push(
      `CORS_ORIGIN apunta a ${env.CORS_ORIGIN}: en producción debería ser el origen real del frontend.`
    );
  }

  if (!truthy(env.COOKIE_SECURE)) {
    warnings.push(
      'COOKIE_SECURE no está activo: la cookie de sesión también viajará sin cifrar. '
      + 'Actívelo en cuanto haya TLS delante (deploy/https/compose.https.yml lo hace por usted).'
    );
  }

  return { errors, warnings };
}

export function assertStartupConfig(env = process.env) {
  const { errors, warnings } = collectStartupProblems(env);
  for (const w of warnings) console.warn(`[config] AVISO: ${w}`);
  if (errors.length) {
    throw new Error(
      'Configuración de producción incompleta o insegura; el proceso no arranca.\n'
      + errors.map((e) => `  - ${e}`).join('\n')
    );
  }
  return true;
}

const config = {
  env: process.env.NODE_ENV || 'development',
  port: int(process.env.PORT, 4000),
  // Motor de ejecución: `sqlite` (node:sqlite, por defecto) o `mssql` (pool de
  // SQL Server, solo con MSSQL_RUNTIME=true). La traducción de dialecto vive en
  // src/db/dialect.js y el cambio de motor en src/db/runtime.js.
  requestedDbClient: requestedDbClient(process.env.DB_CLIENT),
  dbClient: dbClient(process.env.DB_CLIENT, process.env),
  mssqlRuntimeEnabled: dbClient(process.env.DB_CLIENT, process.env) === 'mssql',
  mssql: {
    server: (process.env.DB_SERVER || '').trim(),
    port: process.env.DB_PORT ? int(process.env.DB_PORT, 1433) : undefined,
    database: (process.env.DB_DATABASE || '').trim(),
    user: (process.env.DB_USER || '').trim(),
    password: process.env.DB_PASSWORD || '',
    options: {
      encrypt: bool(process.env.DB_ENCRYPT, true),
      trustServerCertificate: bool(process.env.DB_TRUST_SERVER_CERTIFICATE, false),
      useUTC: true,
      instanceName: (process.env.DB_INSTANCE || '').trim() || undefined,
    },
  },
  dataDir: path.resolve(rootDir, process.env.DATA_DIR || 'data'),
  uploadDir: path.resolve(rootDir, process.env.UPLOAD_DIR || 'uploads'),
  dbFile: process.env.DB_FILE || null,

  publicDir: process.env.PUBLIC_DIR
    ? path.resolve(rootDir, '..', process.env.PUBLIC_DIR)
    : path.resolve(rootDir, '..', 'frontend', 'dist'),

  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',

  // URL pública con la que se construyen enlaces absolutos (ej. reset de contraseña).
  // Sin PUBLIC_URL se toma el origen del frontend, que es quien sirve /reset-password
  // (CORS_ORIGIN apunta a él y por defecto es el servidor de desarrollo). Caer aquí
  // en el puerto de la API generaba enlaces de recuperación inservibles.
  publicUrl: (
    process.env.PUBLIC_URL
    || (process.env.CORS_ORIGIN || 'http://localhost:5173').split(',')[0].trim()
  ).replace(/\/+$/, ''),

  session: {
    secret: process.env.SESSION_SECRET || 'ticket-dev-secret-change-me',
    secure: bool(process.env.COOKIE_SECURE, false),
    maxAge: 60 * 60 * 1000,
    rememberMaxAge: 30 * 24 * 60 * 60 * 1000,
  },

  // Rutas de transporte. `trustProxy` se aplica a Express tal cual; vacío o
  // 'false' significa no confiar en ninguna cabecera de proxy (comportamiento
  // actual). Ver src/transportSecurity.js.
  trustProxy: process.env.TRUST_PROXY || '',
  // Hosts públicos que deben recibir HSTS, separados por comas.
  publicHosts: process.env.PUBLIC_HOSTS || '',

  uploads: {
    maxSizeMb: int(process.env.MAX_UPLOAD_SIZE_MB, 5),
    maxFilesPerTicket: int(process.env.MAX_FILES_PER_TICKET, 5),
  },

  // Directorio de usuarios y departamentos (backend/directory.json).
  //
  // El archivo guarda el PERFIL de las cuentas (nombre, correo, departamento,
  // puesto, rol, activo) y nunca sus contraseñas: un fichero que se versiona o
  // se comparte no debe llevar hashes dentro.
  //
  //   DIRECTORY_SYNC=false            -> no se sincroniza nada.
  //   DIRECTORY_SNAPSHOT_FILE=<ruta>  -> otro fichero (por defecto directory.json,
  //                                      junto al backend).
  directory: {
    snapshotFile: process.env.DIRECTORY_SNAPSHOT_FILE || 'directory.json',
    sync: bool(process.env.DIRECTORY_SYNC, true),
  },

  // Notificaciones por correo. Con MAIL_ENABLED=false (o SMTP sin configurar)
  // los correos se registran en consola y en la tabla email_logs (modo dev).
  mail: {
    enabled: bool(process.env.MAIL_ENABLED, false),
    transport: process.env.MAIL_TRANSPORT || 'auto',
    host: process.env.SMTP_HOST || '',
    port: int(process.env.SMTP_PORT, 587),
    secure: bool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || process.env.SMTP_USER || 'tickets@localhost',
    fromName: process.env.SMTP_FROM_NAME || 'Ticket',
  },
};

config.dbFile =
  config.dbFile && config.dbFile !== 'false'
    ? path.resolve(rootDir, config.dbFile)
    : path.join(config.dataDir, 'tickets.db');

config.directory.snapshotFile = path.resolve(rootDir, config.directory.snapshotFile);

// La configuración de producción se valida al IMPORTAR este módulo, que es el
// primer punto de entrada de todos los procesos (server, scripts de migración
// y de seed). Ocurre antes de crear directorios, migrar o insertar usuarios, de
// modo que una instalación incompleta para aquí en vez de arrancar con secretos
// conocidos del repositorio.
if (config.env === 'production') assertStartupConfig(process.env);

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.uploadDir, { recursive: true });

export default config;
