import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { formatRelative, formatSla, slaInfo, slaLevel } from '../lib/api';
import { EmptyState, Pagination, Menu, Avatar, Modal, StatusBadge, PriorityBadge, Spinner } from './ui';

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
// `text-red-600`, ámbar de `text-amber-600`, verde de `bg-emerald-500`). La
// urgencia se marca en la franja y en la columna, no tiñendo la fila entera:
// el fondo sólo insinúa el retraso y el texto se sigue leyendo igual.
const SLA_TONE = {
  overdue: { text: 'text-red-600', dot: 'bg-red-500' },
  at_risk: { text: 'text-amber-600', dot: 'bg-amber-500' },
  ok: { text: 'text-slate-500', dot: 'bg-emerald-500' },
};

// Marca lateral de la fila. Su `label` también es el texto alternativo, para
// que la urgencia no dependa sólo del color ni de la columna SLA, que en
// pantallas estrechas se oculta.
const ROW_FLAG = {
  overdue: { bar: 'bg-red-500', label: 'Fuera de plazo' },
  critical: { bar: 'bg-red-500', label: 'Prioridad crítica' },
  at_risk: { bar: 'bg-amber-500', label: 'Vence pronto' },
};

function SlaCell({ ticket }) {
  const info = slaInfo(ticket);
  if (!info) return <span className="text-slate-400">—</span>;
  const tone = SLA_TONE[slaLevel(ticket)] || SLA_TONE.ok;
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium ${tone.text}`} title={info.due.toLocaleString('es-ES')}>
      <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
      {formatSla(ticket)}
    </span>
  );
}

function CancelTicketDialog({ ticket, onClose, onSubmit }) {
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
      {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
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
}) {
  const navigate = useNavigate();
  const [cancelTicket, setCancelTicket] = useState(null);

  const showActions = canAssign || canManage;
  const sel = selected || new Set();
  const pageIds = (list.data || []).map((t) => t.id);
  const allSelected = pageIds.length > 0 && pageIds.every((id) => sel.has(id));
  const someSelected = pageIds.some((id) => sel.has(id));
  const inFlight = (id) => Boolean(pendingIds?.has(id));

  if (!list.data?.length) {
    return (
      <div className="card">
        {emptyState || <EmptyState icon="🎫" title="No hay tickets" subtitle="No se encontraron tickets con los criterios seleccionados." />}
      </div>
    );
  }

  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="border-b border-slate-200 bg-slate-50">
            <tr>
              {selectable && (
                <th className="th w-10">
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
              <SortHeader col="ticket_number" label="Ticket" sort={sort} dir={dir} onSort={onSort} />
              <th className="th">Título</th>
              <th className="th hidden lg:table-cell">Categoría</th>
              <th className="th hidden xl:table-cell">Solicitante</th>
              <SortHeader col="priority" label="Prioridad" sort={sort} dir={dir} onSort={onSort} />
              <SortHeader col="status" label="Estado" sort={sort} dir={dir} onSort={onSort} />
              <th className="th hidden md:table-cell">SLA</th>
              <SortHeader col="updated_at" label="Actualizado" sort={sort} dir={dir} onSort={onSort} className="hidden sm:table-cell" />
              {showActions && <th className="th text-right">Acciones</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {list.data.map((t) => {
              const isSelected = sel.has(t.id);
              const pending = inFlight(t.id);
              const level = slaLevel(t);
              // Crítico o fuera de plazo se marcan con una franja; el resto de la
              // fila conserva su fondo para que siga leyéndose con normalidad.
              const flag =
                level === 'overdue' ? ROW_FLAG.overdue
                : t.priority === 'CRITICAL' ? ROW_FLAG.critical
                : level === 'at_risk' ? ROW_FLAG.at_risk
                : null;
              // "Tomar ticket" es la acción de un ticket sin dueño. Reasignarse uno
              // que ya tiene técnico sigue estando en el menú, así que aquí no se
              // duplica la misma operación con dos nombres.
              const canTake = canAssign && !t.assigned_to_id;
              return (
              <tr key={t.id} className={`transition hover:bg-slate-50 ${isSelected ? 'bg-brand-50' : t.is_overdue ? 'bg-red-50/40' : ''}`}>
                {selectable && (
                  <td className="td w-10">
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
                      <span className={`h-4 w-1 shrink-0 rounded-full ${flag.bar}`} role="img" aria-label={flag.label} />
                    )}
                    <Link to={`${basePath}/${t.id}`} className="hover:underline">
                      {t.ticket_number}
                    </Link>
                  </span>
                </td>
                <td className="td max-w-[280px]">
                  <Link to={`${basePath}/${t.id}`} className="block truncate font-medium text-slate-800 hover:text-brand-700">
                    {t.title}
                  </Link>
                  <span className="block truncate text-xs text-slate-400">
                    {t.category_name || 'Sin categoría'}
                    {t.comment_count ? ` · ${t.comment_count} comentario(s)` : ''}
                    {t.attachment_count ? ` · ${t.attachment_count} adjunto(s)` : ''}
                  </span>
                </td>
                <td className="td hidden whitespace-nowrap lg:table-cell">
                  {t.category_name ? (
                    <span className="inline-flex items-center gap-1.5 text-slate-600">
                      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: t.category_color || '#64748b' }} />
                      {t.category_name}
                    </span>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </td>
                <td className="td hidden whitespace-nowrap xl:table-cell">
                  <span className="flex items-center gap-2">
                    <Avatar name={t.reporter_name || ''} size="sm" />
                    <span className="text-slate-600">{t.reporter_name}</span>
                  </span>
                </td>
                <td className="td whitespace-nowrap">
                  <PriorityBadge priority={t.priority} />
                </td>
                <td className="td whitespace-nowrap">
                  <StatusBadge status={t.status} />
                </td>
                <td className="td hidden whitespace-nowrap md:table-cell">
                  <SlaCell ticket={t} />
                </td>
                <td className="td hidden whitespace-nowrap text-slate-500 sm:table-cell">{formatRelative(t.updated_at)}</td>
                {showActions && (
                  <td className="td text-right">
                    <span className="inline-flex items-center justify-end gap-1.5">
                      {canTake && (
                        <button
                          type="button"
                          className="btn-secondary whitespace-nowrap !px-2 !py-1 !text-xs"
                          disabled={pending}
                          onClick={() => onAssignMe?.(t)}
                          aria-label={`Tomar ticket ${t.ticket_number}`}
                        >
                          {pending ? <Spinner className="h-3.5 w-3.5 text-white" /> : 'Tomar ticket'}
                        </button>
                      )}
                      <Menu
                        label={pending ? <Spinner className="h-3.5 w-3.5 text-slate-400" /> : '⋯'}
                        disabled={pending}
                        buttonClass="rounded-lg border border-slate-200 px-2 py-1 text-slate-500 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                        items={[
                          { key: 'view', label: 'Ver detalle', icon: '🔎', onClick: () => navigate(`${basePath}/${t.id}`) },
                          canAssign && t.assigned_to_id && { key: 'me', label: 'Asignarme a mí', icon: '🙋', onClick: () => onAssignMe?.(t) },
                          canManage && t.status !== 'IN_PROGRESS' && { key: 'prog', label: 'Marcar en proceso', icon: '⏳', onClick: () => onStatusChange?.(t, 'IN_PROGRESS') },
                          canManage && t.status !== 'RESOLVED' && { key: 'res', label: 'Marcar resuelto', icon: '✅', onClick: () => onStatusChange?.(t, 'RESOLVED') },
                          canManage && t.status !== 'CLOSED' && { key: 'close', label: 'Cerrar ticket', icon: '📁', onClick: () => onStatusChange?.(t, 'CLOSED') },
                          canManage && { key: 'sep', separator: true },
                          canManage && { key: 'cancel', label: 'Cancelar ticket', icon: '🚫', danger: true, onClick: () => setCancelTicket(t) },
                        ]}
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
        <CancelTicketDialog ticket={cancelTicket} onClose={() => setCancelTicket(null)} onSubmit={(body) => onStatusChange?.(cancelTicket, 'CANCELLED', body)} />
      )}
    </div>
  );
}
