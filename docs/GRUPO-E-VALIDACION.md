# Validación del Grupo E (arranque en seco de solo lectura)

Documento de evidencia del Grupo E. Complementa a
`docs/PLAN-RECONCILIACION-DEV.md` §13.7 y a `docs/ESTADO-ENTREGA.md` §17–§18.
Fecha de esta revisión: **2026-10-14**.

## 1. Objetivo

Certificar que el backend **arranca contra SQL Server sin escribir datos**: sin
migraciones, sin seed, sin jobs y sin efectos indirectos de escritura en las
peticiones de solo lectura.

## 2. Endpoints de lectura pura (auditoría estática)

`SELECT` únicamente:

- `GET /api/health`
- `GET /api/auth/me` (anónimo)
- `GET /api/tickets`, `GET /api/tickets/:id` y subrecursos de lectura
- `GET /api/users`, `GET /api/roles`, `GET /api/roles/:id`, `GET /api/departments`
- `GET /api/settings`
- `GET /api/dashboard/*`, `GET /api/reports/*`
- `GET /api/notifications*`
- Descargas y exportaciones (CSV/XLSX/PDF)

## 3. Efectos indirectos de escritura (verificados)

«Solo GET» **no** garantiza cero escrituras. Hallazgos reales
(`docs/ESTADO-ENTREGA.md` §17.3):

1. Cada GET autenticado con cookie válida ejecuta
   `UPDATE sessions SET expire...` (sesión rodante).
2. `GET /api/kb-articles/:id` sobre artículo PUBLISHED de otro autor ejecuta
   `UPDATE kb_articles SET view_count = view_count + 1`.
3. Caso borde: `requireAuth` con cuenta/organización inactiva ejecuta
   `DELETE FROM sessions`.

Además, el arranque con `JOBS_ENABLED=true` (defecto) ejecuta `runMaintenance()`
de inmediato (UPDATE/INSERT/DELETE).

## 4. Configuración de arranque en seco (sin escrituras)

- `MSSQL_RUNTIME=true` (obligatorio para activar el motor MSSQL).
- `JOBS_ENABLED=false` (obligatorio: desactiva `runMaintenance()`).
- Peticiones limitadas a **GET anónimos** (sin cookie de sesión inicializada) y
  evitando `GET /api/kb-articles/:id`.

## 5. Evidencia ejecutada

### 5.1 Base aislada `SIFHA_Tickets_M5_Validation` — PASS

Evidencia reforzada (2026-10-14): antes/después del arranque en seco se
**contaron las filas de las 24 tablas** y no cambió ninguna.

| Comprobación | Resultado |
|---|---|
| `schemaValidator` (solo `SELECT` a catálogo) | **ok:true** — 24 tablas, 204 columnas |
| `GET /api/health` | **200** |
| `GET /api/auth/me` (anónimo) | **401** (sin escritura de sesión) |
| `GET /api/tickets`, `/api/users`, `/api/notifications` (anónimos) | **401** |
| **Tablas cuyo conteo cambió** | **0 / 24** (antes == después) |
| `sessions` antes / después | **0 / 0** |

### 5.2 `SIFHA_Tickets_DEV` — BLOQUEADO (externo)

Arranque → `PREPARE_FAIL` («falta la tabla `dbo.organizations`/…»): la cuenta
`sifha_ticket_dev` no ve las 24 tablas por **visibilidad de metadatos/permisos**
(§17.2). No se declara GO sin evidencias reales.

## 6. Cuenta de solo lectura preparada (no ejecutada)

`backend/scripts/migration/create-groupE-readonly-account.sql`:

- DRY-RUN por defecto (`@apply = 0`); idempotente; SQL dinámico con `QUOTENAME`.
- Guarda de identidad: solo `SIFHA_Tickets_DEV` en `TI-DESK-01\SIFHADEV`.
- Concede **exclusivamente `SELECT`** por tabla a la cuenta de Grupo E.
- **No** crea el LOGIN (lo hace el administrador) ni concede INSERT/UPDATE/DELETE
  ni roles globales. Opcionalmente `VIEW DEFINITION` (catalogo).
- Cobertura estática: `backend/test/dev-permissions-scripts.test.js`.

## 7. Conclusión

El objetivo de Grupo E (arranque en seco sin escrituras) está **demostrado en la
base aislada**. El cierre en `SIFHA_Tickets_DEV` queda **pendiente de una
intervención autorizada** del responsable: (a) aplicar los permisos de la cuenta
de aplicación o (b) habilitar la cuenta de solo lectura y ejecutar el arranque en
seco. Ver `docs/ESTADO-ENTREGA.md` §18.3.
