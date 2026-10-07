// Helpers de organización (ETAPA 1A y 2).
//
// La etapa 1A creó la base (tabla organizations, users.organization_id, rol
// SUPERADMIN). La etapa 2 aísla departamentos y usuarios por organización
// usando estos helpers. La organización SIEMPRE la decide el servidor: el
// cliente nunca la propone.

// Fuerza que la petición tenga contexto de organización. El valor nunca sale de
// la petición del cliente: lo decide el servidor (req.user.organization_id,
// cargado desde la sesión en loadUser). Un SUPERADMIN global (organization_id
// null) no tiene contexto propio y deberá elegirlo explícitamente; esa elección
// explícita NO está implementada todavía.
export function requireOrg(req, res, next) {
  if (!req.user || !req.user.organization_id) {
    return res.status(403).json({ error: 'Requiere una organización de contexto' });
  }
  next();
}

// Devuelve el predicado SQL con el que una tabla (o alias) queda restringida a
// la organización del usuario: `alias.organization_id = ?`. El parámetro se
// rellena con currentOrgId(req.user).
export function orgScope(alias) {
  const col = alias ? `${alias}.organization_id` : 'organization_id';
  return `${col} = ?`;
}

// Organización del usuario autenticado (null para un SUPERADMIN global).
export function currentOrgId(user) {
  return user && user.organization_id ? user.organization_id : null;
}

// ETAPA 2: si el cliente intenta fijar la organización en el cuerpo, se
// rechaza. Devuelve el mensaje de error o null si el cuerpo no lleva campo
// `organization_id` (o lo lleva vacío). El valor de la organización sale
// SIEMPRE del contexto de sesión, jamás del cliente.
export function rejectClientOrg(body) {
  if (!body || typeof body !== 'object') return null;
  const org = body.organization_id;
  if (org === undefined || org === null || org === '') return null;
  return 'La organización no puede ser establecida desde el cliente';
}

// Restringe una ruta al SUPERADMIN global. Las cuentas y el rol SUPERADMIN
// solo los administra otro SUPERADMIN; ningún permiso de un rol de
// organización puede abrir este canal.
export function requireSuperadmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'No autenticado' });
  if (!req.user.is_superadmin) {
    return res.status(403).json({ error: 'Solo un superadministrador puede realizar esta acción' });
  }
  next();
}