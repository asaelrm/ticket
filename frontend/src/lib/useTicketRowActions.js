import { useCallback, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ticketStatusRequest, STATUS_LABEL } from './api';

// Acciones de fila compartidas por la Bandeja y "Todos los tickets".
//
// Antes cada pantalla tenía su propio par de mutaciones (`assignMeMutation` y
// `statusMutation`) y sólo la Bandeja tenía el cerrojo anti-doble-clic. Aquí hay
// un único mecanismo para las dos superficies y para las dos acciones:
//
//  * `inFlight` es un ref, no estado: decide el bloqueo antes de que React
//    repinte, que es lo que hacia falta para que un segundo clic no colgara un
//    segundo PATCH del mismo ticket.
//  * `pendingIds` es el espejo en estado que la tabla usa para pintar el botón
//    como ocupado y deshabilitar el menú de esa fila.
//  * Todo pasa por `ticketStatusRequest`, de modo que RESOLVED/CLOSED/CANCELLED
//    van siempre a su endpoint dedicado y nunca al PATCH genérico que el backend
//    rechaza.
//  * Los permisos se vuelven a comprobar aquí aunque la tabla ya no ofrezca el
//    botón: es una segunda barrera, no la única. El servidor sigue siendo la
//    autoridad.
export function useTicketRowActions({ user, queryKeys, onBeforeAction }) {
  const queryClient = useQueryClient();
  const inFlight = useRef(new Set());
  const [pendingIds, setPendingIds] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const permissions = useMemo(() => {
    const list = user?.permissions || [];
    return {
      canAssign: list.includes('ticket.assign'),
      canManage: list.includes('ticket.update.any'),
      canResolve: list.includes('ticket.resolve'),
      canClose: list.includes('ticket.close'),
    };
  }, [user]);

  // La pantalla pasa el array en línea, así que se compara por su contenido:
  // si no, `invalidate` cambiaría de identidad en cada render.
  const keysKey = queryKeys.join('|');
  const invalidate = useCallback(() => {
    for (const key of keysKey.split('|')) {
      if (key) queryClient.invalidateQueries({ queryKey: [key] });
    }
  }, [queryClient, keysKey]);

  const mutation = useMutation({
    mutationFn: ({ request }) => api[request.method](request.path, request.body),
    onMutate: () => {
      setBusy(true);
      setError('');
      setNotice('');
      onBeforeAction?.();
    },
    onSuccess: (_data, { successMessage }) => {
      invalidate();
      if (successMessage) setNotice(successMessage);
    },
    onError: (err, { errorMessage }) => {
      // El backend ya responde en lenguaje natural ("Debe registrar una
      // resolución antes de cerrar el ticket."), así que se muestra su texto y
      // el fallback sólo cubre fallos sin mensaje.
      setError(err?.message || errorMessage);
    },
    onSettled: () => {
      setBusy(false);
    },
  });

  // Devuelve la promesa de la petición (o `null` si esa fila ya tenía una
  // acción en curso, para que el llamante pueda ignorar el segundo clic).
  const run = useCallback(
    (ticket, options) => {
      if (!ticket || inFlight.current.has(ticket.id)) return null;
      inFlight.current.add(ticket.id);
      setPendingIds(new Set(inFlight.current));
      return mutation.mutateAsync(options).finally(() => {
        inFlight.current.delete(ticket.id);
        setPendingIds(new Set(inFlight.current));
      });
    },
    [mutation]
  );

  const assignMe = useCallback(
    (ticket) => {
      if (!permissions.canAssign) return null;
      return run(ticket, {
        request: { method: 'patch', path: `/api/tickets/${ticket.id}`, body: { assigned_to_id: user.id } },
        successMessage: `Tomaste ${ticket.ticket_number}. Ya aparece en “Asignados a mí”.`,
        errorMessage: 'No se pudo asignar el ticket',
      });
    },
    [permissions.canAssign, run, user?.id]
  );

  const runStatus = useCallback(
    (ticket, status, body = {}) => {
      // Segunda barrera de permisos, alineada con lo que exige cada ruta del
      // servidor: /resolve pide ticket.resolve, /close pide ticket.close y el
      // resto de estados pasan por el PATCH, que pide ticket.update.any.
      const allowed =
        status === 'RESOLVED' ? permissions.canResolve
        : status === 'CLOSED' ? permissions.canClose
        : status === 'CANCELLED' ? permissions.canManage
        : permissions.canManage;
      if (!allowed) return null;
      return run(ticket, {
        request: ticketStatusRequest(ticket.id, status, body),
        successMessage: `${ticket.ticket_number}: ${STATUS_LABEL[status] || status}.`,
        errorMessage: 'No se pudo actualizar el estado del ticket',
      });
    },
    [permissions, run]
  );

  const dismissNotice = useCallback(() => setNotice(''), []);
  const clearError = useCallback(() => setError(''), []);

  return {
    permissions,
    pendingIds,
    busy,
    error,
    notice,
    isPending: (id) => pendingIds.has(id),
    assignMe,
    runStatus,
    clearError,
    dismissNotice,
  };
}