// Qué acción rápida corresponde a cada estado de ticket, y con qué permiso.
//
// Vive fuera del componente porque es una decisión de negocio, no de pintura: la
// misma tabla la usa Bandeja y "Todos los tickets", y los tests la consultan sin
// montar nada. Los estados y transiciones son los que el backend ya acepta
// (backend/src/routes/tickets.js):
//
//   OPEN / ASSIGNED  -> IN_PROGRESS  por PATCH /api/tickets/:id  (ticket.update.any)
//   IN_PROGRESS      -> PENDING      por el mismo PATCH           (ticket.update.any)
//   PENDING          -> IN_PROGRESS  por el mismo PATCH           (ticket.update.any)
//   *                -> RESOLVED     por POST /resolve            (ticket.resolve)
//   *                -> CLOSED       por POST /close              (ticket.close)
//   *                -> CANCELLED    por POST /cancel             (ticket.update.any)
//
// RESOLVED, CLOSED y CANCELLED son terminales: el backend ya no admite
// resurrectarlos por PATCH, así que la tabla no ofrece ninguna acción operativa
// sobre ellos y sólo deja consultar el detalle.

export const TERMINAL_STATUSES = ['RESOLVED', 'CLOSED', 'CANCELLED'];

// Estados en los que el ticket sigue computando SLA (los mismos que
// OPEN_STATUSES en backend/src/utils/sla.js).
export const SLA_ACTIVE_STATUSES = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'PENDING'];

export function isTerminal(status) {
  return TERMINAL_STATUSES.includes(status);
}

// `kind` decide qué hace el botón:
//   'assign' -> PATCH assigned_to_id = yo   (ticket.assign)
//   'status' -> PATCH status = action.status (ticket.update.any)
//   'resolve'-> POST /resolve               (ticket.resolve)
export function quickActionsFor(ticket, perms = {}, currentUserId = null) {
  const { canAssign = false, canManage = false, canResolve = false } = perms;
  if (!ticket || isTerminal(ticket.status)) return [];

  // Sin dueño: tomar el ticket es lo único que tiene sentido, y el botón no
  // duplica "Asignarme a mí" del menú (allí sólo aparece si ya hay técnico).
  if (!ticket.assigned_to_id && canAssign) {
    return [{ key: 'take', label: 'Tomar ticket', kind: 'assign' }];
  }

  const mine = currentUserId != null && ticket.assigned_to_id === currentUserId;

  if (ticket.status === 'OPEN' || ticket.status === 'ASSIGNED') {
    return mine && canManage
      ? [{ key: 'start', label: 'Iniciar atención', kind: 'status', status: 'IN_PROGRESS' }]
      : [];
  }

  if (ticket.status === 'IN_PROGRESS') {
    const actions = [];
    if (canResolve) actions.push({ key: 'resolve', label: 'Resolver', kind: 'resolve', status: 'RESOLVED' });
    if (canManage) actions.push({ key: 'hold', label: 'Poner en espera', kind: 'status', status: 'PENDING' });
    return actions;
  }

  if (ticket.status === 'PENDING') {
    const actions = [];
    if (canManage) actions.push({ key: 'resume', label: 'Reanudar', kind: 'status', status: 'IN_PROGRESS' });
    if (canResolve) actions.push({ key: 'resolve', label: 'Resolver', kind: 'resolve', status: 'RESOLVED' });
    return actions;
  }

  return [];
}

// Entradas del menú "⋯" de la fila. Es el conjunto completo de lo que se puede
// hacer con ese ticket; la acción rápida es sólo un atajo a la primera.
// Devuelve `null` donde no toca, porque `Menu` ya filtra los `falsy`.
//
// `currentUserId` viaja en el mismo objeto que los manejadores. Sin él no se
// puede saber si el ticket ya es del usuario que lo está mirando, así que la
// autasignación se sigue ofreciendo: `MyTickets.jsx` monta la tabla sin ese dato
// y ocultarla allí sería inventar una restricción que el backend no tiene.
export function menuItemsFor(ticket, perms = {}, handlers = {}) {
  const { canAssign = false, canManage = false, canResolve = false, canClose = false } = perms;
  const onView = handlers.onView || (() => {});
  const onAssignMe = handlers.onAssignMe || (() => {});
  const onStatusChange = handlers.onStatusChange || (() => {});
  const onCancel = handlers.onCancel || (() => {});
  const { currentUserId = null } = handlers;

  const items = [{ key: 'view', label: 'Ver detalle', icon: '🔎', onClick: onView }];

  // Terminal: no hay nada que operar. Sólo consultar.
  if (isTerminal(ticket.status)) return items;

  const mine = currentUserId != null && ticket.assigned_to_id === currentUserId;

  // Autasignarse sólo tiene sentido si el ticket es de otra persona. Sobre un
  // ticket ya propio el PATCH sería un no-op que además se anuncia como una
  // acción Real en el aviso de éxito ("Tomaste TCK-…"), así que se oculta.
  if (canAssign && ticket.assigned_to_id && !mine) {
    items.push({ key: 'me', label: 'Asignarme a mí', icon: '🙋', onClick: onAssignMe });
  }
  // "Marcar en proceso" y "Poner en espera" son las dos direcciones del PATCH de
  // estado. Se ofrecen según el estado actual para no ofrecer, por ejemplo,
  // volver a poner en proceso un ticket que ya lo está.
  if (canManage && ticket.status !== 'IN_PROGRESS') {
    items.push({ key: 'prog', label: 'Marcar en proceso', icon: '⏳', onClick: () => onStatusChange(ticket, 'IN_PROGRESS') });
  }
  if (canManage && ticket.status === 'IN_PROGRESS') {
    items.push({ key: 'hold', label: 'Poner en espera', icon: '⏸️', onClick: () => onStatusChange(ticket, 'PENDING') });
  }
  if (canResolve) {
    items.push({ key: 'res', label: 'Marcar resuelto', icon: '✅', onClick: () => onStatusChange(ticket, 'RESOLVED') });
  }
  if (canClose) {
    items.push({ key: 'close', label: 'Cerrar ticket', icon: '📁', onClick: () => onStatusChange(ticket, 'CLOSED') });
  }
  if (canManage) {
    items.push({ key: 'sep', separator: true });
    items.push({ key: 'cancel', label: 'Cancelar ticket', icon: '🚫', danger: true, onClick: onCancel });
  }
  return items;
}