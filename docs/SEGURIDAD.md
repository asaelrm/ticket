# Seguridad — SIFHA Ticket

Resumen ejecutivo de la postura de seguridad. El informe detallado de la
auditoría está en `docs/SEGURIDAD-AUDITORIA.md`.

## Veredicto

- **0 hallazgos Altos.**
- 3 Medios de endurecimiento (no bloqueantes; se corrigen antes de exponer la
  instancia; 1 corregido en esta entrega).
- **APTO** para entrega del código.

## Controles implementados

| Área | Control |
|------|---------|
| Contraseñas | bcrypt coste 12; política mínima de 12 caracteres; sin contraseñas por defecto en el repo (el seed no inventa cuentas) |
| Sesiones | Cookies `httpOnly` + `SameSite`, CSRF double-submit, `regenerate()` en login, caducidad |
| Inyección SQL | Parametrización uniforme (`?` / `@param`) y listas blancas; traductor de dialecto no introduce concatenación |
| Multi-empresa | Aislamiento resuelto en servidor (`organization_id` + FK compuestas `same_org`); filtros obligatorios por organización |
| Ataques de usuario | Rate limiting en login/forgot/reset; hash señuelo bcrypt para evitar enumeración por tiempo; respuestas idénticas si la cuenta no existe |
| Adjuntos | Validación por *magic bytes* (no solo extensión/MIME), nombres internos únicos, límites de tamaño/cantidad, descarga con autorización |
| Transporte | Helmet + CSP; HSTS por host; `COOKIE_SECURE`; política de proxy explícita (`TRUST_PROXY`) y rechazo de falsificación `X-Forwarded-Proto` |
| Errores | Responden 5xx sin traza; no filtran detalles internos |
| Secretos | `.env`, `.env.*.local`, certificados/claves y `deploy/central/.env` en `.gitignore`; `.example` con marcadores |
| Arranque de producción | `assertStartupConfig`: sin `SESSION_SECRET` válido, `PUBLIC_URL` o con `SEED_DEMO_ACCOUNTS=true`, el proceso **no arranca** |

## Estado de los hallazgos Medios

1. **Credenciales de ejemplo con datos reales en `.env.mssql-test.example`** —
   **CORREGIDO** en esta entrega (servidor y usuario sustituidos por marcadores).
2. **`SESSION_SECRET` con valor por defecto de desarrollo** — mitigado por
   diseño: en producción `assertStartupConfig` rechaza arrancar con secretos
   de ejemplo o ausentes. No se cambia el comportamiento en desarrollo.
3. **Token de reseteo devuelto en HTTP** — restringido a `NODE_ENV=development`
   (`backend/src/routes/auth.js`); en cualquier otro entorno el token solo
   viaja por correo. No se cambia: es una utilidad de desarrollo deliberada.

## Recomendaciones antes de exponer la instancia

- TLS de extremo a extremo (`COOKIE_SECURE=true`, `TRUST_PROXY` bien definido).
- `PUBLIC_URL` real de la instalación.
- No activar `SEED_DEMO_ACCOUNTS` en entornos no locales.
- Revisar `npm audit` periódicamente (no se realizaron actualizaciones masivas).
- Añadir ESLint/`lint` (recomendación no bloqueante).

## Verificaciones en pruebas

La suite cubre transporte (HTTPS/HSTS/CSRF), sesión segura, confianza de proxy,
validación de adjuntos por contenido, aislamiento multi-empresa y errores HTTP.
Ver `docs/PRUEBAS.md`.