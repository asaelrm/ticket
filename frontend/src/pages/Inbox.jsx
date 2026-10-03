import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTicketEventInvalidator } from '../lib/ticketEvents';
import {
  api,
  STATUSES,
  PRIORITIES,
  STATUS_LABEL,
  PRIORITY_LABEL,
  SLA_FILTERS,
  SLA_LABEL,
  SORT_OPTIONS,
} from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { TicketTable } from '../components/TicketTable';
import AdvancedSearchModal, { ADVANCED_KEYS } from '../components/AdvancedSearchModal';
import BulkTicketBar from '../components/BulkTicketBar';
import { useTicketBulk } from '../lib/useTicketBulk';
import { useTicketRowActions } from '../lib/useTicketRowActions';
import { useMyTeams } from '../lib/useMyTeams';
import { LoadingScreen, ErrorBox, Spinner, Modal, EmptyState } from '../components/ui';
import Select from '../components/Select';
import Tooltip from '../components/Tooltip';

const TABS = [
  { key: 'mine', label: 'Asignados a mí', counter: 'assigned_to_me' },
  // "Mi equipo" sólo aparece si el usuario pertenece al menos a un equipo.
  // `view=my-teams` y su contador se calculan sobre `team_members`, así que sin
  // membresía la pestaña quedaría en 0 para siempre: ocuparía sitio y prometería
  // una cobertura de equipo que no existe. Cuando sí hay equipos, se comporta
  // exactamente igual que antes.
  { key: 'my-teams', label: 'Mi equipo', counter: 'assigned_to_my_teams', needsTeam: true },
  { key: 'open', label: 'Abiertos', counter: 'open' },
  { key: 'unassigned', label: 'Sin asignar', counter: 'unassigned' },
];

// Resumen compacto de la cabecera: cinco números que responden a la pregunta
// habitual del técnico al abrir la Bandeja. Cada indicador es un atajo a un
// estado de la URL, no una tarjeta del Dashboard, y por eso comparte el sistema
// de filtros: al pulsarlo se ve exactamente lo que el número cuenta.
//
// `patch` es el estado completo que deja el indicador. Se pone a cero lo que
// chocaría con él (prioridad, estado, plazo y técnico) y se conserva lo que no
// (búsqueda, categoría, fechas): así el listado coincide con el contador y el
// usuario no pierde lo que estaba escribiendo.
const INDICATORS = [
  {
    key: 'mine',
    label: 'Mis activos',
    counter: 'mine_active',
    patch: { tab: 'mine', priority: '', status: '', sla: '', assigned: '' },
    isActive: (tab, f) => tab === 'mine' && !f.priority && !f.status && !f.sla && !f.assigned,
  },
  {
    key: 'unassigned',
    label: 'Sin asignar',
    counter: 'unassigned',
    patch: { tab: 'unassigned', priority: '', status: '', sla: '', assigned: '' },
    isActive: (tab, f) => tab === 'unassigned' && !f.priority && !f.status && !f.sla && !f.assigned,
  },
  {
    key: 'overdue',
    label: 'Fuera de plazo',
    counter: 'overdue',
    patch: { tab: 'open', priority: '', status: '', sla: 'overdue', assigned: '' },
    isActive: (tab, f) => tab === 'open' && f.sla === 'overdue' && !f.priority && !f.status && !f.assigned,
  },
  {
    key: 'critical',
    label: 'Críticos',
    counter: 'critical',
    patch: { tab: 'open', priority: 'CRITICAL', status: '', sla: '', assigned: '' },
    isActive: (tab, f) => tab === 'open' && f.priority === 'CRITICAL' && !f.status && !f.sla && !f.assigned,
  },
  {
    key: 'on_hold',
    // "En espera" y no "Pendientes" a propósito: aquí PENDING significa el
    // estado exacto, mientras que la vista histórica "Pendientes"
    // (`view=pending`, chip en VIEWS) es OPEN+PENDING y el contador `pending`
    // también. Son dos cifras distintas y llamarlas igual hacía dudar de cuál
    // marcaba el indicador. No cambia ni la clave, ni el contador, ni el filtro:
    // sigue siendo `status=PENDING`.
    label: 'En espera',
    counter: 'on_hold',
    patch: { tab: 'open', priority: '', status: 'PENDING', sla: '', assigned: '' },
    isActive: (tab, f) => tab === 'open' && f.status === 'PENDING' && !f.priority && !f.sla && !f.assigned,
  },
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
    // Tiempo de atención: lo acepta `GET /api/tickets?sla=overdue|due_soon`.
    sla: o.sla || '',
    sort: o.sort || DEFAULTS.sort,
    dir: o.dir || DEFAULTS.dir,
    page: Number(o.page) || 1,
    perPage: Number(o.perPage) || DEFAULTS.perPage,
  };
  for (const k of ADVANCED_KEYS) base[k] = o[k] || '';
  return base;
}

// Un único sitio decide qué vacía "Limpiar filtros": búsqueda, plazo y los
// filtros avanzados. La URL se reconstruye sin esas claves, así que el estado
// visual y el estado navegable no pueden divergir.
function clearPatch() {
  return { search: '', sla: '', ...Object.fromEntries(ADVANCED_KEYS.map((k) => [k, ''])) };
}

export default function Inbox() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => parseFilters(searchParams), [searchParams]);
  const tab = searchParams.get('tab') || 'mine';

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [searchDraft, setSearchDraft] = useState(filters.search);
  const [savedFilters, setSavedFilters] = useState(loadSavedFilters);
  const [savedOpen, setSavedOpen] = useState(false);
  const [saveName, setSaveName] = useState('');

  // Cada cambio de filtro deja una entrada en el historial del navegador, igual
  // que en la pantalla general de Tickets: así el botón atrás devuelve al
  // listado anterior en lugar de saltar fuera de la Bandeja. La búsqueda por
  // texto es la excepción y pasa `replace`, porque cada pausa al escribir sería
  // una entrada nueva y el historial se llenaría de tecleo.
  const update = useCallback(
    (partial, { replace = false } = {}) => {
      const next = { ...filters, tab, ...partial };
      if (!('page' in partial)) next.page = 1;
      const sp = new URLSearchParams();
      sp.set('tab', next.tab);
      for (const [k, v] of Object.entries(next)) {
        if (k === 'tab' || v === '' || v == null) continue;
        if (k in DEFAULTS && String(DEFAULTS[k]) === String(v)) continue;
        sp.set(k, String(v));
      }
      setSearchParams(sp, { replace });
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
      'from', 'to', 'closed_from', 'closed_to', 'sla',
    ];
    for (const k of keys) {
      if (filters[k]) sp.set(k, filters[k]);
    }
    return sp.toString();
  }, [tab, filters]);

  const { data: list, error: queryError } = useQuery({
    queryKey: ['inbox-tickets', tab, filters],
    queryFn: () => api.get(`/api/tickets?${query}`),
    // Sin polling: los cambios llegan por SSE (conexión global) y se refresca al
    // volver a la pestaña/recuperar la conexión (refetchOnWindowFocus por defecto).
  });

  const { data: counters } = useQuery({
    queryKey: ['inbox-ticket-counters'],
    queryFn: () => api.get('/api/tickets/counters'),
    // Respaldo de polling: los contadores son baratos y cubren cambios de fondo
    // (SLA vencido) que no generan eventos de usuario.
    refetchInterval: 30000,
  });

  useTicketEventInvalidator(['inbox-tickets', 'inbox-ticket-counters']);

  const { data: categories = [] } = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get('/api/categories').then((d) => d.data || []),
  });

  // Los chips de "filtros activos" necesitan el nombre legible del valor, no su
  // id. Se piden solo si el filtro está en uso y, cuando lo está, el backend
  // exige el mismo permiso que ya protege el selector (ticket.view.all para los
  // directorios). Las claves coinciden con las de AdvancedSearchModal y con las
  // de TicketDetail, así que la respuesta se comparte en caché en vez de
  // repetirse.
  const { data: departments = [] } = useQuery({
    queryKey: ['departments'],
    queryFn: () => api.get('/api/departments').then((d) => d.data || []),
    enabled: Boolean(filters.department),
  });
  const { data: directoryUsers = [] } = useQuery({
    queryKey: ['assignable-users'],
    queryFn: () => api.get('/api/users/assignable').then((d) => d.data || []),
    enabled: Boolean(filters.user) || Boolean(filters.assigned && filters.assigned !== 'none'),
  });
  const { data: teams = [] } = useQuery({
    queryKey: ['assignable-teams'],
    queryFn: () => api.get('/api/teams/assignable').then((d) => d.data || []),
    enabled: Boolean(filters.team),
  });

  // La misma regla que "Todos los tickets", en el mismo hook: "Mi equipo" se
  // oculta sólo cuando sabemos con certeza que no hay equipos. Mientras la
  // consulta vuela se muestra como antes, para que la pestaña no desaparezca y
  // vuelva a aparecer al cargar; si la consulta falla se mantiene, porque un
  // fallo de red no significa que el usuario no tenga equipos.
  const { hasNoTeams } = useMyTeams();

  const visibleTabs = useMemo(
    () => TABS.filter((t) => !t.needsTeam || !hasNoTeams),
    [hasNoTeams]
  );

  // Un enlace directo a ?tab=my-teams de alguien sin equipos dejaría la pantalla
  // sin ninguna pestaña resaltada. Se corrige a la vista predeterminada en
  // cuanto /api/teams/mine confirme que no hay equipos, y sólo entonces: con la
  // consulta en vuelo o si falla se conserva la URL intacta.
  //
  // Usa replace a propósito. Es una corrección de una URL inválida, no una
  // elección del usuario, así que no debe ocupar una entrada del historial: si
  // fuera un push, el botón atrás devolvería al `tab=my-teams` sin sentido y
  // habría que pulsarlo otra vez para salir de ahí.
  useEffect(() => {
    if (!hasNoTeams || tab !== 'my-teams') return;
    update({ tab: 'mine' }, { replace: true });
  }, [hasNoTeams, tab, update]);

  // Opciones de los cuatro filtros. Se memoirean porque `Select` recibe un array
  // y lo recorre en cada render; la forma `{ value, label }` es la misma que
  // usaban los `<option>`, así que los valores enviados no cambian.
  const statusOptions = useMemo(
    () => [
      { value: '', label: 'Todos los estados' },
      ...STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] })),
    ],
    []
  );
  const priorityOptions = useMemo(
    () => [
      { value: '', label: 'Todas las prioridades' },
      ...PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] })),
    ],
    []
  );
  const categoryOptions = useMemo(
    () => [
      { value: '', label: 'Todas las categorías' },
      ...categories.map((c) => ({ value: c.id, label: c.name })),
    ],
    [categories]
  );
  const sortOptions = useMemo(() => SORT_OPTIONS.map(([v, l]) => ({ value: v, label: l })), []);
  const slaOptions = useMemo(() => SLA_FILTERS.map(([v, l]) => ({ value: v, label: l })), []);

  const bulk = useTicketBulk({
    user,
    queryKeys: ['inbox-tickets', 'inbox-ticket-counters'],
    resetKey: query,
    // El número se resuelve en el momento de la acción: tras el refetch el
    // ticket puede haber salido de la página y el detalle de fallos lo necesita.
    labelFor: (id) => list?.data?.find((t) => t.id === id)?.ticket_number || `Ticket ${id}`,
  });

  // Un solo mecanismo para las acciones de fila (tomar, iniciar atención,
  // poner en espera, reanudar, resolver): bloqueo anti-doble-clic, aviso de
  // éxito, error del servidor y refresco del listado y los contadores. Lo
  // comparte con "Todos los tickets" a través de `useTicketRowActions`.
  const rowActions = useTicketRowActions({
    user,
    queryKeys: ['inbox-tickets', 'inbox-ticket-counters'],
    onBeforeAction: () => bulk.clearFeedback(),
  });

  const { clearError } = rowActions;

  const reload = useCallback(() => {
    clearError();
    queryClient.invalidateQueries({ queryKey: ['inbox-tickets'] });
    queryClient.invalidateQueries({ queryKey: ['inbox-ticket-counters'] });
  }, [queryClient, clearError]);

  // Equivale al efecto [reload, tab]: al cambiar pestaña/filtros se recarga
  // contadores. La selección ya la descarta `useTicketBulk` con `resetKey`.
  useEffect(() => {
    queryClient.invalidateQueries({ queryKey: ['inbox-ticket-counters'] });
  }, [query, queryClient]);

  useEffect(() => {
    setSearchDraft(filters.search);
  }, [filters.search]);

  useEffect(() => {
    if (searchDraft === filters.search) return undefined;
    const t = setTimeout(() => update({ search: searchDraft }, { replace: true }), 350);
    return () => clearTimeout(t);
  }, [searchDraft, filters.search, update]);

  // El backend exige el permiso específico de cada flujo, no solo update.any:
  // /resolve exige ticket.resolve y /close exige ticket.close. Los calcula
  // `useTicketRowActions` una sola vez y también los usa como segunda barrera
  // antes de construir la petición.
  const { canAssign, canManage, canResolve, canClose } = rowActions.permissions;
  const advancedCount = ADVANCED_KEYS.filter((k) => filters[k]).length;
  const hasAnyFilter = Boolean(filters.search) || Boolean(filters.sla) || advancedCount > 0;

  // Filtros activos, en el orden en que se muestran los controles. Cada entrada
  // sabe qué parámetro de la URL tiene que vaciarse para quitarse, y por eso
  // quitar uno no toca el resto ni la pestaña.
  const activeChips = useMemo(() => {
    // El directorio de personas guarda el apellido en `last_name` y así lo
    // muestran el resto de selectores de la aplicación; las categorías,
    // departamentos y equipos sólo tienen `name`.
    const label = (v) => [v?.name, v?.last_name].filter(Boolean).join(' ');
    const nameOf = (rows, id) => label(rows.find((r) => String(r.id) === String(id))) || `#${id}`;
    const chips = [];
    if (filters.search) chips.push({ key: 'search', label: `Búsqueda: ${filters.search}` });
    if (filters.status) chips.push({ key: 'status', label: `Estado: ${STATUS_LABEL[filters.status] || filters.status}` });
    if (filters.priority) chips.push({ key: 'priority', label: `Prioridad: ${PRIORITY_LABEL[filters.priority] || filters.priority}` });
    if (filters.category) chips.push({ key: 'category', label: `Categoría: ${nameOf(categories, filters.category)}` });
    if (filters.department) chips.push({ key: 'department', label: `Departamento: ${nameOf(departments, filters.department)}` });
    if (filters.user) chips.push({ key: 'user', label: `Solicitante: ${nameOf(directoryUsers, filters.user)}` });
    if (filters.assigned) {
      chips.push({
        key: 'assigned',
        label: filters.assigned === 'none' ? 'Asignado: Sin asignar' : `Asignado: ${nameOf(directoryUsers, filters.assigned)}`,
      });
    }
    if (filters.team) chips.push({ key: 'team', label: `Equipo: ${nameOf(teams, filters.team)}` });
    if (filters.sla) chips.push({ key: 'sla', label: `Tiempo: ${SLA_LABEL[filters.sla] || filters.sla}` });
    if (filters.from) chips.push({ key: 'from', label: `Creado desde: ${filters.from}` });
    if (filters.to) chips.push({ key: 'to', label: `Creado hasta: ${filters.to}` });
    if (filters.closed_from) chips.push({ key: 'closed_from', label: `Cerrado desde: ${filters.closed_from}` });
    if (filters.closed_to) chips.push({ key: 'closed_to', label: `Cerrado hasta: ${filters.closed_to}` });
    return chips;
  }, [filters, categories, departments, directoryUsers, teams]);

  // La fila y la barra en lote hablan el mismo idioma: `onStatusChange` es lo
  // que TicketTable llama para cualquier transición y que aquí se traduce a la
  // llamada correcta. Resolver pasa por el diálogo propio de la fila, que ya
  // exige la solución, así que no hace falta el diálogo de lote para un PATCH.
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

  const clearFilters = useCallback(() => update(clearPatch()), [update]);

  // Estado vacío: primero se explica por qué no hay filas y, si es por un filtro,
  // se ofrece la salida. Un "Limpiar filtros" en tabla vacía es la acción que
  // evita tener que buscar cuál de los filtros dejó la lista sin resultados.
  const emptyState = useMemo(() => {
    if (hasAnyFilter) {
      return (
        <EmptyState
          icon="🔍"
          title="No encontramos tickets con estos filtros"
          subtitle="Pruebe con menos filtros o con un plazo más amplio."
          action={
            <button type="button" className="btn-secondary" onClick={clearFilters}>
              Limpiar filtros
            </button>
          }
        />
      );
    }
    if (tab === 'unassigned') {
      return (
        <EmptyState
          icon="✅"
          title="No hay tickets sin asignar"
          subtitle="Todo lo que está abierto tiene técnico responsable."
        />
      );
    }
    if (tab === 'mine') {
      return (
        <EmptyState
          icon="🎫"
          title="No tienes tickets asignados"
          subtitle="Revise la pestaña “Sin asignar” para tomar uno, o “Mi equipo” si trabaja en equipo."
        />
      );
    }
    if (tab === 'my-teams') {
      return (
        <EmptyState
          icon="🎫"
          title="No hay tickets asignados a tus equipos"
          subtitle="Cuando se asigne un ticket a alguno de sus equipos aparecerá aquí."
        />
      );
    }
    return <EmptyState icon="🎫" title="No hay tickets abiertos" subtitle="No hay tickets pendientes de atención en esta vista." />;
  }, [hasAnyFilter, tab, clearFilters]);

  return (
    <div className={bulk.selected.size > 0 ? 'pb-28' : ''}>
      <div className="card mb-4">
        <div className="border-b border-slate-200 px-4 py-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">Vista de trabajo</p>
          <div className="flex gap-2 overflow-x-auto pb-1" role="group" aria-label="Vistas de la bandeja">
            {visibleTabs.map((t) => {
              const active = tab === t.key;
              const count = counters?.[t.counter];
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => update({ tab: t.key, page: 1 })}
                  aria-pressed={active}
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

          {/* Resumen: cinco números, no cinco tarjetas. Cada uno es un atajo a un
              estado de la URL, así que filtrar con él es indistinguible de
              filtrar con los controles de abajo y el botón atrás funciona igual. */}
          <p className="mb-2 mt-3 text-xs font-semibold uppercase tracking-wider text-slate-400">Resumen</p>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Resumen de la bandeja">
            {INDICATORS.map((ind) => {
              const active = ind.isActive(tab, filters);
              const count = counters?.[ind.counter];
              return (
                <button
                  key={ind.key}
                  type="button"
                  onClick={() => update({ ...ind.patch, page: 1 })}
                  aria-pressed={active}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold transition ${
                    active
                      ? 'border-brand-600 bg-brand-600 text-white'
                      : 'border-slate-200 bg-white text-slate-600 hover:border-brand-300 hover:text-brand-700'
                  }`}
                >
                  {ind.label}
                  <span
                    className={`rounded-full px-1.5 text-[11px] ${
                      active ? 'bg-white/20' : count > 0 ? 'bg-slate-100 text-slate-500' : 'bg-slate-100 text-slate-400'
                    }`}
                  >
                    {count == null ? '–' : count}
                  </span>
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

        <div className="grid gap-3 border-t border-slate-200 px-4 py-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-[1fr_1fr_1fr_1fr_1.4fr_auto] xl:items-end">
          <div>
            <label className="label" htmlFor="inbox-status">Estado</label>
            <Select
              id="inbox-status"
              options={statusOptions}
              value={filters.status}
              onChange={(v) => update({ status: v })}
            />
          </div>
          <div>
            <label className="label" htmlFor="inbox-priority">Prioridad</label>
            <Select
              id="inbox-priority"
              options={priorityOptions}
              value={filters.priority}
              onChange={(v) => update({ priority: v })}
            />
          </div>
          <div>
            <label className="label" htmlFor="inbox-category">Categoría</label>
            <Select
              id="inbox-category"
              options={categoryOptions}
              value={filters.category}
              onChange={(v) => update({ category: v })}
            />
          </div>
          <div>
            <label className="label" htmlFor="inbox-sla">Tiempo de atención</label>
            <Select
              id="inbox-sla"
              options={slaOptions}
              value={filters.sla}
              onChange={(v) => update({ sla: v })}
            />
          </div>
          <div>
            <label className="label" htmlFor="inbox-sort">Ordenar por</label>
            <Select
              id="inbox-sort"
              options={sortOptions}
              value={filters.sort}
              onChange={(v) => update({ sort: v })}
            />
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
        </div>

        {/* Filtros activos. Sólo aparecen cuando hay alguno, y cada uno se quita
            sin tocar el resto: vaciar su parámetro es lo único que cambia. */}
        {activeChips.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 px-4 py-2.5">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Filtros</span>
            {activeChips.map((chip) => (
              <span
                key={chip.key}
                className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-600"
              >
                <span className="max-w-[16rem] truncate" title={chip.label}>
                  {chip.label}
                </span>
                <button
                  type="button"
                  className="rounded-full px-1 text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
                  onClick={() => update({ [chip.key]: '' })}
                  aria-label={`Quitar filtro ${chip.label}`}
                >
                  ✕
                </button>
              </span>
            ))}
            <button type="button" className="btn-ghost !px-2 !py-1 text-xs" onClick={clearFilters}>
              Limpiar filtros
            </button>
          </div>
        )}
      </div>

      {/* Resumen y acciones */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <p className="flex items-center gap-2 text-sm text-slate-500">
            {list ? (
              <>
                {rowActions.busy && <Spinner className="h-4 w-4 text-brand-600" />}
                <span>
                  <b>{list.total}</b> ticket(s)
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
        </div>
        <Tooltip text="Actualizar">
          <button type="button" className="btn-secondary !px-2.5" onClick={reload} aria-label="Actualizar">
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h5M20 20v-5h-5M20 9a8 8 0 0 0-14.9-2M4 15a8 8 0 0 0 14.9 2" />
            </svg>
          </button>
        </Tooltip>
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
          selectable
          selected={bulk.selected}
          onToggle={bulk.toggleOne}
          onToggleAll={bulk.toggleAll}
          pendingIds={rowActions.pendingIds}
          emptyState={emptyState}
        />
      )}

      <AdvancedSearchModal
        open={showAdvanced}
        onClose={() => setShowAdvanced(false)}
        filters={filters}
        onApply={(form) => update({ ...form })}
        onClear={() => update(Object.fromEntries(ADVANCED_KEYS.map((k) => [k, ''])))}
      />

      <BulkTicketBar
        bulk={bulk}
        canAssign={canAssign}
        canManage={canManage}
        canResolve={canResolve}
        canClose={canClose}
      />

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
