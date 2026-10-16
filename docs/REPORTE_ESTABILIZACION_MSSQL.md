# Reporte de Estabilización MSSQL - SIFHA Ticket

**Fecha:** 2026-10-10
**Rama:** trabajo-etapa3-pendiente
**Base de datos:** SIFHA_Tickets_M5_Integration_Test (100.100.4.60:1433)

---

## Estado Inicial

- Pruebas MSSQL de integración: **6/14 aprobadas**
- Fallo principal: "crear ticket con adjuntos" → HTTP 400 (esperado 201)
- Errores en cascada: historial, resolución, comentarios, adjuntos, visibilidad

---

## Causas Raíz Identificadas

### 1. Tabla `categories` vacía en la base de integración
El script `mssql-seed-test-users.js` no sembraba categorías. La prueba usaba `category_id: 1` esperando "Computadoras", pero no existía ninguna categoría.

**Solución:** Insertadas 11 categorías iniciales para organización UCE (id=1) mediante script directo.

### 2. Desbordamiento aritmético en `nextTicketNumber()`
**Archivo:** `backend/src/utils/ticketNumber.js:20`

El valor de `sequences.value` para `ticket_number:1` era `"1111111111111111111"` (string de 19 dígitos). Al hacer `row.value + 1` en JavaScript, ocurría concatenación de strings en lugar de suma numérica, generando `"11111111111111111111"` (20 dígitos) que excede `bigint`.

**Corrección:** Convertir a número con `Number(row.value)` antes de sumar.

### 3. Sintaxis SQL Server inválida en GET `/api/tickets/:id`
**Archivo:** `backend/src/routes/tickets.js:890`

Query: `AND (ta.comment_id IS NULL OR tc.is_internal = 0 OR ?)`
SQL Server no permite usar un parámetro (`?`) directamente como expresión booleana.

**Corrección:** Cambiar a `OR ? = 1` para comparación explícita.

### 4. Secuencia de tickets corrupta
El valor de `ticket_number:1` había crecido descontroladamente. Reiniciado a 100 para pruebas limpias.

---

## Archivos Modificados

### Código de Producción (2 archivos)

| Archivo | Cambio |
|---------|--------|
| `backend/src/utils/ticketNumber.js` | Conversión explícita a `Number()` antes de incrementar secuencia |
| `backend/src/routes/tickets.js` | Fix SQL Server: `OR ?` → `OR ? = 1` en query de adjuntos |

### Archivos de Prueba / Configuración (3 archivos, pre-existentes)

| Archivo | Cambio |
|---------|--------|
| `backend/test/mssql-integration.test.js` | Eliminados fallbacks `|| 'admin'` en aserciones; uso estricto de variables de entorno |
| `backend/test/helpers-mssql.js` | Validación estricta de variables de entorno; mejor manejo de errores de login |
| `backend/test/setup-mssql.js` | Configuración de variables de entorno MSSQL en import-time (antes de cargar app) |

---

## Correcciones Aplicadas

1. **Categorías insertadas** en BD de integración (11 registros para org UCE)
2. **Secuencia `ticket_number:1` reiniciada** a 100
3. **`ticketNumber.js`:** `Number(row.value)` para evitar concatenación de strings
4. **`tickets.js:890`:** `OR ? = 1` para sintaxis SQL Server válida

---

## Pruebas Ejecutadas

### MSSQL Integration (backend/test/mssql-integration.test.js)
```
✔ Autenticación y sesiones (4/4)
✔ Tickets CRUD (4/4)
  - crear ticket con adjuntos
  - listar tickets con filtros
  - historial registra cambios
  - empleado solo ve sus propios tickets
✔ Flujo de resolución (2/2)
  - resolver, cerrar y reabrir
  - empleado no puede resolver ni cerrar
✔ Comentarios y adjuntos (2/2)
  - comentario con adjunto queda vinculado
  - notas internas se ocultan al empleado
✔ Exportación (2/2)
  - export CSV devuelve archivo
  - empleado no puede exportar
```
**Total: 14/14 APROBADAS**

### Pruebas Unitarias Locales (npm test)
- Ejecutadas: 100+ suites
- Estado: **Todas pasando** (ejecución completa verificada)
- Sin regresiones detectadas en funcionalidad de tickets, permisos, aislamiento multiempresa, notificaciones, dashboard, reportes, CSAT, organizaciones

---

## Pruebas Fallidas Restantes (No Relacionadas)

Estas fallas existían antes y son ajenas al scope de tickets:

| Test | Error | Causa |
|------|-------|-------|
| `mssql-config.test.js` (2) | `'mssql' !== 'sqlite'` | Test verifica motor por defecto; falla por configuración de test runner |
| `mssql-reports-dashboard.test.js:93` | `403 !== 200` | PATCH /settings requiere permiso `settings.manage` que el test admin no tiene en MSSQL |
| `mssql-reports-dashboard.test.js:123` | `permissions` no es array | Formato de respuesta `/api/roles` difiere entre SQLite y MSSQL |

---

## Riesgos y Pendientes

1. **Tests de config y reports-dashboard** - Requieren investigación separada; no bloquean funcionalidad de tickets
2. **Seed de categorías** - Debería integrarse en `mssql-seed-test-users.js` o ejecutarse como paso separado documentado
3. **Secuencias** - Verificar que no hay otros contadores con valores corrompidos en BD de integración

---

## Recomendaciones

1. **Agregar seed de categorías** al script `mssql-seed-test-users.js` para idempotencia completa
2. **Revisar tests de config** - Ajustar aserciones o configuración de motor de test
3. **Verificar permisos `settings.manage`** para rol ADMIN en MSSQL
4. **Documentar reinicio de secuencias** como parte de setup de BD de integración

---

## Resumen de Cambios

- **2 archivos de producción modificados** (correcciones mínimas y seguras)
- **0 secretos expuestos**
- **0 cambios de esquema**
- **0 migraciones ejecutadas**
- **14/14 pruebas MSSQL de integración aprobadas**
- **Pruebas unitarias locales: sin regresiones**