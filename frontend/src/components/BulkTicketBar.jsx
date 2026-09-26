import { useQuery } from '@tanstack/react-query';
import { api, PRIORITIES, PRIORITY_LABEL } from '../lib/api';
import { Modal } from './ui';
import ResolveTicketsModal from './ResolveTicketsModal';

// Barra de acciones en lote + sus diálogos. Es la misma pieza para la Bandeja y
// para la pantalla general de tickets: recibe el estado de `useTicketBulk` y no
// vuelve a decidir nada, salvo qué botón es visible según el permiso real que
// exige el backend (ticket.assign / ticket.update.any / ticket.resolve /
// ticket.close).
export default function BulkTicketBar({ bulk, canAssign, canManage, canResolve, canClose }) {
  const { selected, busy } = bulk;

  // El directorio solo se pide si quien puede asignar abre el diálogo, de modo
  // que un selector cerrado no genera peticiones que acabarían en 403.
  const { data: assignUsers = [] } = useQuery({
    queryKey: ['assignable-users'],
    queryFn: () => api.get('/api/users/assignable').then((d) => d.data || []),
    enabled: bulk.assignOpen && canAssign,
  });

  return (
    <>
      {/* La barra depende de la selección, pero los diálogos no: el de resolución
          también se abre desde el menú de fila, donde no hay nada seleccionado. */}
      {selected.size > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 backdrop-blur">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-2 px-4 py-3 lg:px-8">
            <span className="text-sm font-semibold text-slate-800">{selected.size} seleccionado(s)</span>
            <button type="button" className="btn-ghost text-sm" onClick={bulk.clearSelection}>
              Quitar selección
            </button>
            <div className="ml-auto flex flex-wrap gap-2">
              {canAssign && (
                <button type="button" className="btn-secondary" disabled={busy} onClick={bulk.bulkAssignMe}>
                  Asignarme
                </button>
              )}
              {canAssign && (
                <button type="button" className="btn-secondary" disabled={busy} onClick={bulk.openAssign}>
                  Asignar a…
                </button>
              )}
              {canManage && (
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => bulk.bulkStatus('IN_PROGRESS')}>
                  En proceso
                </button>
              )}
              {canResolve && (
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => bulk.requestResolve([...selected])}>
                  Resuelto
                </button>
              )}
              {canClose && (
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => bulk.bulkStatus('CLOSED')}>
                  Cerrar
                </button>
              )}
              {canManage && (
                <button type="button" className="btn-secondary" disabled={busy} onClick={bulk.openPriority}>
                  Prioridad…
                </button>
              )}
              {canManage && (
                <button type="button" className="btn-danger" disabled={busy} onClick={bulk.openCancel}>
                  Cancelar
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <Modal open={bulk.assignOpen} onClose={() => bulk.setAssignOpen(false)} title={`Asignar ${selected.size} ticket(s)`}>
        <label className="label">Técnico asignado</label>
        <select
          className="input"
          value={bulk.assignValue}
          onChange={(e) => bulk.setAssignValue(e.target.value)}
        >
          <option value="">Seleccione un técnico…</option>
          {assignUsers.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name} {u.last_name}
              {u.department_name ? ` · ${u.department_name}` : ''}
            </option>
          ))}
        </select>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={() => bulk.setAssignOpen(false)} disabled={busy}>
            Cancelar
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={busy || !bulk.assignValue}
            onClick={() => {
              const assigned = Number(bulk.assignValue);
              bulk.setAssignOpen(false);
              bulk.bulkAssignTo(assigned);
            }}
          >
            Asignar
          </button>
        </div>
      </Modal>

      <Modal open={bulk.priorityOpen} onClose={() => bulk.setPriorityOpen(false)} title={`Prioridad de ${selected.size} ticket(s)`}>
        <p className="text-sm text-slate-600">
          Se aplicará a los tickets seleccionados. El servidor recalculará la fecha límite de SLA según la nueva prioridad.
        </p>
        <label className="label mt-4">Prioridad</label>
        <select
          className="input"
          value={bulk.priorityValue}
          onChange={(e) => bulk.setPriorityValue(e.target.value)}
        >
          <option value="">Seleccione una prioridad…</option>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABEL[p]}
            </option>
          ))}
        </select>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={() => bulk.setPriorityOpen(false)} disabled={busy}>
            Volver
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={busy || !bulk.priorityValue}
            onClick={() => {
              const priority = bulk.priorityValue;
              bulk.setPriorityOpen(false);
              bulk.bulkPriority(priority);
            }}
          >
            Aplicar prioridad
          </button>
        </div>
      </Modal>

      <Modal open={bulk.cancelOpen} onClose={() => bulk.setCancelOpen(false)} title={`Cancelar ${selected.size} ticket(s)`}>
        <p className="text-sm text-slate-600">Se cancelarán los tickets seleccionados. Esta acción no se puede deshacer.</p>
        <label className="mt-4 block text-sm font-medium text-slate-700">
          Motivo de cancelación <span className="text-red-500">*</span>
          <textarea
            className="input mt-1 min-h-[90px]"
            value={bulk.cancelReason}
            onChange={(e) => bulk.setCancelReason(e.target.value)}
            placeholder="Ej. Duplicados o solicitudes que ya no aplican…"
            maxLength={2000}
          />
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={() => bulk.setCancelOpen(false)} disabled={busy}>
            Volver
          </button>
          <button
            type="button"
            className="btn-danger"
            disabled={busy || !bulk.cancelReason.trim()}
            onClick={() => {
              const reason = bulk.cancelReason.trim();
              bulk.setCancelOpen(false);
              bulk.setCancelReason('');
              bulk.bulkCancel(reason);
            }}
          >
            Cancelar tickets
          </button>
        </div>
      </Modal>

      <ResolveTicketsModal
        open={bulk.resolveOpen}
        onClose={() => bulk.setResolveOpen(false)}
        count={bulk.resolveIds.length}
        busy={busy}
        onConfirm={bulk.runResolve}
      />
    </>
  );
}
