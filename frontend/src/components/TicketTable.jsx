import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { formatRelative, formatSla, slaInfo } from '../lib/api';
import { EmptyState, Pagination, Menu, Avatar, Modal, StatusBadge, PriorityBadge } from './ui';

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

function SlaCell({ ticket }) {
  const info = slaInfo(ticket);
  if (!info) return <span className="text-slate-400">—</span>;
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium ${
        info.overdue ? 'text-red-600' : info.hours < 8 ? 'text-amber-600' : 'text-slate-500'
      }`}
      title={info.due.toLocaleString('es-ES')}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${info.overdue ? 'bg-red-500' : info.hours < 8 ? 'bg-amber-500' : 'bg-emerald-500'}`} />
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
}) {
  const navigate = useNavigate();
  const [cancelTicket, setCancelTicket] = useState(null);

  const showActions = canAssign || canManage;
  const sel = selected || new Set();
  const pageIds = (list.data || []).map((t) => t.id);
  const allSelected = pageIds.length > 0 && pageIds.every((id) => sel.has(id));
  const someSelected = pageIds.some((id) => sel.has(id));

  if (!list.data?.length) {
    return (
      <EmptyState icon="🎫" title="No hay tickets" subtitle="No se encontraron tickets con los criterios seleccionados." />
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
                  <Link to={`${basePath}/${t.id}`} className="hover:underline">
                    {t.ticket_number}
                  </Link>
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
                    <Menu
                      label="⋯"
                      buttonClass="rounded-lg border border-slate-200 px-2 py-1 text-slate-500 transition hover:bg-slate-100"
                      items={[
                        { key: 'view', label: 'Ver detalle', icon: '🔎', onClick: () => navigate(`${basePath}/${t.id}`) },
                        canAssign && { key: 'me', label: 'Asignarme a mí', icon: '🙋', onClick: () => onAssignMe?.(t) },
                        canManage && t.status !== 'IN_PROGRESS' && { key: 'prog', label: 'Marcar en proceso', icon: '⏳', onClick: () => onStatusChange?.(t, 'IN_PROGRESS') },
                        canManage && t.status !== 'RESOLVED' && { key: 'res', label: 'Marcar resuelto', icon: '✅', onClick: () => onStatusChange?.(t, 'RESOLVED') },
                        canManage && t.status !== 'CLOSED' && { key: 'close', label: 'Cerrar ticket', icon: '📁', onClick: () => onStatusChange?.(t, 'CLOSED') },
                        canManage && { key: 'sep', separator: true },
                        canManage && { key: 'cancel', label: 'Cancelar ticket', icon: '🚫', danger: true, onClick: () => setCancelTicket(t) },
                      ]}
                    />
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
