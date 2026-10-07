# M4 — migrador SQLite → MSSQL

El código se encuentra en `scripts/migrate-sqlite-to-mssql.js`. Es un migrador de una sola dirección: abre SQLite en `readOnly`, transforma en memoria y solo escribe MSSQL con `--apply`. No está conectado al runtime.

## Inventario y mapeo

SQLite y MSSQL tienen las mismas 24 tablas: `organizations`, RBAC (`roles`, `permissions`, `role_permissions`), catálogos (`departments`, `categories`), `users`, equipos, tickets y sus hijos, settings, logs/notificaciones y KB. El mapa es 1:1 por nombre y columna cuando existe. `organization_id` es **DERIVED** en hijos SQLite que no la tenían (desde el padre validado); es **REQUIRES_DECISION** si falta. Banderas son **TRANSFORM** a BIT; timestamps ISO con offset son **TRANSFORM** a UTC `DATETIME2(3)`; defaults MSSQL son **DEFAULT** solo para columnas ausentes. `sessions` es **SKIP / REQUIRES_DECISION**: se recomienda invalidarlas en cutover. No se migran archivos: `ticket_attachments` migra solo metadata y el corte debe comparar `stored_name` con uploads.

Las diferencias relevantes son que MSSQL exige organización para datos tenant, usa FKs compuestas `(organization_id,id)`, unicidad de catálogo por organización, y `email_logs.organization_id` queda nullable con FK `NO ACTION`. Password hashes se insertan sin cambiarse; tokens no se muestran en manifest/logs y la política de tokens debe aprobarse antes de APPLY.

## Seguridad y operación

`--dry-run` no abre MSSQL: cuenta, transforma y ejecuta prechecks de huérfanos, duplicados, booleanos, fechas y organizaciones. `--apply` exige `DB_CLIENT=mssql`, `DB_INSTANCE=SIFHADEV`, `MIGRATION_TARGET_DATABASE` idéntica a `DB_DATABASE`, y rechaza HPWJA, ZZZSQL, bases de sistema y `SIFHA_Tickets_DEV`. El destino debe estar vacío. No hay truncate, merge ni resume.

APPLY usa una transacción única, preserva IDs con `IDENTITY_INSERT`, intenta rollback ante fallo y requiere ejecución desde cero. La función de reconciliación calcula `ticket_number:<organization_id>` desde el máximo del número de ticket (no confía ciegamente en la secuencia legacy); su escritura debe hacerse dentro de esa misma transacción antes de aprobar M5. La reconciliación compara conteos, FKs, duplicados, NULL, aislamiento y settings. Los checksums permitidos excluyen secretos y cubren catálogos y metadatos de tickets.

## Decisiones humanas pendientes

1. Mapa explícito por código estable para cualquier legacy sin organización (nunca ID 1).
2. Política definitiva de reset/session tokens y de sesiones (recomendación: invalidación).
3. Validación y copia separada de archivos de adjuntos.
4. Autorización futura para una base destino vacía; M4 no ejecuta APPLY.
