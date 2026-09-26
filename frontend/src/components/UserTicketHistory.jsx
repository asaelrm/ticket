import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { api, formatDateTime, formatSla, OPEN_STATUSES } from '../lib/api';
import { StatusBadge, PriorityBadge, EmptyState, Spinner, ErrorBox } from './ui';

export default function UserTicketHistory({ userId, self = false, perPage = 8 }) {
  const [scope, setScope] = useState('reported');
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
  }, [scope, userId]);

  const { data, isPending, error } = useQuery({
    queryKey: ['user-ticket-history', userId, scope, page, perPage],
    queryFn: () => api.get(`/api/users/${userId}/tickets?scope=${scope}&page=${page}&perPage=${perPage}`),
    enabled: !!userId,
    // Conserva el historial previo al cambiar de pestaña/página mientras carga la nueva.
    placeholderData: keepPreviousData,
  });

  const byStatus = data?.by_status || {};
  const openCount = OPEN_STATUSES.reduce((acc, s) => acc + (byStatus[s] || 0), 0);
  const closedCount = (byStatus.RESOLVED || 0) + (byStatus.CLOSED || 0);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5">
          <Tab active={scope === 'reported'} onClick={() => setScope('reported')}>
            {self ? 'Reportados por mí' : 'Reportados'}
          </Tab>
          <Tab active={scope === 'assigned'} onClick={() => setScope('assigned')}>
            {self ? 'Asignados a mí' : 'Asignados'}
          </Tab>
        </div>
        {data && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-600">{data.total} en total</span>
            <span className="rounded-full bg-blue-50 px-2 py-0.5 font-medium text-blue-700">{openCount} abiertos</span>
            <span className="rounded-full bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700">{closedCount} cerrados</span>
          </div>
        )}
      </div>

      {error && <ErrorBox message={error.message || 'No se pudo cargar el historial'} />}

      {!userId ? (
        <EmptyState icon="🎫" title="Sin tickets" subtitle="No hay tickets en este historial." />
      ) : isPending && !data ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : !data || data.data.length === 0 ? (
        <EmptyState icon="🎫" title="Sin tickets" subtitle="No hay tickets en este historial." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full">
            <thead className="bg-slate-50">
              <tr>
                <th className="th">Número</th>
                <th className="th">Título</th>
                <th className="th">Estado</th>
                <th className="th">Prioridad</th>
                <th className="th">Categoría</th>
                <th className="th">Creado</th>
                <th className="th">SLA</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.data.map((t) => (
                <tr key={t.id} className="hover:bg-slate-50">
                  <td className="td whitespace-nowrap font-mono text-xs font-semibold text-brand-700">
                    <Link to={`/app/tickets/${t.id}`} className="hover:underline">
                      {t.ticket_number}
                    </Link>
                  </td>
                  <td className="td max-w-[240px]">
                    <Link to={`/app/tickets/${t.id}`} className="line-clamp-1 font-medium text-slate-800 hover:underline">
                      {t.title}
                    </Link>
                  </td>
                  <td className="td"><StatusBadge status={t.status} /></td>
                  <td className="td"><PriorityBadge priority={t.priority} /></td>
                  <td className="td text-slate-600">
                    {t.category_name ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: t.category_color }} />
                        {t.category_name}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="td whitespace-nowrap text-slate-500">{formatDateTime(t.created_at)}</td>
                  <td className="td whitespace-nowrap">
                    {OPEN_STATUSES.includes(t.status) ? (
                      <span className={t.is_overdue ? 'text-xs font-semibold text-red-600' : 'text-xs text-slate-500'}>
                        {formatSla(t)}
                      </span>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.pages > 1 && (
        <div className="mt-3 flex items-center justify-between text-sm text-slate-500">
          <span>Página {data.page} de {data.pages}</span>
          <div className="flex gap-2">
            <button className="btn-secondary !px-3 !py-1.5" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              ← Anterior
            </button>
            <button className="btn-secondary !px-3 !py-1.5" disabled={page >= data.pages} onClick={() => setPage((p) => p + 1)}>
              Siguiente →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Tab({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
        active ? 'bg-white text-brand-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'
      }`}
    >
      {children}
    </button>
  );
}