import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ticketStatusRequest } from './api';

// Operaciones masivas compartidas por la Bandeja y la pantalla general de
// tickets. Concentra la selección, la llamada por ticket y el detalle de fallos
// para que ambas superficies hablen exactamente el mismo contrato con el
// backend: el servidor rechaza PATCH con RESOLVED/CLOSED/CANCELLED
// (tickets.js:861) y exige la solución en /resolve.
//
// La selección es siempre por página: `resetKey` (la query de la pantalla) limpia
// el set al cambiar filtros o paginación, de modo que nunca se ejecuten acciones
// sobre tickets que el usuario ya no está viendo.
export function useTicketBulk({ user, queryKeys, resetKey, labelFor }) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [errorDetails, setErrorDetails] = useState([]);
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignValue, setAssignValue] = useState('');
  const [priorityOpen, setPriorityOpen] = useState(false);
  const [priorityValue, setPriorityValue] = useState('');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [resolveOpen, setResolveOpen] = useState(false);
  const [resolveIds, setResolveIds] = useState([]);

  // Comportamiento seguro: cualquier cambio de filtros o de página descarta la
  // selección pendiente en lugar de arrastrarla sobre otra lista de tickets.
  useEffect(() => {
    setSelected(new Set());
  }, [resetKey]);

  const invalidate = () => {
    for (const key of queryKeys) queryClient.invalidateQueries({ queryKey: key });
  };

  const clearFeedback = () => {
    setError('');
    setErrorDetails([]);
  };

  const bulkMutation = useMutation({
    mutationFn: ({ targets }) => Promise.allSettled(targets.map((t) => t.run())),
    onMutate: clearFeedback,
    onSuccess: (results, { targets }) => {
      // Se conservan seleccionados solo los que fallaron: el usuario ve de
      // inmediato cuáles requieren atención y puede reintentarlos, en lugar de
      // perderlos en un "todo bien" engañoso.
      const failedIds = new Set();
      const details = [];
      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          failedIds.add(targets[i].id);
          // El backend ya explica el motivo en lenguaje natural; se muestra tal
          // cual, sin exponer datos técnicos internos.
          const reason = r.reason?.message || 'No se pudo actualizar el ticket';
          details.push(`${targets[i].label} — ${reason}`);
        }
      });

      setSelected(failedIds);
      invalidate();

      if (details.length) {
        setError(`${details.length} de ${targets.length} ticket(s) no se pudieron actualizar.`);
        setErrorDetails(details);
      }
    },
    onSettled: () => {
      setBusy(false);
    },
  });

  // Envuelve cada id con su etiqueta legible antes de la llamada: tras el refetch
  // el ticket puede salir de la página actual y se perdería su número.
  const runBulk = (ids, fn) => {
    const targets = [...ids].map((id) => ({ id, label: labelFor(id), run: () => fn(id) }));
    setBusy(true);
    bulkMutation.mutate({ targets });
  };

  const toggleOne = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = (ids, checked) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  // Una única función para fila y lote: garantiza que ambas superficies usen
  // exactamente el mismo contrato con el backend.
  const callStatus = (id, status, payload) => {
    const r = ticketStatusRequest(id, status, payload);
    return api[r.method](r.path, r.body);
  };

  const bulkAssignMe = () =>
    runBulk(selected, (id) => api.patch(`/api/tickets/${id}`, { assigned_to_id: user.id }));

  const bulkAssignTo = (assignedToId) =>
    runBulk(selected, (id) => api.patch(`/api/tickets/${id}`, { assigned_to_id: assignedToId }));

  const bulkStatus = (status) => runBulk(selected, (id) => callStatus(id, status));

  // El backend recalcula el SLA con la nueva prioridad (tickets.js:927).
  const bulkPriority = (priority) =>
    runBulk(selected, (id) => api.patch(`/api/tickets/${id}`, { priority }));

  const bulkCancel = (reason) =>
    runBulk(selected, (id) => api.post(`/api/tickets/${id}/cancel`, { reason }));

  const openAssign = () => {
    setAssignValue('');
    setAssignOpen(true);
  };

  const openPriority = () => {
    setPriorityValue('');
    setPriorityOpen(true);
  };

  const openCancel = () => {
    setCancelReason('');
    setCancelOpen(true);
  };

  // /resolve exige la solución, así que se pide antes de tocar el backend.
  const requestResolve = (ids) => {
    setResolveIds([...ids]);
    setResolveOpen(true);
  };

  const runResolve = (resolution) => {
    const ids = resolveIds;
    setResolveOpen(false);
    runBulk(ids, (id) => callStatus(id, 'RESOLVED', { resolution }));
  };

  return {
    // selección
    selected,
    toggleOne,
    toggleAll,
    clearSelection: () => setSelected(new Set()),
    // estado y feedback
    busy,
    error,
    errorDetails,
    clearFeedback,
    // acciones
    bulkAssignMe,
    bulkAssignTo,
    bulkStatus,
    bulkPriority,
    bulkCancel,
    // asignación
    openAssign,
    assignOpen,
    setAssignOpen,
    assignValue,
    setAssignValue,
    // prioridad
    openPriority,
    priorityOpen,
    setPriorityOpen,
    priorityValue,
    setPriorityValue,
    // cancelación
    openCancel,
    cancelOpen,
    setCancelOpen,
    cancelReason,
    setCancelReason,
    // resolución
    requestResolve,
    resolveOpen,
    setResolveOpen,
    resolveIds,
    runResolve,
  };
}
