import runtime, { currentEngine } from '../db/runtime.js';
import { validateMssqlSchema, describeSchemaFailures } from '../db/mssql/schemaValidator.js';

// SQL Server es el único motor. El esquema de SQL Server NO se aplica desde la
// aplicación: el DDL se ejecuta fuera de línea (migración de cutover). Este
// comando se limita a validar, de forma NO destructiva (solo SELECT sobre
// catálogo del sistema), que el esquema instalado es el que la aplicación
// espera. No ejecuta migraciones, DDL, seed ni operaciones destructivas.
if (currentEngine() !== 'mssql') {
  throw new Error('Motor no soportado: SQL Server es el único motor.');
}

const schema = await validateMssqlSchema(runtime);
if (!schema.ok) {
  console.error(describeSchemaFailures(schema));
  process.exitCode = 1;
} else {
  console.log(
    `Esquema SQL Server verificado (solo lectura): ${schema.counts.tables} tablas y `
      + `${schema.counts.requiredColumns} columnas. No se aplicó ningún DDL.`,
  );
}
