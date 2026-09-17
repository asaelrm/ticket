import { Link } from 'react-router-dom';
import { formatDate, PRIORITY_LABEL, STATUS_LABEL } from '../lib/api';
import { EmptyState, Pagination } from './ui';

export function TicketTable({ list, basePath = '/app/my-tickets', onPage }) {
  if (!list.data?.length) {
    return <EmptyState icon="🎫" title="No hay tickets" subtitle="No se encontraron tickets con los criterios seleccionados." />;
  }

  return (
    <div className="card">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="border-b border-slate-200 bg-slate-50">
            <tr>
              <th className="th">Ticket</th>
              <th className="th">Fecha</th>
              <th className="th">Título</th>
              <th className="th">Categoría</th>
              <th className="th">Prioridad</th>
              <th className="th">Estado</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {list.data.map((t) => (
              <tr key={t.id} className="transition hover:bg-slate-50">
                <td className="td font-semibold text-brand-600">
                  <Link to={`${basePath}/${t.id}`} className="hover:underline">
                    {t.ticket_number}
                  </Link>
                </td>
                <td className="td whitespace-nowrap text-slate-500">{formatDate(t.created_at)}</td>
                <td className="td max-w-[260px]">
                  <Link to={`${basePath}/${t.id}`} className="block truncate font-medium text-slate-800 hover:text-brand-700">
                    {t.title}
                  </Link>
                  {t.reporter_name && (
                    <span className="block truncate text-xs text-slate-400">{t.reporter_name}</span>
                  )}
                </td>
                <td className="td whitespace-nowrap">
                  {t.category_name ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: t.category_color || '#64748b' }} />
                      {t.category_name}
                    </span>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </td>
                <td className="td whitespace-nowrap">
                  <span title={PRIORITY_LABEL[t.priority]}>
                    <span
                      className={`inline-block h-2 w-2 rounded-full ${
                        { LOW: 'bg-slate-400', MEDIUM: 'bg-sky-500', HIGH: 'bg-orange-500', CRITICAL: 'bg-red-600' }[t.priority]
                      }`}
                    />
                    <span className="ml-1.5 text-slate-600">{PRIORITY_LABEL[t.priority]}</span>
                  </span>
                </td>
                <td className="td whitespace-nowrap">
                  <span
                    className={`badge ring-1 ${
                      {
                        OPEN: 'bg-blue-50 text-blue-700 ring-blue-600/20',
                        ASSIGNED: 'bg-indigo-50 text-indigo-700 ring-indigo-600/20',
                        IN_PROGRESS: 'bg-amber-50 text-amber-700 ring-amber-600/20',
                        PENDING: 'bg-purple-50 text-purple-700 ring-purple-600/20',
                        RESOLVED: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
                        CLOSED: 'bg-slate-100 text-slate-600 ring-slate-500/20',
                        CANCELLED: 'bg-red-50 text-red-700 ring-red-600/20',
                      }[t.status]
                    }`}
                  >
                    {STATUS_LABEL[t.status]}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination page={list.page} pages={list.pages} total={list.total} onChange={onPage} />
    </div>
  );
}