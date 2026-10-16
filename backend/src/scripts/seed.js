import { seed } from '../seed.js';

// Aprovisionamiento explícito de datos base (roles, permisos, organización
// inicial, categorías, departamentos y cuentas opcionales) sobre SQL Server.
// NO se ejecuta ninguna migración de esquema: el DDL se aplica fuera de línea.
const summary = await seed();
console.log('Seed completado:', JSON.stringify(summary));
