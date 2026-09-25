import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, download, VIEWS, CLOSED_PERIODS, SORT_OPTIONS } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { TicketTable } from '../components/TicketTable';
import AdvancedSearchModal, { ADVANCED_KEYS } from '../components/AdvancedSearchModal';
import { LoadingScreen, ErrorBox, Spinner, Menu } from '../components/ui';

const DEFAULTS = { sort: 'created_at', dir: 'desc', perPage: 15, page: 1 };

function parseFilters(searchParams) {
  const o = Object.fromEntries(searchParams.entries());
  return {
    view: o.view || '',
    search: o.search || '',
    status: o.status || '',
    priority: o.priority || '',
    category: o.category || '',
    department: o.department || '',
    user: o.user || '',
    assigned: o.assigned || '',
    team: o.team || '',
    period: o.period || '',
    date: o.date || '',
    from: o.from || '',
    to: o.to || '',
    closed_period: o.closed_period || '',
    closed_from: o.closed_from || '',
    closed_to: o.closed_to || '',
    sort: o.sort || DEFAULTS.sort,
    dir: o.dir || DEFAULTS.dir,
    page: Number(o.page) || 1,
    perPage: Number(o.perPage) || DEFAULTS.perPage,
  };
}

export default function Tickets() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => parseFilters(searchParams), [searchParams]);

  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const canExport = user?.permissions?.includes('ticket.export');
  const canAssign = user?.permissions?.includes('ticket.assign');
  const canManage = user?.permissions?.includes('ticket.update.any');

  const update = useCallback(
    (partial, { replace = false } = {}) => {
      const next = { ...filters, ...partial };
      if (!('page' in partial)) next.page = 1;
      const sp = new URLSearchParams();
      for (const [k, v] of Object.entries(next)) {
        if (v === '' || v == null) continue;
        if (k in DEFAULTS && String(DEFAULTS[k]) === String(v)) continue;
        sp.set(k, String(v));
      }
      setSearchParams(sp, { replace });
    },
    [filters, setSearchParams]
  );

  const query = useMemo(() => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) {
      if (v !== '' && v != null) sp.set(k, String(v));
    }
    return sp.toString();
  }, [filters]);

  const { data: list, error: queryError } = useQuery({
    queryKey: ['tickets', query],
    queryFn: () => api.get(`/api/tickets?${query}`),
    // Refresco silencioso en vivo cada 30 s (React Query pausa en background, equivalente al chequeo de visibilidad).
    refetchInterval: 30000,
  });

  const { data: counters } = useQuery({
    queryKey: ['tickets-counters'],
    queryFn: () => api.get('/api/tickets/counters').catch(() => null),
    refetchInterval: 30000,
  });

  // Equivale al efecto [reload]: al cambiar filtros se limpia el error previo y se refrescan los contadores.
  useEffect(() => {
    setError('');
    queryClient.invalidateQueries({ queryKey: ['tickets-counters'] });
  }, [query, queryClient]);

  const reload = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['tickets'] });
    queryClient.invalidateQueries({ queryKey: ['tickets-counters'] });
  }, [queryClient]);

  const advancedCount = ADVANCED_KEYS.filter((k) => filters[k]).length;

  function chipActive(key) {
    if (key === 'all') return !filters.view && !filters.status;
    if (key === 'in_progress') return !filters.view && filters.status === 'IN_PROGRESS';
    return filters.view === key;
  }

  function onChip(v) {
    if (v.view === false) return update({ view: '', status: 'IN_PROGRESS' });
    if (v.key === 'all') return update({ view: '', status: '' });
    if (v.key === 'closed') return update({ view: 'closed', status: '', closed_period: filters.closed_period || 'month' });
    return update({ view: v.key, status: '' });
  }

  function counterValue(counterKey) {
    if (!counters || !counterKey) return null;
    if (counterKey === 'closed') return counters.closed?.month ?? null;
    return counters[counterKey] ?? null;
  }

  const assignMeMutation = useMutation({
    mutationFn: (t) => api.patch(`/api/tickets/${t.id}`, { assigned_to_id: user.id }),
    onMutate: () => {
      setBusy(true);
      setError('');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tickets'] });
      queryClient.invalidateQueries({ queryKey: ['tickets-counters'] });
    },
    onError: (err) => {
      setError(err.message || 'No se pudo asignar el ticket');
    },
    onSettled: () => {
      setBusy(false);
    },
  });

  const statusMutation = useMutation({
    mutationFn: ({ t, status, body }) =>
      status === 'CANCELLED'
        ? api.post(`/api/tickets/${t.id}/cancel`, body)
        : api.patch(`/api/tickets/${t.id}`, { status }),
    onMutate: () => {
      setBusy(true);
      setError('');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tickets'] });
      queryClient.invalidateQueries({ queryKey: ['tickets-counters'] });
    },
    onError: (err) => {
      setError(err.message || 'No se pudo actualizar el estado');
    },
    onSettled: () => {
      setBusy(false);
    },
  });

  function assignMe(t) {
    assignMeMutation.mutate(t);
  }

  function changeStatus(t, status, body = {}) {
    statusMutation.mutate({ t, status, body });
  }

  function exportTickets(format = 'csv') {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) {
      if (v === '' || v == null) continue;
      if (['page', 'perPage', 'sort', 'dir'].includes(k)) continue;
      sp.set(k, String(v));
    }
    if (format !== 'csv') sp.set('format', format);
    download(`/api/tickets/export?${sp}`);
  }

  const hasAnyFilter = query.length > 0;

  return (
    <div>
      {/* Chips de filtros rápidos con contadores */}
      <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
        {VIEWS.map((v) => {
          const active = chipActive(v.key);
          const count = counterValue(v.counter);
          return (
            <button
              key={v.key}
              type="button"
              onClick={() => onChip(v)}
              className={`inline-flex shrink-0 items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm font-medium transition ${
                active
                  ? 'border-brand-600 bg-brand-600 text-white'
                  : 'border-slate-200 bg-white text-slate-600 hover:border-brand-300 hover:text-brand-700'
              }`}
            >
              {v.label}
              {count != null && (
                <span className={`rounded-full px-1.5 text-xs ${active ? 'bg-white/20' : 'bg-slate-100 text-slate-500'}`}>{count}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Barra de herramientas */}
      <div className="card mb-4">
        <div className="flex flex-wrap items-center gap-2 p-3">
            <button type="button" className="btn-secondary !text-white" onClick={() => setShowAdvanced(true)}>
              Búsqueda avanzada
              {advancedCount > 0 && <span className="badge bg-brand-600 text-white">{advancedCount}</span>}
            </button>
            <select
              className="input !w-auto"
              value={filters.sort}
              onChange={(e) => update({ sort: e.target.value })}
              title="Ordenar por"
            >
              {SORT_OPTIONS.map(([v, l]) => (
                <option key={v} value={v}>
                  Ordenar: {l}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn-secondary !px-2.5"
              onClick={() => update({ dir: filters.dir === 'asc' ? 'desc' : 'asc' })}
              title={filters.dir === 'asc' ? 'Ascendente' : 'Descendente'}
            >
              {filters.dir === 'asc' ? '↑ Asc' : '↓ Desc'}
            </button>
            {hasAnyFilter && (
              <button type="button" className="btn-ghost text-sm" onClick={() => setSearchParams({}, { replace: false })}>
                Limpiar
              </button>
            )}
        </div>

        {filters.view === 'closed' && (
          <div className="flex items-center gap-2 border-t border-slate-200 px-3 py-2.5">
            <span className="text-sm text-slate-500">Cierre:</span>
            {CLOSED_PERIODS.map(([v, l]) => (
              <button
                key={v}
                type="button"
                onClick={() => update({ closed_period: v })}
                className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                  filters.closed_period === v ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {l}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Resumen y acciones */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm text-slate-500">
          {list ? (
            <>
              {busy && <Spinner className="h-4 w-4 text-brand-600" />}
              <span>
                <b>{list.total}</b> ticket(s) {filters.view === 'closed' ? 'cerrados' : 'encontrados'}
                {hasAnyFilter ? ' con los filtros aplicados' : ''}
              </span>
            </>
          ) : (
            'Cargando…'
          )}
        </p>
        <div className="flex gap-2">
          <button type="button" className="btn-secondary !px-2.5" onClick={reload} title="Actualizar">
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h5M20 20v-5h-5M20 9a8 8 0 0 0-14.9-2M4 15a8 8 0 0 0 14.9 2" />
            </svg>
          </button>
          {canExport && (
            <Menu
              label={
                <span className="inline-flex items-center gap-1.5">
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
                  </svg>
                  Exportar
                </span>
              }
              items={[
                { key: 'csv', label: 'CSV', onClick: () => exportTickets('csv') },
                { key: 'xlsx', label: 'Excel (XLSX)', onClick: () => exportTickets('xlsx') },
                { key: 'pdf', label: 'PDF', onClick: () => exportTickets('pdf') },
              ]}
            />
          )}
          <Link to="/app/new-ticket" className="btn-primary">
            + Reportar
          </Link>
        </div>
      </div>

      {(error || queryError) && <ErrorBox message={error || queryError.message || 'No se pudieron cargar los tickets'} />}

      {!list ? (
        <LoadingScreen />
      ) : (
        <TicketTable
          list={list}
          basePath="/app/tickets"
          sort={filters.sort}
          dir={filters.dir}
          onSort={(sort, dir) => update({ sort, dir })}
          onPage={(page) => update({ page })}
          perPage={filters.perPage}
          onPerPage={(perPage) => update({ perPage })}
          canAssign={canAssign}
          canManage={canManage}
          onAssignMe={assignMe}
          onStatusChange={changeStatus}
        />
      )}

      <AdvancedSearchModal
        open={showAdvanced}
        onClose={() => setShowAdvanced(false)}
        filters={filters}
        onApply={(form) => update({ ...form, view: '', closed_period: '' })}
        onClear={() => update(Object.fromEntries(ADVANCED_KEYS.map((k) => [k, ''])))}
      />
    </div>
  );
}
