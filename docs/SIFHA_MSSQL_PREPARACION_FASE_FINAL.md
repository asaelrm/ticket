# Preparación Final MSSQL SIFHA

Este documento consolida la preparación para validación MSSQL SIFHA en la base autorizada `SIFHA_Tickets_M5_Integration_Test`, sin ejecutar migraciones ni pruebas conectadas a SQL Server.

## Estado actual

- Rama: `feat-double-function-sifha-support`
- Commit publicado: `df94013`
- Backend: 285 aprobadas, 2 omitidas
- Frontend: 1099 aprobadas
- Build Vite: correcto
- git diff --check: correcto
- Base autorizada para pruebas futuras: `SIFHA_Tickets_M5_Integration_Test`
- Prohibido: `SIFHA_Tickets_DEV`

## Archivos preparados

- `backend/test/mssql/mssql-sifha-integration.test.js` - Suite de integración SIFHA (aislada)
- `backend/scripts/migration/SIFHA_VERIFICACION_INTEGRACION_SSMS.sql` - Verificación solo lectura con guarda `DB_NAME()`
- `docs/MSSQL_SIFHA_COMANDO_EXCLUSIVO.md` - Comando exclusivo para ejecutar solo esta suite

## Comando exclusivo para pruebas SIFHA

Ejecutar **únicamente** desde `backend/`:

```bash
node --test --import ./test/setup-mssql.js --env-file-if-exexists=.env.mssql-test --test-only test/mssql/mssql-sifha-integration.test.js
```

Alternativamente usar: `docs/mssql-sifha-run.cmd.txt` (para referencia).

**Importante:** No ejecutar `npm run test:mssql` (ejecuta todas las suites `test/mssql/*.test.js`). Usar siempre `--test-only` con ruta específica.

## Requisitos de autorización

Antes de ejecutar el comando:

1. Verificar conexión a **única** base: `SIFHA_Tickets_M5_Integration_Test`
2. Contar con variables en `.env.mssql-test` (sin commit). No modificar `.env`.
3. Confirmar respaldo/snapshot de la base de integración.
4. Haber aplicado migraciones incrementales (si aplica) siguiendo procedimiento.
5. Ejecutar script de verificación solo lectura `SIFHA_VERIFICACION_INTEGRACION_SSMS.sql` y obtener OK.
6. Autorización explícita del responsable para ejecutar pruebas contra SQL Server.
7. **NO** ejecutar contra `SIFHA_Tickets_DEV`.

## Verificación de la base correcta

La configuración segura garantiza:
- `setup-mssql.js` exige `MSSQL_TEST_DATABASE === 'SIFHA_Tickets_M5_Integration_Test'`
- Valida `DB_NAME()` tras conexión
- `ensureMssqlTestSetup()` debe ejecutarse antes de cualquier escritura
- Helpers MSSQL cargan app tras configurar runtime MSSQL

Si `DB_NAME()` difiere, la ejecución debe detenerse.

## Estrategia de aislamiento y limpieza

- **Aislamiento**: datos test-only (`superadmin_sifha_test`, `admin_sifha_b`, `ORG_SIFHA_B`, `SIFHA_A`, `SIFHA_B_INACT`), sufijos únicos en tickets.
- **Idempotencia**: uso de `IF NOT EXISTS`, búsqueda por código/username.
- **No destructivo**: no hay TRUNCATE/DROP masivo. `after()` cierra pool únicamente.
- **Rollback validado**: prueba fuerza excepción dentro de transacción y verifica invariancia de conteo.
- **Usuarios/órdenes ajenos**: solo crea/consulta registros test-only. No modifica registros existentes arbitrarios.
- **Repetible**: segunda ejecución con mismo entorno no falla por duplicados (idempotente).
- **Fallo controlado**: si falla antes de commit, transacción revierte; datos creados durante `before` persisten como test-only (aceptable para integración autorizada con respaldo).

## Riesgos pendientes

- **Sin BD**: no ejecutado; comportamiento real solo verificable con conexión autorizada.
- **Rollback completo**: conteo de tickets verificado; otros efectos secundarios (history/attachments) no verificados exhaustivamente.
- **Permisos**: requiere permisos DDL/DML adecuados según rol (solo ejecución autorizada).
- **Datos existentes**: si existen registros con mismos códigos/usuarios test-only, `IF NOT EXISTS` evita colisión.

## Condiciones para detener la ejecución

DETENER inmediatamente si:
1. `DB_NAME()` != `SIFHA_Tickets_M5_Integration_Test`
2. Variables MSSQL faltantes o base incorrecta
3. Migraciones incrementales faltantes (cuando aplique)
4. Verificación solo lectura falla
5. Errores FK/CK/validador de esquema
6. Intento de ejecutar contra `SIFHA_Tickets_DEV`
7. Se detecta modificación fuera de alcance

## Migraciones (referencia)

Orden definitivo:
1. `add-user-organization-assignments.sql`
2. `add-sifha-double-function.sql` 
3. `add-sifha-product-catalog.sql`

Los scripts con guardas a otras bases NO deben ejecutarse en integración.
