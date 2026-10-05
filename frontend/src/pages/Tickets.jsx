import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, download, VIEWS, CLOSED_PERIODS, SORT_OPTIONS } from '../lib/api';
import { useTicketEventInvalidator } from '../lib/ticketEvents';
import { useAuth } from '../context/AuthContext';
import { TicketTable } from '../components/TicketTable';
import AdvancedSearchModal, { ADVANCED_KEYS } from '../components/AdvancedSearchModal';
import BulkTicketBar from '../components/BulkTicketBar';
import { useTicketBulk } from '../lib/useTicketBulk';
import { useTicketRowActions } from '../lib/useTicketRowActions';
import { useMyTeams } from '../lib/useMyTeams';
import { LoadingScreen, ErrorBox, Spinner, Menu } from '../components/ui';
import Select from '../components/Select';
import Tooltip from '../components/Tooltip';

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
    // Acota a los estados no terminales. Es el mismo filtro que ya usa Inbox y
    // que buildConditions de /api/tickets entiende como bandera de verdad; sin
    // leerlo aquí, la URL que llega desde un acceso directo se descartaría y la
    // pantalla mostraría la lista completa.
    active: o.active || '',
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

  const [showAdvanced, setShowAdvanced] = useState(false);

  const canExport = user?.permissions?.includes('ticket.export');

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
    // Sin polling: los cambios llegan por SSE (conexión global) y se refresca al
    // volver a la pestaña/recuperar la conexión (refetchOnWindowFocus por defecto).
  });

  const { data: counters } = useQuery({
    queryKey: ['tickets-counters'],
    queryFn: () => api.get('/api/tickets/counters').catch(() => null),
    // Respaldo de polling: los contadores son baratos y cubren cambios de fondo
    // (SLA vencido) que no generan eventos de usuario.
    refetchInterval: 30000,
  });

  useTicketEventInvalidator(['tickets', 'tickets-counters']);

  const bulk = useTicketBulk({
    user,
    queryKeys: ['tickets', 'tickets-counters'],
    resetKey: query,
    labelFor: (id) => list?.data?.find((t) => t.id === id)?.ticket_number || `Ticket ${id}`,
  });

  // Mismo hook y mismo contrato que la Bandeja: aquí antes no existía ningún
  // bloqueo anti-doble-clic, así que dos clics seguidos colgaban dos PATCH del
  // mismo ticket. Ahora las dos pantallas comparten una única implementación.
  const rowActions = useTicketRowActions({
    user,
    queryKeys: ['tickets', 'tickets-counters'],
    onBeforeAction: () => bulk.clearFeedback(),
  });

  const { canAssign, canManage, canResolve, canClose } = rowActions.permissions;
  // `rowActions` es un objeto nuevo en cada render, así que en las dependencias
  // va `clearError`, que sí es estable. Con el objeto entero, este efecto se
  // repetía en cada repintado y borraba el error de una acción nada más aparecer.
  const { clearError } = rowActions;

  // Equivale al efecto [reload]: al cambiar filtros se limpia el error previo y se refrescan los contadores.
  // La selección ya la descarta `useTicketBulk` con `resetKey`.
  useEffect(() => {
    clearError();
    queryClient.invalidateQueries({ queryKey: ['tickets-counters'] });
  }, [query, queryClient, clearError]);

  const reload = useCallback(() => {
    clearError();
    queryClient.invalidateQueries({ queryKey: ['tickets'] });
    queryClient.invalidateQueries({ queryKey: ['tickets-counters'] });
  }, [queryClient, clearError]);

  const advancedCount = ADVANCED_KEYS.filter((k) => filters[k]).length;

  // Misma regla y mismo hook que la Bandeja: el chip "Mi equipo" se esconde sólo
  // cuando /api/teams/mine confirma que el usuario no pertenece a ninguno.
  const { hasNoTeams } = useMyTeams();
  const visibleViews = useMemo(
    () => VIEWS.filter((v) => !v.needsTeam || !hasNoTeams),
    [hasNoTeams]
  );

  // Aquí la vista viaja en `view` (no en `tab` como en la Bandeja), así que el
  // equivalente de un ?tab=my-teams inválido es un ?view=my-teams. Se corrige a
  // la vista predeterminada de esta pantalla, que es "Todos" —sin `view`— en
  // cuanto se confirme que no hay equipos, ni antes ni ante un fallo. Con replace
  // porque es una URL inválida, no una elección del usuario: un push haría que el
  // botón atrás volviera a un estado sin sentido y no saliera de él.
  useEffect(() => {
    if (!hasNoTeams || filters.view !== 'my-teams') return;
    update({ view: '', status: '' }, { replace: true });
  }, [hasNoTeams, filters.view, update]);

  // Los chips de `VIEWS` cubren status/priority/category en la URL; el único
  // select de esta pantalla es el orden, que se mantiene idéntico salvo por el
  // componente: mismo valor, mismo `update` y mismos rótulos "Ordenar: X".
  const sortOptions = useMemo(
    () => SORT_OPTIONS.map(([v, l]) => ({ value: v, label: `Ordenar: ${l}` })),
    []
  );

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

  // La fila y la barra en lote usan la misma entrada. Resolver pasa siempre por
  // el diálogo propio de la fila, que ya exige la solución: si aquí faltara, el
  // backend lo rechazaría y el error se vería en ese mismo diálogo.
  //
  // El rechazo se propaga a propósito: es lo que permite que `ResolveTicketModal`
  // muestre el fallo y conserve lo escrito en lugar de cerrarse en silencio.
  function changeStatus(t, status, body = {}) {
    return rowActions.runStatus(t, status, body);
  }

  // Nadie espera esta promesa (botones y menú), así que se absorben los rechazos:
  // el error ya se pinta en el `ErrorBox` de la pantalla.
  function assignMe(t) {
    return rowActions.assignMe(t)?.catch(() => {});
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
    // El hueco que deja la barra de acciones en lote lo pone la propia barra
    // (`BulkTicketBar`), en el flujo y sólo mientras hay selección: aquí no hace
    // falta reservar nada, porque un `pb-` fijo se desincronizaba del alto real
    // de la barra y acababa tapando la última fila y la paginación.
    <div>
      {/* Chips de filtros rápidos con contadores */}
      <div className="mb-3 flex flex-wrap gap-2 pb-1">
        {visibleViews.map((v) => {
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
        <div className="flex flex-wrap items-center justify-between gap-2 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className="btn-secondary !text-white" onClick={() => setShowAdvanced(true)}>
                Búsqueda avanzada
                {advancedCount > 0 && <span className="badge bg-brand-600 text-white">{advancedCount}</span>}
              </button>
              {hasAnyFilter && (
                <button type="button" className="btn-ghost text-sm" onClick={() => setSearchParams({}, { replace: false })}>
                  Limpiar
                </button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                className="!w-auto"
                options={sortOptions}
                value={filters.sort}
                onChange={(v) => update({ sort: v })}
                title="Ordenar por"
              />
              <button
                type="button"
                className="btn-secondary !px-2.5"
                onClick={() => update({ dir: filters.dir === 'asc' ? 'desc' : 'asc' })}
                title={filters.dir === 'asc' ? 'Ascendente' : 'Descendente'}
              >
                {filters.dir === 'asc' ? '↑ Asc' : '↓ Desc'}
              </button>
            </div>
        </div>

        {filters.view === 'closed' && (
          <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 px-3 py-2.5">
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
        <p className="flex items-center gap-2 truncate text-sm text-slate-500">
          {list ? (
            <>
              {rowActions.busy && <Spinner className="h-4 w-4 text-brand-600" />}
              <span className="truncate">
                <b>{list.total}</b> ticket(s) {filters.view === 'closed' ? 'cerrados' : 'encontrados'}
                {hasAnyFilter ? ' con los filtros aplicados' : ''}
              </span>
            </>
          ) : (
            'Cargando…'
          )}
        </p>
        {rowActions.notice && (
          <p role="status" className="flex items-center gap-1.5 text-sm text-emerald-700">
            <span aria-hidden="true">✓</span>
            {rowActions.notice}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Tooltip text="Actualizar">
            <button type="button" className="btn-secondary !px-2.5" onClick={reload} aria-label="Actualizar">
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h5M20 20v-5h-5M20 9a8 8 0 0 0-14.9-2M4 15a8 8 0 0 0 14.9 2" />
              </svg>
            </button>
          </Tooltip>
          {canExport && (
            <Menu
              label={
                <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
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
          <Link to="/app/new-ticket" className="btn-primary whitespace-nowrap">
            + Reportar
          </Link>
        </div>
      </div>

      {(rowActions.error || queryError || bulk.error) && (
        <ErrorBox
          message={rowActions.error || queryError?.message || bulk.error}
          details={bulk.errorDetails}
        />
      )}

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
          canResolve={canResolve}
          canClose={canClose}
          currentUserId={user?.id}
          onAssignMe={assignMe}
          onStatusChange={changeStatus}
          onClearError={clearError}
          selectable
          selected={bulk.selected}
          onToggle={bulk.toggleOne}
          onToggleAll={bulk.toggleAll}
          pendingIds={rowActions.pendingIds}
        />
      )}

      <AdvancedSearchModal
        open={showAdvanced}
        onClose={() => setShowAdvanced(false)}
        filters={filters}
        onApply={(form) => update({ ...form, view: '', closed_period: '' })}
        onClear={() => update(Object.fromEntries(ADVANCED_KEYS.map((k) => [k, ''])))}
      />

      <BulkTicketBar
        bulk={bulk}
        canAssign={canAssign}
        canManage={canManage}
        canResolve={canResolve}
        canClose={canClose}
      />
    </div>
  );
}
