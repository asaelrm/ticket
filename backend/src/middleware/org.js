// Helpers de organización (ETAPA 1A).
//
// Esta etapa crea la base (tabla organizations, users.organization_id, rol
// SUPERADMIN) pero TODAVÍA NO aísla endpoints por organización: eso llega en
// etapas posteriores. Estos helpers existen para que todas las rutas usen el
// mismo criterio cuando llegue el momento.

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