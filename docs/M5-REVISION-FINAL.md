# SIFHA Ticket — Auditoría final M5

**Fecha:** 2026-10-10  
**Rama revisada:** `trabajo-etapa3-pendiente`  
**Commit base:** `aa3bf6f fix(seed): no reponer permisos de roles personalizados`

## Resultado ejecutivo

La revisión local quedó aprobada y el código está preparado para revisión y posterior subida a GitHub. Esto no equivale a una certificación de integración MSSQL: por restricción de seguridad no se conectó ni se escribió en SQL Server real.

## Auditoría del trabajo de Nemotron

- Correcto: los JOIN de `notifyOverdueTickets()`, `escalateUnassigned()` y `alertCriticalLongOpen()` ahora exigen que reportante/asignado y ticket pertenezcan a la misma organización.
- Correcto: `AND t.organization_id IS NOT NULL` excluye tickets sin organización de escalaciones y alertas. Los requisitos y pruebas existentes establecen que un ticket sin organización no tiene destinatario seguro; además, el proceso de migración asigna los datos legacy válidos a una organización.
- Ajuste adicional: `targetUsersFor()` confiaba en `assigned_to_id` y `assigned_team_id` sin validar su organización. La defensa central impedía una fuga, pero una referencia cross-org corrupta silenciaba el SLA en vez de usar el fallback autorizado. Ahora usuario, equipo y miembros se validan contra la organización del ticket y, si no son válidos, se notifica a sus administradores.
- Descartado C3: `substr(COALESCE(...), 1, 7)` se traduce a T-SQL correctamente; la suite del dialecto lo confirma.
- Descartado C4: `sessions` y `sequences` usan `ON CONFLICT ... DO UPDATE`; el traductor deriva las claves y genera `MERGE WITH (HOLDLOCK)`. No necesitan entradas en `IGNORE_CONFLICT_COLUMNS`.
- Inexactitudes del informe anterior: `docs/M5-REVISION-FINAL.md` también era un archivo nuevo sin rastrear; las diez suites MSSQL contienen 112 pruebas, no 91; `jobs-org-isolation.test.js` sí es reproducible de forma aislada y no falló en esta auditoría.

## Correcciones realizadas

| Archivo | Cambio |
|---|---|
| `backend/src/utils/jobs.js` | Conserva los filtros organizacionales de Nemotron y valida el asignado/equipo antes de elegir destinatarios SLA. |
| `backend/test/jobs-org-isolation.test.js` | Añade regresión para asignaciones cross-org corruptas por usuario y equipo. |
| `docs/M5-REVISION-FINAL.md` | Sustituye afirmaciones no verificadas por resultados reproducidos. |

## Pruebas verificadas

### MSSQL estáticas/unitarias, sin servidor real

Se ejecutaron las diez suites solicitadas mediante `node --test` y el setup temporal SQLite. Antes se comprobó que usan mocks, análisis estático o procesos controlados y no escriben en MSSQL.

- Pruebas: **112**
- Aprobadas: **112**
- Fallidas: **0**
- Omitidas: **0**
- Suites reportadas por Node: **20**
- Duración: **23.55 s**

Cobertura comprobada: parámetros, traducción SQLite→T-SQL, `JSON_VALUE`, `COALESCE`/`substr`, `INSERT OR IGNORE`, `ON CONFLICT`, `MERGE WITH (HOLDLOCK)`, transacciones, contrato MSSQL, esquema, arranque simulado, dashboard, notificaciones multiempresa, paridad de migración y scripts M5.

### Integración SQLite seleccionada

Selección explícita de autenticación, tickets, workflow, permisos, aislamiento organizacional, dashboard, reportes, configuración, notificaciones, jobs y escalaciones:

- Pruebas: **283**
- Aprobadas: **283**
- Fallidas: **0**
- Omitidas: **0**
- Suites: **39**
- Duración: **56.16 s**

### Suite completa local

Se ejecutó dos veces. La primera, antes de la regresión nueva, obtuvo 856 pruebas: 854 aprobadas, 0 fallidas y 2 omitidas en 123.04 s. La segunda, con el cambio final, obtuvo:

- Pruebas: **857**
- Aprobadas: **855**
- Fallidas: **0**
- Omitidas: **2**
- Suites: **142**
- Duración: **124.84 s**

Las dos omisiones son las omisiones declaradas por la suite; no se ocultaron ni desactivaron pruebas para esta revisión.

### `jobs-org-isolation.test.js`

El fallo informado `UNIQUE constraint failed: organizations.code` no se reprodujo. El archivo usa un `before` único y el setup crea y elimina una base SQLite temporal por proceso; no contiene `beforeEach`, `afterEach` ni `after` que reutilicen fixtures. Resultados:

- Dos ejecuciones consecutivas del estado inicial: **9/9** y **9/9**.
- Tras la regresión añadida: **10/10** en **4.31 s**.
- También pasó dentro de ambas ejecuciones completas.

Conclusión: no hay evidencia para atribuir el fallo a un defecto actual ni para afirmar como causa comprobada que la base temporal no se limpiaba. La causa histórica exacta no puede determinarse sin el comando y entorno originales; es compatible con una ejecución antigua sobre una base persistente o fixtures duplicados, pero eso queda como hipótesis, no como hecho.

## Seguridad multiempresa y legacy

- Los tickets con organización solo consultan reportantes, asignados, equipos, miembros, reglas y administradores de esa organización.
- Las referencias cross-org corruptas no reciben notificaciones y ya no silencian el fallback SLA autorizado.
- Los tickets con `organization_id NULL` no generan notificaciones, alertas ni escalaciones: no existe una organización segura a la cual dirigirlas.
- Los datos legacy válidos deben ser asignados a la organización legacy por el flujo de migración/backfill; las pruebas de migración y aislamiento de la suite completa pasan.
- Los JOIN internos pueden excluir registros corruptos o sin organización, de forma deliberada para impedir exposición de identidad. No excluyen tickets válidos cuyos usuarios pertenecen a la misma organización.

## Compatibilidad MSSQL

Validado localmente mediante pruebas, mocks y análisis estático: traducción a T-SQL, parámetros, transacciones, `MERGE WITH (HOLDLOCK)`, upserts, JSON, fechas, esquema multiempresa, arranque sin migración y aislamiento de notificaciones. La consulta nueva de `jobs.js` también pasó el escáner de SQL estática.

Pendiente de certificación real: concurrencia y planes de ejecución en SQL Server, sesión/login HTTP contra MSSQL, y ejecución de `runMaintenance()` contra un staging desechable. No se ejecutaron porque el alcance prohíbe escribir o lanzar suites HTTP/jobs contra el MSSQL compartido.

## Validaciones finales

- `node --check` en el código y la prueba modificados: aprobado.
- Build frontend Vite: aprobado, 138 módulos, 3.42 s.
- Lint: no existe script de lint en los `package.json`.
- `git diff --check`: aprobado.
- Revisión del diff: no se añadieron credenciales ni secretos.
- No se ejecutaron migraciones, no se reiniciaron contenedores y no se hicieron `git add`, commit, push ni cambio de rama.

## Estado Git y propuesta de commit

Rama: `trabajo-etapa3-pendiente`.

Archivos pendientes:

```text
M  backend/src/utils/jobs.js
M  backend/test/jobs-org-isolation.test.js
?? docs/M5-REVISION-FINAL.md
```

El build generó artefactos ignorados y no añadió archivos al estado Git.

Propuesta de mensaje:

```text
fix(jobs): refuerza aislamiento multiempresa en alertas M5
```

## Pendientes para cerrar M5

No queda un fallo local que impida la revisión o subida del código. Para declarar M5 certificado sobre MSSQL todavía hace falta ejecutar, en un entorno MSSQL desechable o de staging autorizado, las pruebas de integración HTTP, concurrencia y jobs que deliberadamente no se ejecutaron aquí.
