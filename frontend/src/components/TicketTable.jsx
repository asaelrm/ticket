import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { formatRelative, formatDateTime, formatSla, slaInfo, slaLevel } from '../lib/api';
import { quickActionsFor, menuItemsFor, SLA_ACTIVE_STATUSES } from '../lib/ticketActions';
import { EmptyState, Pagination, Menu, Avatar, Modal, StatusBadge, PriorityBadge, Spinner } from './ui';
import ResolveTicketModal from './ResolveTicketModal';
import Tooltip from './Tooltip';

function SortHeader({ col, label, sort, dir, onSort, className = '' }) {
  if (!onSort) return <th className={`th ${className}`}>{label}</th>;
  const active = sort === col;
  return (
    <th className={`th ${className}`}>
      <button
        type="button"
        onClick={() => onSort(col, active && dir === 'desc' ? 'asc' : 'desc')}
        className={`inline-flex items-center gap-1 transition hover:text-slate-700 ${active ? 'text-brand-700' : ''}`}
      >
        {label}
        <span className="text-[10px] leading-none">{active ? (dir === 'asc' ? '▲' : '▼') : '↕'}</span>
      </button>
    </th>
  );
}

// Un solo lugar decide cómo se ve la urgencia: la franja lateral de la fila y
// la celda de SLA comparten estos tonos, que ya existen en el tema (rojo de
// `text-red-600`, ámbar de `text-amber-600`, verde de `bg-emerald-500`).
// El fondo de la fila NO se tiñe: la urgencia vive en la franja, en el punto de
// color y en el texto, para que una fila vencida siga siendo legible de un
// vistazo sin perder el resto de la tabla.
const SLA_TONE = {
  overdue: { text: 'text-red-600', dot: 'bg-red-500' },
  at_risk: { text: 'text-amber-600', dot: 'bg-amber-500' },
  ok: { text: 'text-slate-500', dot: 'bg-emerald-500' },
  none: { text: 'text-slate-400', dot: 'bg-slate-300' },
};

// Marca lateral de la fila. Su `label` también es el texto alternativo, para
// que la urgencia no dependa sólo del color ni de la columna SLA, que en
// pantallas estrechas se oculta.
const ROW_FLAG = {
  overdue: { bar: 'bg-red-500', label: 'Fuera de plazo' },
  critical: { bar: 'bg-red-500', label: 'Prioridad crítica' },
  at_risk: { bar: 'bg-amber-500', label: 'Vence pronto' },
};

// Tres textos y sólo tres, porque son tres hechos distintos y el técnico decide
// distinto con cada uno: "Sin SLA" significa que el ticket abierto no tiene
// plazo (no que esté en paz), y "—" en un ticket terminal significa que el plazo
// ya dejó de contar.
function SlaCell({ ticket }) {
  const info = slaInfo(ticket);
  if (!info) {
    if (!SLA_ACTIVE_STATUSES.includes(ticket.status)) {
      return (
        <Tooltip text="El plazo dejó de contar al cerrarse el ticket">
          <span className="text-slate-400">—</span>
        </Tooltip>
      );
    }
    return (
      <Tooltip text="Este ticket no tiene fecha límite de atención">
        <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-slate-400">
          <span className="h-1.5 w-1.5 rounded-full bg-slate-300" aria-hidden="true" />
          Sin SLA
        </span>
      </Tooltip>
    );
  }
  const tone = SLA_TONE[slaLevel(ticket)] || SLA_TONE.ok;
  return (
    <Tooltip text={`${info.overdue ? 'Venció' : 'Vence'}: ${info.due.toLocaleString('es-ES')}`}>
      <span className={`inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium ${tone.text}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} aria-hidden="true" />
        {formatSla(ticket)}
      </span>
    </Tooltip>
  );
}

// Última actividad del ticket. `updated_at` ya viene en la misma consulta del
// listado (LIST_SQL selecciona `t.*`), así que esto no cuesta una petición por
// fila; sólo cambia cómo se lee: relativo en la celda y exacto en el tooltip.
function LastActivityCell({ ticket }) {
  if (!ticket.updated_at) return <span className="text-slate-400">—</span>;
  // `text-xs` como SLA y como la segunda línea del título: las tres son
  // metadatos de la misma fila y comparten tamaño para que se lean igual.
  return (
    <Tooltip text={`Última actividad: ${formatDateTime(ticket.updated_at)}`}>
      <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-slate-500">
        <svg className="h-3 w-3 shrink-0 text-slate-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path strokeLinecap="round" d="M12 7v5l3 2" />
        </svg>
        <span>{formatRelative(ticket.updated_at)}</span>
      </span>
    </Tooltip>
  );
}

// `onErrorShown` es opcional y lo connecta quien ya tiene el error a nivel de
// página. Este diálogo muestra el fallo dentro de sí mismo, así que avisa para
// que la página retire su propio `ErrorBox`: el mismo fallo no debe verse dos
// veces a la vez, una detrás del modal y otra dentro. Si no se conecta, el
// diálogo funciona igual y sólo cambia que el mensaje se ve también detrás.
function CancelTicketDialog({ ticket, onClose, onSubmit, onErrorShown }) {
  const [reason, setReason] = useState('');
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState('');
  return (
    <Modal open onClose={onClose} title={ticket ? `Cancelar ${ticket.ticket_number}` : 'Cancelar ticket'}>
      <p className="text-sm text-slate-600">
        Va a cancelar el ticket <b>“{ticket?.title}”</b>. Esta acción no se puede deshacer.
      </p>
      <label className="mt-4 block text-sm font-medium text-slate-700">
        Motivo de cancelación <span className="text-red-500">*</span>
        <textarea
          className="input mt-1 min-h-[90px]"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Ej. El usuario ya no necesita el servicio…"
          maxLength={2000}
        />
      </label>
      {err && <p role="alert" className="mt-2 text-sm text-red-600">{err}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <button className="btn-secondary" onClick={onClose} disabled={sending}>
          Volver
        </button>
        <button
          className="btn-danger"
          disabled={sending || !reason.trim()}
          onClick={async () => {
            setSending(true);
            setErr('');
            try {
              await onSubmit({ reason: reason.trim() });
              onClose();
            } catch (e) {
              setErr(e.message || 'No se pudo cancelar el ticket');
              setSending(false);
              // El mensaje queda a cargo de este diálogo. Se pide a la página
              // limpiar el suyo para que no haya dos representaciones del mismo
              // fallo simultáneas.
              onErrorShown?.();
            }
          }}
        >
          Cancelar ticket
        </button>
      </div>
    </Modal>
  );
}

export function TicketTable({
  list,
  basePath = '/app/my-tickets',
  onPage,
  perPage,
  onPerPage,
  sort,
  dir,
  onSort,
  canAssign,
  canManage,
  canResolve,
  canClose,
  // Id del usuario conectado. La fila sólo ofrece "Iniciar atención" sobre un
  // ticket que es suyo: tomar atención del trabajo de otra persona es una
  // decisión de coordinación, no un atajo de la bandeja personal.
  currentUserId = null,
  onAssignMe,
  onStatusChange,
  selectable = false,
  selected,
  onToggle,
  onToggleAll,
  // Ids con una acción rápida en curso. Sirve para bloquear el botón y el menú
  // de esa fila: sin esto, un doble clic dispara dos PATCH del mismo ticket.
  pendingIds,
  // Contenido a mostrar cuando la página no trae filas. Cada pantalla decide su
  // propio mensaje (no hay tickets, ni tickets asignados, ni filtros sin
  // resultado); si no se pasa, se conserva el estado vacío genérico.
  emptyState,
  // Retira del `ErrorBox` de la página el error que el diálogo de cancelación
  // va a mostrar por su cuenta. Es opcional: quien no lo pase (o no lo pase
  // función) simplemente verá el mensaje en los dos sitios, como antes. No
  // afecta a los errores de ninguna otra acción: aquí no se absorbe ni se
  // reescribe error alguno, sólo se pide que se retire el que el diálogo va a
  // representar por dentro.
  onClearError,
}) {
  const navigate = useNavigate();
  const [cancelTicket, setCancelTicket] = useState(null);
  const [resolveTicket, setResolveTicket] = useState(null);

  const perms = { canAssign, canManage, canResolve, canClose };
  const showActions = canAssign || canManage || canResolve || canClose;
  const sel = selected || new Set();
  const pageIds = (list.data || []).map((t) => t.id);
  const allSelected = pageIds.length > 0 && pageIds.every((id) => sel.has(id));
  const someSelected = pageIds.some((id) => sel.has(id));
  const inFlight = (id) => Boolean(pendingIds?.has(id));

  // "Resolver" nunca envía un PATCH: /resolve exige la solución y aplica la
  // auditoría que el PATCH genérico no hace. El diálogo se abre aquí, en la
  // fila, y entrega el texto a `onStatusChange` una vez escrito.
  const requestStatus = (t, status, body) => {
    if (status === 'RESOLVED') {
      setResolveTicket(t);
      return undefined;
    }
    return onStatusChange?.(t, status, body);
  };

  // Los botones y el menú disparan la acción sin esperarla, así que su rechazo
  // se absorbe aquí para no dejar rechazos sueltos: el error lo pinta la
  // pantalla en su `ErrorBox`. El diálogo de resolución es la excepción, porque
  // sí espera la promesa y necesita el fallo para no perder lo escrito.
  const fire = (promise) => {
    promise?.catch?.(() => {});
  };

  if (!list.data?.length) {
    return (
      <div className="card">
        {emptyState || <EmptyState icon="🎫" title="No hay tickets" subtitle="No se encontraron tickets con los criterios seleccionados." />}
      </div>
    );
  }

return (
    <div className="card table-compact overflow-hidden">
      {/* `table-fixed` hace que manden las anchuras declaradas en la cabecera en
          lugar del contenido: sin esto cada columna se ensancha hasta lo que
          ocupa su texto más largo y la Bandeja acaba con scroll horizontal en
          cualquier portátil. El ancho sobrante lo absorbe Título, la única
          columna sin ancho fijo, porque es la única que puede recortarse sin
          perder información (con `title` y elipsis).

          El presupuesto no es inventado: el contenedor real es `main` con
          `lg:pl-64` y `max-w-7xl`, así que da 960 px a 1280 de pantalla y
          1216 px como techo. Las columnas fijas suman 832 px en el tramo xl
          (casilla 32 + ticket 112 + solicitante 112 + prioridad 96 + estado
          112 + SLA 112 + actividad 96 + acciones 160), dejando 128 px de
          título a 1280 y 384 px a 1920. `min-w` protege el ancho de las
          columnas frente a un contenedor estrecho; por debajo de él la tabla
          se desplaza, que es lo único que justifica el scroll horizontal. */}
      <div className="overflow-x-auto">
        <table className="table-fixed w-full min-w-[32rem] lg:min-w-[54rem]">
          <thead className="border-b border-slate-200 bg-slate-50">
            <tr>
              {selectable && (
                <th className="th w-8">
                  <input
                    type="checkbox"
                    className="h-4 w-4 cursor-pointer rounded"
                    checked={allSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = !allSelected && someSelected;
                    }}
                    onChange={(e) => onToggleAll?.(pageIds, e.target.checked)}
                    aria-label="Seleccionar todos los de la página"
                  />
                </th>
              )}
              <SortHeader col="ticket_number" label="Ticket" sort={sort} dir={dir} onSort={onSort} className="w-28" />
              {/* Sin `w-*`: con `table-fixed` es la columna que se queda con todo
                  el espacio que sobra, y su texto ya trunca con elipsis. */}
              <th className="th">Título</th>
              {/* Categoría aparece sólo en `2xl` porque su dato no se pierde:
                  la segunda línea del título lo repite siempre. */}
              <th className="th hidden 2xl:table-cell w-20">Categoría</th>
              <th className="th hidden xl:table-cell w-28">Solicitante</th>
              <SortHeader col="priority" label="Prioridad" sort={sort} dir={dir} onSort={onSort} className="w-24" />
              <SortHeader col="status" label="Estado" sort={sort} dir={dir} onSort={onSort} className="w-28" />
              <SortHeader col="sla" label="SLA" sort={sort} dir={dir} onSort={onSort} className="hidden lg:table-cell w-28" />
              <SortHeader col="updated_at" label="Actividad" sort={sort} dir={dir} onSort={onSort} className="hidden md:table-cell w-24" />
              {/* El ancho de Acciones acompaña a las acciones visibles: una
                  primaria + menú por debajo de `2xl`, y las dos por encima. */}
              {showActions && <th className="th w-40 2xl:w-56 text-right">Acciones</th>}
            </tr>
          </thead>

          <tbody className="divide-y divide-slate-100">
            {list.data.map((t) => {
              const isSelected = sel.has(t.id);
              const pending = inFlight(t.id);
              // La urgencia (vencido / vence pronto) se marca con una barra junto al
              // número, no pintando la fila entera: el fondo rojo completo
              // volvía la tabla ilegible y hacía que un ticket ya cerrado
              // siguiera pareciendo fuera de plazo. La barra lleva su
              // `aria-label`, así que el aviso no depende sólo del color ni de la
              // columna SLA, que en pantallas estrechas se oculta.
              // `priority === 'CRITICAL'` no lleva guarda de estado a propósito: la
              // prioridad es una propiedad permanente del ticket, no una alarma, y
              // consultarla sigue siendo útil al revisar un ticket cerrado.
              const level = slaLevel(t);
              const flag =
                level === 'overdue' ? ROW_FLAG.overdue
                : t.priority === 'CRITICAL' ? ROW_FLAG.critical
                : level === 'at_risk' ? ROW_FLAG.at_risk
                : null;
              // Las acciones dependen del estado real y de los permisos reales.
              // La función vive en lib/ticketActions.js: Bandeja y "Todos los
              // tickets" comparten esta misma tabla, así que comparten criterio.
              const quickActions = quickActionsFor(t, perms, currentUserId);
              // Segunda línea del título: categoría y contadores. Es la razón por
              // la que la columna Categoría puede truncarse (y ocultarse en
              // anchos pequeños) sin perder ese dato.
              const subTitle = [
                t.category_name || 'Sin categoría',
                t.comment_count ? `${t.comment_count} comentario(s)` : null,
                t.attachment_count ? `${t.attachment_count} adjunto(s)` : null,
              ]
                .filter(Boolean)
                .join(' · ');
              return (
              <tr key={t.id} className={`transition hover:bg-slate-50 ${isSelected ? 'bg-brand-50' : ''}`}>
                {selectable && (
                  <td className="td w-8">
                    <input
                      type="checkbox"
                      className="h-4 w-4 cursor-pointer rounded"
                      checked={isSelected}
                      onChange={() => onToggle?.(t.id)}
                      aria-label={`Seleccionar ${t.ticket_number}`}
                    />
                  </td>
                )}
                <td className="td font-semibold text-brand-600">
                  <span className="inline-flex items-center gap-2">
                    {flag && (
                      <Tooltip text={flag.label} describe={false}>
                        <span className={`h-4 w-1 shrink-0 rounded-full ${flag.bar}`} role="img" aria-label={flag.label} />
                      </Tooltip>
                    )}
                    <Link to={`${basePath}/${t.id}`} className="truncate hover:underline">
                      {t.ticket_number}
                    </Link>
                  </span>
                </td>
                {/* Con `table-fixed` esta celda se estira al ancho sobrante: el
                    `truncate` de dentro deja elipsis y el `title` conserva el
                    texto íntegro al pasar el ratón. */}
                <td className="td w-full">
                  <Link
                    to={`${basePath}/${t.id}`}
                    className="block truncate font-medium text-slate-800 hover:text-brand-700"
                    title={t.title}
                  >
                    {t.title}
                  </Link>
                  <span className="block truncate text-xs text-slate-400" title={subTitle}>
                    {subTitle}
                  </span>
                </td>
                <td className="td hidden 2xl:table-cell">
                  {t.category_name ? (
                    <span className="flex items-center gap-2" title={t.category_name}>
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: t.category_color || '#64748b' }} />
                      <span className="truncate text-slate-600">{t.category_name}</span>
                    </span>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </td>
                <td className="td hidden xl:table-cell">
                  <span className="flex items-center gap-2">
                    <Avatar name={t.reporter_name || ''} size="sm" />
                    <span className="truncate text-slate-600" title={t.reporter_name || undefined}>{t.reporter_name}</span>
                  </span>
                </td>
                <td className="td">
                  <PriorityBadge priority={t.priority} />
                </td>
                <td className="td">
                  <StatusBadge status={t.status} />
                </td>
                <td className="td hidden lg:table-cell">
                  <SlaCell ticket={t} />
                </td>
                <td className="td hidden text-slate-500 md:table-cell">
                  <LastActivityCell ticket={t} />
                </td>
                {showActions && (
                  <td className="td text-right">
                    <span className="inline-flex items-center justify-end gap-1">
                      {quickActions.map((action, i) => (
                        <button
                          key={action.key}
                          type="button"
                          // La primera acción es la primaria del estado y siempre
                          // se ve. Las secundarias sólo salen en pantallas
                          // anchas: en el resto siguen accesibles por el menú ⋯,
                          // que no duplica esta lógica, la recalcula con
                          // `menuItemsFor`. Es el mismo ancho que el de la
                          // columna (w-28 / 2xl:w-52), que es lo que evita que
                          // la tabla crezca por la derecha.
                          className={`whitespace-nowrap !px-2 !py-1 !text-xs ${
                            i === 0
                              ? 'btn-primary inline-flex'
                              : 'btn-secondary hidden 2xl:inline-flex'
                          }`}
                          disabled={pending}
                          aria-label={`${action.label} ${t.ticket_number}`}
                          onClick={() => {
                            if (action.kind === 'assign') onAssignMe?.(t);
                            else fire(requestStatus(t, action.status));
                          }}
                        >
                          {pending ? <Spinner className="h-3.5 w-3.5 text-white" /> : action.label}
                        </button>
                      ))}
                      <Menu
                        label={pending ? <Spinner className="h-3.5 w-3.5 text-slate-400" /> : '⋯'}
                        disabled={pending}
                        // Con el spinner el botón se quedaría sin nombre accesible, así que
                        // mientras vuela se anuncia explícitamente.
                        ariaLabel={pending ? `Actualizando ${t.ticket_number}` : undefined}
                        buttonClass="rounded-lg border border-slate-200 px-1.5 py-1 text-slate-500 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                        items={menuItemsFor(t, perms, {
                          currentUserId,
                          onView: () => navigate(`${basePath}/${t.id}`),
                          onAssignMe: () => onAssignMe?.(t),
                          onStatusChange: (t2, status, body) => fire(requestStatus(t2, status, body)),
                          onCancel: () => setCancelTicket(t),
                        })}
                      />
                    </span>
                  </td>
                )}
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Pagination page={list.page} pages={list.pages} total={list.total} onChange={onPage} perPage={perPage || list.perPage} onPerPage={onPerPage} />
      {cancelTicket && (
        // La promesa se devuelve SIN pasar por `fire()`, igual que hace
        // `ResolveTicketModal` dos líneas más abajo. `CancelTicketDialog` la
        // espera en un `try/catch` para conservar el motivo escrito y explicar el
        // fallo dentro del diálogo; si el rechazo se traga aquí, ese `catch` no
        // entra nunca, el diálogo se cierra igual y el técnico creería haber
        // cancelado un ticket que el servidor no tocó.
        //
        // `onErrorShown={onClearError}` deja el mensaje en un solo sitio: el
        // diálogo lo muestra y la página retira su `ErrorBox`. Sin esta prop el
        // comportamiento sería el de siempre, con el error visible en ambos.
        <CancelTicketDialog ticket={cancelTicket} onClose={() => setCancelTicket(null)} onSubmit={(body) => onStatusChange?.(cancelTicket, 'CANCELLED', body)} onErrorShown={onClearError} />
      )}
      {resolveTicket && (
        <ResolveTicketModal
          ticket={resolveTicket}
          busy={inFlight(resolveTicket.id)}
          onClose={() => setResolveTicket(null)}
          onSubmit={(resolution) => onStatusChange?.(resolveTicket, 'RESOLVED', { resolution })}
        />
      )}
    </div>
  );
}