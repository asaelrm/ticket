import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { api, formatDateTime } from '../lib/api';
import { ErrorBox, LoadingScreen, EmptyState, Pagination } from '../components/ui';

const ACTION_LABEL = {
  CREATED: 'Creación',
  ATTACHMENT_ADDED: 'Adjunto',
  STATUS_CHANGED: 'Cambio de estado',
  REOPENED: 'Reapertura',
  PENDING_REASON_SET: 'Pendiente',
  PRIORITY_CHANGED: 'Prioridad',
  CATEGORY_CHANGED: 'Categoría',
  ASSIGNED: 'Asignación',
  ASSIGNED_TEAM: 'Asignación a equipo',
  UPDATED: 'Actualización',
  NOTE_ADDED: 'Nota interna',
  COMMENT_ADDED: 'Comentario',
  RESOLVED: 'Resolución',
  CLOSED: 'Cierre',
  CANCELLED: 'Cancelación',
  CSAT_RATED: 'Encuesta CSAT',
  ESCALATED: 'Escalación automática',
};

function actionBadge(action) {
  const tones = {
    CREATED: 'bg-slate-100 text-slate-600 ring-slate-500/20',
    ATTACHMENT_ADDED: 'bg-slate-100 text-slate-600 ring-slate-500/20',
    STATUS_CHANGED: 'bg-blue-50 text-blue-700 ring-blue-600/20',
    REOPENED: 'bg-amber-50 text-amber-700 ring-amber-600/20',
    PENDING_REASON_SET: 'bg-purple-50 text-purple-700 ring-purple-600/20',
    PRIORITY_CHANGED: 'bg-orange-50 text-orange-700 ring-orange-600/20',
    CATEGORY_CHANGED: 'bg-sky-50 text-sky-700 ring-sky-600/20',
    ASSIGNED: 'bg-indigo-50 text-indigo-700 ring-indigo-600/20',
    ASSIGNED_TEAM: 'bg-indigo-50 text-indigo-700 ring-indigo-600/20',
    UPDATED: 'bg-slate-100 text-slate-600 ring-slate-500/20',
    NOTE_ADDED: 'bg-amber-50 text-amber-700 ring-amber-600/20',
    COMMENT_ADDED: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
    RESOLVED: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
    CLOSED: 'bg-slate-100 text-slate-600 ring-slate-500/20',
    CANCELLED: 'bg-red-50 text-red-700 ring-red-600/20',
    CSAT_RATED: 'bg-amber-50 text-amber-700 ring-amber-600/20',
    ESCALATED: 'bg-red-50 text-red-700 ring-red-600/20',
  };
  return tones[action] || 'bg-slate-100 text-slate-600 ring-slate-500/20';
}

const INITIAL_FILTERS = { search: '', action: '', user: '', from: '', to: '', page: 1, perPage: 10 };

export default function Audit() {
  // filters controla el form; applied es lo realmente consultado (solo cambia al enviar/paginar).
  const [filters, setFilters] = useState(INITIAL_FILTERS);
  const [applied, setApplied] = useState(INITIAL_FILTERS);

  const { data: list, error: queryError } = useQuery({
    queryKey: ['audit', applied],
    queryFn: async () => {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(applied)) {
        if (v !== '' && v != null) params.append(k, v);
      }
      return api.get(`/api/audit?${params}`);
    },
    // Conserva la tabla anterior al paginar (el original no limpiaba la lista).
    placeholderData: keepPreviousData,
  });

  const { data: users = [] } = useQuery({
    queryKey: ['audit-users'],
    queryFn: () => api.get('/api/users').then((d) => d.data || []),
    retry: false,
  });

  const applyFilter = (patch) => {
    setApplied((p) => ({ ...p, ...patch }));
    setFilters((p) => ({ ...p, ...patch }));
  };

  return (
    <div className="space-y-4">
      <div className="card p-4">
        <form
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6"
          onSubmit={(e) => {
            e.preventDefault();
            applyFilter({ ...filters, page: 1 });
          }}
        >
          <label className="label lg:col-span-2">
            Búsqueda
            <input
              className="input"
              placeholder="Ticket, título o detalle…"
              value={filters.search}
              onChange={(e) => setFilters({ ...filters, search: e.target.value })}
            />
          </label>
          <label className="label">
            Acción
            <select
              className="input"
              value={filters.action}
              onChange={(e) => setFilters({ ...filters, action: e.target.value })}
            >
              <option value="">Todas</option>
              {(list?.actions || []).map((a) => (
                <option key={a} value={a}>
                  {ACTION_LABEL[a] || a}
                </option>
              ))}
            </select>
          </label>
          <label className="label">
            Usuario
            <select
              className="input"
              value={filters.user}
              onChange={(e) => setFilters({ ...filters, user: e.target.value })}
            >
              <option value="">Todos</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} {u.last_name}
                </option>
              ))}
            </select>
          </label>
          <label className="label">
            Desde
            <input type="date" className="input" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} />
          </label>
          <label className="label">
            Hasta
            <input type="date" className="input" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} />
          </label>
          <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-6">
            <button type="submit" className="btn-primary">
              Filtrar
            </button>
            <button type="button" className="btn-secondary" onClick={() => setFilters(INITIAL_FILTERS)}>
              Limpiar
            </button>
          </div>
        </form>
      </div>

      {queryError && <ErrorBox message={queryError.message || 'No se pudieron cargar los registros'} />}

      {!list ? (
        <LoadingScreen text="Cargando auditoría…" />
      ) : list.data.length === 0 ? (
        <EmptyState icon="📜" title="Sin registros" subtitle="No se encontraron cambios con los criterios seleccionados." />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
                <tr>
                  <th className="th">Fecha</th>
                  <th className="th">Usuario</th>
                  <th className="th">Ticket</th>
                  <th className="th">Acción</th>
                  <th className="th">Detalle</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {list.data.map((h) => (
                  <tr key={h.id} className="align-top hover:bg-slate-50">
                    <td className="td whitespace-nowrap text-slate-500">{formatDateTime(h.created_at)}</td>
                    <td className="td whitespace-nowrap text-slate-700">{h.user_name || '—'}</td>
                    <td className="td whitespace-nowrap">
                      <Link to={`/app/tickets/${h.ticket_id}`} className="font-mono text-brand-700 hover:underline">
                        {h.ticket_number}
                      </Link>
                    </td>
                    <td className="td whitespace-nowrap">
                      <span className={`badge ring-1 ${actionBadge(h.action)}`}>{ACTION_LABEL[h.action] || h.action}</span>
                    </td>
                    <td className="td">
                      <p className="text-slate-700">{h.description}</p>
                      {h.old_value !== null && h.old_value !== undefined && h.new_value !== null && h.new_value !== undefined && (
                        <p className="mt-0.5 break-all font-mono text-xs text-slate-400">
                          {h.old_value} → {h.new_value}
                        </p>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={list.page}
            pages={list.pages}
            total={list.total}
            perPage={list.perPage}
            onChange={(page) => applyFilter({ page })}
            onPerPage={(perPage) => applyFilter({ perPage, page: 1 })}
          />
        </div>
      )}
    </div>
  );
}