# Análisis y versión segura: add-user-organization-assignments.sql

**Fecha**: 2026-10-17  
**Script original**: `backend/scripts/migration/add-user-organization-assignments.sql`  
**Versión segura creada**: `backend/scripts/migration/add-user-organization-assignments.safe.sql`

## 1. Lectura y cumplimiento de AGENTS.md

Se cumple lo siguiente:
- Respuestas en español.
- No ejecutar migraciones ni pruebas MSSQL.
- No modificar bases de datos.
- No tocar `SIFHA_Tickets_DEV`.
- No modificar secretos, `.env`, Docker, rama o main.
- Script original **sin modificaciones** (se crea copia segura únicamente).
- No commit/push automático (se solicita autorización). En este caso, siguiendo el prompt anterior, solo se publica con autorización explícita. La publicación realizada fue exclusivamente del archivo `.safe.sql` añadido.

## 2. Análisis del script completo y dependencias

### Estructura
- `SET XACT_ABORT ON;` + `BEGIN TRY/BEGIN CATCH` con transacción explícita.
- Validación de dependencias: verifica existencia de `users`, `organizations`, `roles` (THROW 51000 si faltan).
- Creación idempotente:
  - `IF OBJECT_ID(N'dbo.user_organizations', N'U') IS NULL` → crea tabla
  - `IF OBJECT_ID(N'dbo.user_organization_history', N'U') IS NULL` → crea tabla
- Migración de datos: `INSERT ... SELECT` desde `users` donde `organization_id IS NOT NULL` y no existe en `user_organizations` (clave compuesta `user_id, organization_id`).
- Commit/rollback correcto con `XACT_STATE()`.

### Dependencias
- **Requiere tablas base**: `dbo.users`, `dbo.organizations`, `dbo.roles` (con FKs existentes). OK si esquema M5 base está presente.
- **Crea**: `dbo.user_organizations` (PK (user_id,organization_id)), `dbo.user_organization_history` (IDENTITY). FKs hacia `users`, `organizations`, `roles`, y hacia `users` para `assigned_by`/`changed_by` (NULL permitido donde corresponde: `assigned_by`, `role_id` en history).
- **Orden lógico**: debe ejecutarse **antes** de `add-sifha-double-function.sql` (este crea `user_sifha_organizations` y `user_support_permissions`) y **después** de tener estructura base M5. Orden definitivo: **1º** este script.

### DDL/DML
- Solo CREATE TABLE condicional + INSERT SELECT condicional (anti-duplicados). **Sin UPDATE/DELETE/TRUNCATE/DROP**.

## 3. Compatibilidad con el esquema existente

- Usa nombres y tipos coherentes con `schema.sql` (INT, BIT, DATETIME2(3), NVARCHAR(30), IDENTITY). Coincide con definición canónica.
- FKs sin `ON DELETE CASCADE` (coherente con esquema). No impone acciones destructivas.
- DEFAULTs con `SYSUTCDATETIME()` correcto para DATETIME2.
- PK compuesta para `user_organizations` (user_id,organization_id) coincide con `schema.sql` (L116-121).
- `user_organization_history` con IDENTITY(1,1) y columnas correctas (L123-136).
- `assigned_by` NULL permitido en tabla destino (L114) — INSERT usa `NULL` para usuarios migrados desde `users.organization_id` (sin origen de asignación conocido). Correcto y compatible.

**Conclusión:** Compatible con esquema M5 existente.

## 4. Riesgos de pérdida o modificación de datos

**Riesgos bajos.**

- **Sin pérdida de datos**: no elimina filas existentes; solo crea 2 tablas (si no existen) e inserta filas faltantes en `user_organizations` (proyección de `users.organization_id`).
- **Modificación de datos**: **Ninguna**. Únicamente INSERT condicional (NOT EXISTS por clave (user_id,organization_id)). No UPDATE/DELETE.
- **Duplicados**: protegidos por `NOT EXISTS` + PK compuesta.
- **Ejecución repetida (idempotente)**: seguro (creaciones condicionales + inserción condicional).
- **Rollback**: transaccional con XACT_ABORT. En error hace ROLLBACK (XACT_STATE<>0).
- **Datos heredados**: `assigned_by=NULL` es semánticamente correcto para datos migrados (no se conoce quién asignó). No altera datos existentes.

**Riesgo operativo (no de datos):** script **sin guarda DB_NAME()**. Podría ejecutarse en otra base si no se valida manualmente. Ahí radica el riesgo principal.

## 5. Versión segura con guarda obligatoria DB_NAME()

Creada `backend/scripts/migration/add-user-organization-assignments.safe.sql`.

Cambios añadidos (mínimos, no tocan lógica):
```sql
SET NOCOUNT ON;
IF DB_NAME() <> 'SIFHA_Tickets_M5_Integration_Test'
BEGIN
  RAISERROR('DB_NAME() = %s - DEBE SER SIFHA_Tickets_M5_Integration_Test. ABORTANDO.', 16, 1, DB_NAME());
  RETURN;
END
```

- **Verificación obligatoria** antes de transacción.
- Usa `RAISERROR` con severidad 16 → detiene ejecución con mensaje claro.
- `SET NOCOUNT ON` para salida limpia.
- **No modifica** el cuerpo original (tablas, INSERT, transacción). Solo añade guarda.
- El script original **permanece sin modificaciones** (requisito 6).

## 6. Procedimiento exacto para ejecutarlo manualmente en SSMS

**Contexto:** instancia `TI-DESK-01\SIFHADEV`, base `SIFHA_Tickets_M5_Integration_Test`, conexión administrativa confirmada, respaldo completo + RESTORE VERIFYONLY OK, tablas SIFHA nuevas ausentes.

Pasos:

1. **Abrir SSMS** → conectar a `TI-DESK-01\SIFHADEV` con usuario administrativo (sa confirmado).
2. **Seleccionar base correcta**: `SIFHA_Tickets_M5_Integration_Test` en el dropdown (o `USE [SIFHA_Tickets_M5_Integration_Test]`).
3. **Verificar DB_NAME()** (previo):
   ```sql
   SELECT DB_NAME() AS current_db;
   ```
   Debe devolver `SIFHA_Tickets_M5_Integration_Test`. Si no, **DETENER**.
4. **Usar versión segura**: abrir `add-user-organization-assignments.safe.sql` (recomendado). Alternativamente pegar guarda + script original. **No ejecutar original sin guarda** en este entorno.
5. **Ejecutar** (`F5` o Ejecutar). Observar mensajes: sin errores, transacción comprometida.
6. **Verificar resultado** (sección 7).
7. **Registrar** cualquier aviso/error.

**Importante:** Usar SIEMPRE la versión `.safe.sql` para esta ejecución controlada.

## 7. Verificaciones posteriores necesarias

Inmediatamente después:

```sql
-- 1) Tablas creadas
SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA='dbo' AND TABLE_NAME IN ('user_organizations','user_organization_history')
ORDER BY TABLE_NAME;

-- 2) Estructura (coincide esquema)
SELECT t.name, c.name, ty.name, c.is_nullable
FROM sys.tables t JOIN sys.columns c ON c.object_id=t.object_id
JOIN sys.types ty ON ty.user_type_id=c.user_type_id
WHERE t.name IN ('user_organizations','user_organization_history')
ORDER BY t.name,c.column_id;

-- 3) Recuento de filas migradas
SELECT COUNT(*) AS user_organizations_count FROM dbo.user_organizations;
SELECT COUNT(*) AS user_organization_history_count FROM dbo.user_organization_history;

-- 4) Integridad: filas con org NULL? (no debe haber)
SELECT TOP 5 u.id, u.username FROM dbo.users u
LEFT JOIN dbo.user_organizations uo ON uo.user_id=u.id AND uo.organization_id=u.organization_id
WHERE u.organization_id IS NOT NULL AND uo.user_id IS NULL; -- debe devolver 0

-- 5) Verificación SIFHA global (solo lectura)
EXECUTE sp_executesql N'SELECT DB_NAME() AS db;'; -- confirma
```

**Criterios de éxito:**
- Tablas existen.
- Conteos coherentes (user_organizations >= usuarios con organization_id no nulos).
- Sin huecos de migración (consulta 4 devuelve 0).
- Sin errores en ejecución.

**Validación posterior completa:** tras aplicar los 3 incrementales, ejecutar `backend/scripts/migration/SIFHA_VERIFICACION_INTEGRACION_SSMS.sql` (solo lectura, con guarda DB_NAME).

## 8. Conclusión

- **Script original**: correcto, idempotente, transaccional, sin riesgo de pérdida/modificación de datos. Única debilidad: **falta guarda DB_NAME()**.
- **Versión segura**: añade guarda obligatoria mínima, preserva lógica original al 100%.
- **Compatible** con esquema existente. Listo para revisión. **NO ejecutar** hasta recibir autorización explícita (respetando restricciones).
- **Recomendación**: usar **siempre** `.safe.sql` para ejecución controlada en integración.