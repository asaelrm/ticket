import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, PRIORITIES, PRIORITY_LABEL } from '../lib/api';
import { Modal } from './ui';
import ResolveTicketsModal from './ResolveTicketsModal';
import Select from './Select';

// La barra se ancla abajo con `fixed`, o sea fuera del flujo, así que se apoya
// encima del final del contenido: para que no tape la última fila ni la
// paginación hace falta un hueco a su medida en el flujo normal, y ese hueco
// tiene que valer lo mismo que la barra en cualquier pantalla.
//
// Por eso el alto se declara aquí y no se deduce del contenido: las acciones
// viven en una sola línea que se desplaza en horizontal cuando no cabe —el
// mismo patrón que las pestañas de vistas de Bandeja y Tickets—, en lugar de
// repartirse en varias filas. Con `flex-wrap` la barra medía una fila en
// escritorio y tres o cuatro en móvil, y la reserva fija de la que disponían las
// pantallas se quedaba corta justo donde la barra crecía. Este valor es 1px del
// borde superior + el aire de los antiguos `py-3` (1.5rem) + el botón más alto
// (2.5rem), y lo usan las dos piezas del componente —la barra y su hueco en el
// flujo— para que midan lo mismo por construcción.
export const BAR_HEIGHT = 'h-[65px]';

// Barra de acciones en lote + sus diálogos. Es la misma pieza para la Bandeja y
// para la pantalla general de tickets: recibe el estado de `useTicketBulk` y no
// vuelve a decidir nada, salvo qué botón es visible según el permiso real que
// exige el backend (ticket.assign / ticket.update.any / ticket.resolve /
// ticket.close).
export default function BulkTicketBar({ bulk, canAssign, canManage, canResolve, canClose }) {
  const { selected, busy } = bulk;

  // Barra y hueco van y vienen juntos, así que comparten la misma condición: sin
  // selección no queda barra ni espacio reservado.
  const visible = selected.size > 0;

  // El directorio solo se pide si quien puede asignar abre el diálogo, de modo
  // que un selector cerrado no genera peticiones que acabarían en 403.
  const { data: assignUsers = [] } = useQuery({
    queryKey: ['assignable-users'],
    queryFn: () => api.get('/api/users/assignable').then((d) => d.data || []),
    enabled: bulk.assignOpen && canAssign,
  });

  // La `<option>` vacía era seleccionable, así que se conserva como primera
  // opción real (no como `placeholder`) para poder volver a ella.
  const assignOptions = useMemo(
    () => [
      { value: '', label: 'Seleccione un técnico…' },
      ...assignUsers.map((u) => ({
        value: u.id,
        label: `${u.name} ${u.last_name}${u.department_name ? ` · ${u.department_name}` : ''}`,
      })),
    ],
    [assignUsers]
  );
  const priorityOptions = useMemo(
    () => [
      { value: '', label: 'Seleccione una prioridad…' },
      ...PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] })),
    ],
    []
  );

  return (
    <>
      {/* La barra depende de la selección, pero los diálogos no: el de resolución
          también se abre desde el menú de fila, donde no hay nada seleccionado. */}
      {visible && (
        // El hueco de la barra en el flujo normal. Va después del contenido (esta
        // pieza es el último nodo de la página) y se monta y se desmonta con la
        // barra, así que sin selección no deja ni un píxel de espacio vacío.
        <div data-testid="bulk-bar-gap" aria-hidden="true" className={BAR_HEIGHT} />
      )}
      {visible && (
        <div
          data-testid="bulk-bar"
          className={`fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 backdrop-blur ${BAR_HEIGHT}`}
        >
          {/* Una sola línea, sin saltos: es lo que hace que el alto sea siempre
              `BAR_HEIGHT`. Si no cabe, se desplaza en vez de crecer, y como
              `ml-auto` sólo consume espacio sobrante, el desborde cae a la
              derecha, que es la dirección alcanzable con el scroll. El scrollbar
              va oculto porque el alto está justo y en táctil no se dibuja. */}
          <div className="mx-auto flex h-full max-w-7xl items-center gap-2 overflow-x-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:px-8">
            <span className="shrink-0 text-sm font-semibold text-slate-800">{selected.size} seleccionado(s)</span>
            <button type="button" className="btn-ghost shrink-0 text-sm" onClick={bulk.clearSelection}>
              Quitar selección
            </button>
            {/* `ml-auto` mantiene las acciones pegadas a la derecha cuando hay
                sitio; al no haberlo, no empuja nada y la línea se desborda por
                la derecha, que es la dirección en la que se puede desplazar. */}
            <div className="ml-auto flex shrink-0 gap-2">
              {canAssign && (
                <button type="button" className="btn-secondary shrink-0" disabled={busy} onClick={bulk.bulkAssignMe}>
                  Asignarme
                </button>
              )}
              {canAssign && (
                <button type="button" className="btn-secondary shrink-0" disabled={busy} onClick={bulk.openAssign}>
                  Asignar a…
                </button>
              )}
              {canManage && (
                <button type="button" className="btn-secondary shrink-0" disabled={busy} onClick={() => bulk.bulkStatus('IN_PROGRESS')}>
                  En proceso
                </button>
              )}
              {canResolve && (
                <button type="button" className="btn-secondary shrink-0" disabled={busy} onClick={() => bulk.requestResolve([...selected])}>
                  Resuelto
                </button>
              )}
              {canClose && (
                <button type="button" className="btn-secondary shrink-0" disabled={busy} onClick={() => bulk.bulkStatus('CLOSED')}>
                  Cerrar
                </button>
              )}
              {canManage && (
                <button type="button" className="btn-secondary shrink-0" disabled={busy} onClick={bulk.openPriority}>
                  Prioridad…
                </button>
              )}
              {canManage && (
                <button type="button" className="btn-danger shrink-0" disabled={busy} onClick={bulk.openCancel}>
                  Cancelar
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <Modal open={bulk.assignOpen} onClose={() => bulk.setAssignOpen(false)} title={`Asignar ${selected.size} ticket(s)`}>
        <label className="label" htmlFor="bulk-assign">Técnico asignado</label>
        <Select
          id="bulk-assign"
          options={assignOptions}
          value={bulk.assignValue}
          onChange={(v) => bulk.setAssignValue(v)}
        />
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
        <label className="label mt-4" htmlFor="bulk-priority">Prioridad</label>
        <Select
          id="bulk-priority"
          options={priorityOptions}
          value={bulk.priorityValue}
          onChange={(v) => bulk.setPriorityValue(v)}
        />
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
