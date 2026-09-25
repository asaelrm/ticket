import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  api,
  STATUSES,
  PRIORITIES,
  STATUS_LABEL,
  PRIORITY_LABEL,
  SORT_OPTIONS,
} from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { TicketTable } from '../components/TicketTable';
import AdvancedSearchModal, { ADVANCED_KEYS } from '../components/AdvancedSearchModal';
import { LoadingScreen, ErrorBox, Spinner, Modal } from '../components/ui';

const TABS = [
  { key: 'mine', label: 'Asignados a mí', counter: 'assigned_to_me' },
  { key: 'my-teams', label: 'Mi equipo', counter: 'assigned_to_my_teams' },
  { key: 'open', label: 'Abiertos', counter: 'open' },
  { key: 'unassigned', label: 'Sin asignar', counter: 'unassigned' },
];

const DEFAULTS = { sort: 'created_at', dir: 'desc', perPage: 15, page: 1 };

const STORAGE_KEY = 'tf_inbox_filters';

function loadSavedFilters() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function parseFilters(sp) {
  const o = Object.fromEntries(sp.entries());
  const base = {
    search: o.search || '',
    status: o.status || '',
    priority: o.priority || '',
    category: o.category || '',
    sort: o.sort || DEFAULTS.sort,
    dir: o.dir || DEFAULTS.dir,
    page: Number(o.page) || 1,
    perPage: Number(o.perPage) || DEFAULTS.perPage,
  };
  for (const k of ADVANCED_KEYS) base[k] = o[k] || '';
  return base;
}

export default function Inbox() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => parseFilters(searchParams), [searchParams]);
  const tab = searchParams.get('tab') || 'mine';

  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [searchDraft, setSearchDraft] = useState(filters.search);
  const [selected, setSelected] = useState(() => new Set());
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignValue, setAssignValue] = useState('');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [savedFilters, setSavedFilters] = useState(loadSavedFilters);
  const [savedOpen, setSavedOpen] = useState(false);
  const [saveName, setSaveName] = useState('');

  const update = useCallback(
    (partial) => {
      const next = { ...filters, tab, ...partial };
      if (!('page' in partial)) next.page = 1;
      const sp = new URLSearchParams();
      sp.set('tab', next.tab);
      for (const [k, v] of Object.entries(next)) {
        if (k === 'tab' || v === '' || v == null) continue;
        if (k in DEFAULTS && String(DEFAULTS[k]) === String(v)) continue;
        sp.set(k, String(v));
      }
      setSearchParams(sp, { replace: true });
    },
    [filters, tab, setSearchParams]
  );

  const query = useMemo(() => {
    const sp = new URLSearchParams();
    sp.set('view', tab === 'unassigned' ? 'open' : tab);
    sp.set('active', '1');
    const assigned = filters.assigned || (tab === 'unassigned' ? 'none' : '');
    if (assigned) sp.set('assigned', assigned);
    sp.set('sort', filters.sort);
    sp.set('dir', filters.dir);
    sp.set('page', String(filters.page));
    sp.set('perPage', String(filters.perPage));
    const keys = [
      'search', 'status', 'priority', 'category', 'department', 'user', 'team',
      'from', 'to', 'closed_from', 'closed_to',
    ];
    for (const k of keys) {
      if (filters[k]) sp.set(k, filters[k]);
    }
    return sp.toString();
  }, [tab, filters]);

  const { data: list, error: queryError } = useQuery({
    queryKey: ['inbox-tickets', tab, filters],
    queryFn: () => api.get(`/api/tickets?${query}`),
    refetchInterval: 30000,
  });

  const { data: counters } = useQuery({
    queryKey: ['inbox-ticket-counters'],
    queryFn: () => api.get('/api/tickets/counters'),
    refetchInterval: 30000,
  });

  const { data: categories = [] } = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get('/api/categories').then((d) => d.data || []),
  });

  const { data: assignUsers = [] } = useQuery({
    queryKey: ['assignable-users'],
    queryFn: () => api.get('/api/users/assignable').then((d) => d.data || []),
    enabled: assignOpen,
  });

  const reload = useCallback(() => {
    setError('');
    queryClient.invalidateQueries({ queryKey: ['inbox-tickets'] });
    queryClient.invalidateQueries({ queryKey: ['inbox-ticket-counters'] });
  }, [queryClient]);

  // Equivale al efecto [reload, tab]: limpia selección y recarga contadores al cambiar pestaña/filtros.
  useEffect(() => {
    setSelected(new Set());
    queryClient.invalidateQueries({ queryKey: ['inbox-ticket-counters'] });
  }, [query, queryClient]);

  useEffect(() => {
    setSearchDraft(filters.search);
  }, [filters.search]);

  useEffect(() => {
    if (searchDraft === filters.search) return undefined;
    const t = setTimeout(() => update({ search: searchDraft }), 350);
    return () => clearTimeout(t);
  }, [searchDraft, filters.search, update]);

  const canManage = user?.permissions?.includes('ticket.update.any');
  const canAssign = user?.permissions?.includes('ticket.assign');
  const advancedCount = ADVANCED_KEYS.filter((k) => filters[k]).length;
  const hasAnyFilter = Boolean(filters.search) || advancedCount > 0;

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
      queryClient.invalidateQueries({ queryKey: ['inbox-tickets'] });
      queryClient.invalidateQueries({ queryKey: ['inbox-ticket-counters'] });
    },
    onError: (err) => {
      setError(err.message || 'No se pudo actualizar el ticket');
    },
    onSettled: () => {
      setBusy(false);
    },
  });

  const assignMeMutation = useMutation({
    mutationFn: (t) => api.patch(`/api/tickets/${t.id}`, { assigned_to_id: user.id }),
    onMutate: () => {
      setBusy(true);
      setError('');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['inbox-tickets'] });
      queryClient.invalidateQueries({ queryKey: ['inbox-ticket-counters'] });
    },
    onError: (err) => {
      setError(err.message || 'No se pudo asignar el ticket');
    },
    onSettled: () => {
      setBusy(false);
    },
  });

  const bulkMutation = useMutation({
    mutationFn: ({ ids, fn }) => Promise.allSettled(ids.map((id) => fn(id))),
    onMutate: () => {
      setBusy(true);
      setError('');
    },
    onSuccess: (results, { ids }) => {
      const failed = results.filter((r) => r.status === 'rejected').length;
      setSelected(new Set());
      queryClient.invalidateQueries({ queryKey: ['inbox-tickets'] });
      queryClient.invalidateQueries({ queryKey: ['inbox-ticket-counters'] });
      if (failed) setError(`${failed} de ${ids.length} ticket(s) no se pudieron actualizar.`);
    },
    onSettled: () => {
      setBusy(false);
    },
  });

  function changeStatus(t, status, body = {}) {
    statusMutation.mutate({ t, status, body });
  }

  function assignMe(t) {
    assignMeMutation.mutate(t);
  }

  function toggleOne(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll(ids, checked) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  const bulkAssignMe = () =>
    bulkMutation.mutate({ ids: [...selected], fn: (id) => api.patch(`/api/tickets/${id}`, { assigned_to_id: user.id }) });
  const bulkStatus = (status) =>
    bulkMutation.mutate({ ids: [...selected], fn: (id) => api.patch(`/api/tickets/${id}`, { status }) });
  const bulkCancel = (reason) =>
    bulkMutation.mutate({ ids: [...selected], fn: (id) => api.post(`/api/tickets/${id}/cancel`, { reason }) });

  function openAssign() {
    setAssignValue('');
    setAssignOpen(true);
  }

  function persistSavedFilters(list) {
    setSavedFilters(list);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    } catch {
      /* almacenamiento no disponible */
    }
  }

  function saveCurrentFilter() {
    const name = saveName.trim();
    if (!name) return;
    const sp = new URLSearchParams(searchParams);
    sp.delete('page');
    sp.set('tab', tab);
    const entry = { name, query: sp.toString(), tab };
    const next = [entry, ...savedFilters.filter((f) => f.name.toLowerCase() !== name.toLowerCase())].slice(0, 20);
    persistSavedFilters(next);
    setSaveName('');
  }

  function applySavedFilter(f) {
    setSearchParams(new URLSearchParams(f.query), { replace: true });
    setSavedOpen(false);
  }

  function removeSavedFilter(name) {
    persistSavedFilters(savedFilters.filter((f) => f.name !== name));
  }

  return (
    <div className={selected.size > 0 ? 'pb-28' : ''}>
      <div className="card mb-4">
        <div className="border-b border-slate-200 px-4 py-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">Vista de trabajo</p>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {TABS.map((t) => {
              const active = tab === t.key;
              const count = counters?.[t.counter];
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => update({ tab: t.key, page: 1 })}
                  className={`inline-flex shrink-0 items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition ${
                    active
                      ? 'border-brand-600 bg-brand-600 text-white shadow-sm'
                      : 'border-slate-200 bg-white text-slate-600 hover:border-brand-300 hover:text-brand-700'
                  }`}
                >
                  {t.label}
                  {count != null && (
                    <span className={`rounded-full px-1.5 text-xs ${active ? 'bg-white/20' : 'bg-slate-100 text-slate-500'}`}>
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid gap-3 p-4 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-center">
          <div className="relative">
            <svg className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="7" />
              <path strokeLinecap="round" d="m20 20-3.5-3.5" />
            </svg>
            <input
              className="input !pl-9"
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
              placeholder="Buscar por número, título, solicitante, correo…"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2 xl:justify-end">
            <button type="button" className="btn-secondary !text-white" onClick={() => setShowAdvanced(true)}>
              Más filtros
              {advancedCount > 0 && <span className="badge bg-brand-600 text-white">{advancedCount}</span>}
            </button>
            <button type="button" className="btn-secondary !text-white" onClick={() => setSavedOpen(true)}>
              Vistas guardadas
              {savedFilters.length > 0 && <span className="badge bg-brand-600 text-white">{savedFilters.length}</span>}
            </button>
          </div>
        </div>

        <div className="grid gap-3 border-t border-slate-200 px-4 py-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-[1fr_1fr_1fr_1.4fr_auto_auto] xl:items-end">
          <div>
            <label className="label" htmlFor="inbox-status">Estado</label>
            <select id="inbox-status" className="input" value={filters.status} onChange={(e) => update({ status: e.target.value })}>
              <option value="">Todos los estados</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>{STATUS_LABEL[s]}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="inbox-priority">Prioridad</label>
            <select id="inbox-priority" className="input" value={filters.priority} onChange={(e) => update({ priority: e.target.value })}>
              <option value="">Todas las prioridades</option>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="inbox-category">Categoría</label>
            <select id="inbox-category" className="input" value={filters.category} onChange={(e) => update({ category: e.target.value })}>
              <option value="">Todas las categorías</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="inbox-sort">Ordenar por</label>
            <select id="inbox-sort" className="input" value={filters.sort} onChange={(e) => update({ sort: e.target.value })}>
              {SORT_OPTIONS.map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </div>
          <div className="flex items-end">
            <button
              type="button"
              className="btn-secondary w-full whitespace-nowrap"
              onClick={() => update({ dir: filters.dir === 'asc' ? 'desc' : 'asc' })}
              title={filters.dir === 'asc' ? 'Ascendente' : 'Descendente'}
            >
              {filters.dir === 'asc' ? '↑ Asc' : '↓ Desc'}
            </button>
          </div>
          <div className="flex items-end">
            {hasAnyFilter && (
              <button
                type="button"
                className="btn-ghost w-full text-sm"
                onClick={() => update({ search: '', ...Object.fromEntries(ADVANCED_KEYS.map((k) => [k, ''])) })}
              >
                Limpiar
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Resumen y acciones */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm text-slate-500">
          {list ? (
            <>
              {busy && <Spinner className="h-4 w-4 text-brand-600" />}
              <span>
                <b>{list.total}</b> ticket(s)
                {hasAnyFilter ? ' con los filtros aplicados' : ''}
              </span>
            </>
          ) : (
            'Cargando…'
          )}
        </p>
        <button type="button" className="btn-secondary !px-2.5" onClick={reload} title="Actualizar">
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h5M20 20v-5h-5M20 9a8 8 0 0 0-14.9-2M4 15a8 8 0 0 0 14.9 2" />
          </svg>
        </button>
      </div>

      {(error || queryError) && <ErrorBox message={error || queryError.message || 'Error al cargar los tickets'} />}
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
          selectable
          selected={selected}
          onToggle={toggleOne}
          onToggleAll={toggleAll}
        />
      )}

      <AdvancedSearchModal
        open={showAdvanced}
        onClose={() => setShowAdvanced(false)}
        filters={filters}
        onApply={(form) => update({ ...form })}
        onClear={() => update(Object.fromEntries(ADVANCED_KEYS.map((k) => [k, ''])))}
      />

      {/* Barra de acciones en lote */}
      {selected.size > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 backdrop-blur">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-2 px-4 py-3 lg:px-8">
            <span className="text-sm font-semibold text-slate-800">{selected.size} seleccionado(s)</span>
            <button type="button" className="btn-ghost text-sm" onClick={() => setSelected(new Set())}>
              Quitar selección
            </button>
            <div className="ml-auto flex flex-wrap gap-2">
              {canAssign && (
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => bulkAssignMe()}>
                  Asignarme
                </button>
              )}
              {canAssign && (
                <button type="button" className="btn-secondary" disabled={busy} onClick={openAssign}>
                  Asignar a…
                </button>
              )}
              {canManage && (
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => bulkStatus('IN_PROGRESS')}>
                  En proceso
                </button>
              )}
              {canManage && (
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => bulkStatus('RESOLVED')}>
                  Resuelto
                </button>
              )}
              {canManage && (
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => bulkStatus('CLOSED')}>
                  Cerrar
                </button>
              )}
              {canManage && (
                <button
                  type="button"
                  className="btn-danger"
                  disabled={busy}
                  onClick={() => {
                    setCancelReason('');
                    setCancelOpen(true);
                  }}
                >
                  Cancelar
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <Modal open={assignOpen} onClose={() => setAssignOpen(false)} title={`Asignar ${selected.size} ticket(s)`}>
        <label className="label">Técnico asignado</label>
        <select className="input" value={assignValue} onChange={(e) => setAssignValue(e.target.value)}>
          <option value="">Seleccione un técnico…</option>
          {assignUsers.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name} {u.last_name}
              {u.department_name ? ` · ${u.department_name}` : ''}
            </option>
          ))}
        </select>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={() => setAssignOpen(false)} disabled={busy}>
            Cancelar
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={busy || !assignValue}
            onClick={async () => {
              setAssignOpen(false);
              bulkMutation.mutate({
                ids: [...selected],
                fn: (id) => api.patch(`/api/tickets/${id}`, { assigned_to_id: Number(assignValue) }),
              });
            }}
          >
            Asignar
          </button>
        </div>
      </Modal>

      <Modal open={cancelOpen} onClose={() => setCancelOpen(false)} title={`Cancelar ${selected.size} ticket(s)`}>
        <p className="text-sm text-slate-600">Se cancelarán los tickets seleccionados. Esta acción no se puede deshacer.</p>
        <label className="mt-4 block text-sm font-medium text-slate-700">
          Motivo de cancelación <span className="text-red-500">*</span>
          <textarea
            className="input mt-1 min-h-[90px]"
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
            placeholder="Ej. Duplicados o solicitudes que ya no aplican…"
            maxLength={2000}
          />
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={() => setCancelOpen(false)} disabled={busy}>
            Volver
          </button>
          <button
            type="button"
            className="btn-danger"
            disabled={busy || !cancelReason.trim()}
            onClick={async () => {
              setCancelOpen(false);
              bulkCancel(cancelReason.trim());
              setCancelReason('');
            }}
          >
            Cancelar tickets
          </button>
        </div>
      </Modal>

      <Modal open={savedOpen} onClose={() => setSavedOpen(false)} title="Filtros guardados">
        <div className="flex items-end gap-2">
          <label className="flex-1">
            <span className="label">Guardar filtro actual</span>
            <input
              className="input"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder="Ej. Críticos sin asignar"
              maxLength={40}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  saveCurrentFilter();
                }
              }}
            />
          </label>
          <button type="button" className="btn-primary" disabled={!saveName.trim()} onClick={saveCurrentFilter}>
            Guardar
          </button>
        </div>

        <div className="mt-5 border-t border-slate-200 pt-4">
          {savedFilters.length === 0 ? (
            <p className="text-sm text-slate-500">
              Aún no ha guardado filtros. Configure la bandeja (pestaña, búsqueda y filtros) y guarde la combinación actual.
            </p>
          ) : (
            <ul className="space-y-2">
              {savedFilters.map((f) => {
                const params = new URLSearchParams(f.query);
                const tabLabel = TABS.find((t) => t.key === (f.tab || 'mine'))?.label || 'Bandeja';
                const count = ADVANCED_KEYS.filter((k) => params.get(k)).length;
                const search = params.get('search');
                return (
                  <li key={f.name} className="flex items-center gap-3 rounded-lg border border-slate-200 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-slate-800">{f.name}</p>
                      <p className="truncate text-xs text-slate-500">
                        {tabLabel}
                        {count ? ` · ${count} filtro(s)` : ''}
                        {search ? ` · “${search}”` : ''}
                      </p>
                    </div>
                    <button type="button" className="btn-secondary !px-3 !py-1.5" onClick={() => applySavedFilter(f)}>
                      Aplicar
                    </button>
                    <button
                      type="button"
                      className="btn-ghost !px-2 !py-1.5 text-red-600"
                      onClick={() => removeSavedFilter(f.name)}
                      title="Eliminar"
                      aria-label={`Eliminar filtro ${f.name}`}
                    >
                      ✕
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Modal>
    </div>
  );
}