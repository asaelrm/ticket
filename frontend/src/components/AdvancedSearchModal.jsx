import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, STATUSES, PRIORITIES, STATUS_LABEL, PRIORITY_LABEL } from '../lib/api';
import { useAuth, can } from '../context/AuthContext';
import { Modal, Spinner } from './ui';
import Select from './Select';

// Campos que gestiona la búsqueda avanzada (no incluye la vista ni la búsqueda simple).
export const ADVANCED_KEYS = [
  'status',
  'priority',
  'category',
  'department',
  'user',
  'assigned',
  'team',
  'from',
  'to',
  'closed_from',
  'closed_to',
];

const EMPTY = {
  status: '',
  priority: '',
  category: '',
  department: '',
  user: '',
  assigned: '',
  team: '',
  from: '',
  to: '',
  closed_from: '',
  closed_to: '',
};

// Filtros que dependen del directorio de técnicos/equipos. El backend protege
// /api/users/assignable y /api/teams/assignable, y filtrar la lista global por
// solicitante, técnico o equipo solo tiene sentido para quien puede ver todos los
// tickets, así que el permiso que decide es ticket.view.all.
const DIRECTORY_KEYS = ['user', 'assigned', 'team'];

export default function AdvancedSearchModal({ open, onClose, filters, onApply, onClear }) {
  const { user } = useAuth();
  const canViewAll = can(user, 'ticket.view.all');
  const [form, setForm] = useState(EMPTY);

  const categoriesQuery = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get('/api/categories').then((d) => d.data || []),
    enabled: open,
  });

  const departmentsQuery = useQuery({
    queryKey: ['departments'],
    queryFn: () => api.get('/api/departments').then((d) => d.data || []),
    enabled: open,
  });

  // Sin directorios no se hacen las peticiones: una consulta que solo puede
  // acabar en 403 no aporta nada y ensucia la consola del navegador.
  const usersQuery = useQuery({
    queryKey: ['assignable-users'],
    queryFn: () => api.get('/api/users/assignable').then((d) => d.data || []),
    enabled: open && canViewAll,
  });

  const teamsQuery = useQuery({
    queryKey: ['assignable-teams'],
    queryFn: () => api.get('/api/teams/assignable').then((d) => d.data || []),
    enabled: open && canViewAll,
  });

  const options = { categories: categoriesQuery.data || [], departments: departmentsQuery.data || [], users: usersQuery.data || [], teams: teamsQuery.data || [] };
  // Una consulta deshabilitada queda `isPending` para siempre, así que solo se
  // espera a las que están habilitadas de verdad.
  const loading =
    categoriesQuery.isPending ||
    departmentsQuery.isPending ||
    (canViewAll && (usersQuery.isPending || teamsQuery.isPending));

  useEffect(() => {
    if (!open) return;
    setForm({ ...EMPTY, ...Object.fromEntries(ADVANCED_KEYS.map((k) => [k, filters[k] ?? ''])) });
  }, [open, filters]);

  const set = (key, value) => setForm({ ...form, [key]: value });

  // La opción vacía ("Todos"/"Todas") del `<select>` nativo era seleccionable, así
  // que se mantiene como primera opción real y no como `placeholder`: con un
  // placeholder no se podría volver a ella. Orden y rótulos idénticos.
  const statusOptions = useMemo(
    () => [{ value: '', label: 'Todos' }, ...STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))],
    []
  );
  const priorityOptions = useMemo(
    () => [{ value: '', label: 'Todas' }, ...PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))],
    []
  );
  const categoryOptions = useMemo(
    () => [{ value: '', label: 'Todas' }, ...options.categories.map((c) => ({ value: c.id, label: c.name }))],
    [options.categories]
  );
  const departmentOptions = useMemo(
    () => [{ value: '', label: 'Todos' }, ...options.departments.map((d) => ({ value: d.id, label: d.name }))],
    [options.departments]
  );
  const userOptions = useMemo(
    () => [{ value: '', label: 'Todos' }, ...options.users.map((u) => ({ value: u.id, label: `${u.name} ${u.last_name}` }))],
    [options.users]
  );
  const teamOptions = useMemo(
    () => [
      { value: '', label: 'Todos' },
      ...options.teams.map((t) => ({
        value: t.id,
        label: `${t.name}${t.member_count ? ` (${t.member_count})` : ''}`,
      })),
    ],
    [options.teams]
  );

  function onReset() {
    setForm(EMPTY);
    onClear?.();
  }

  function apply() {
    // Si los filtros de directorio no son utilizables, tampoco se aplican: una
    // vista guardada con `?user=…` no debe recortar los resultados de alguien
    // que no puede ni ver ese selector.
    const next = canViewAll
      ? form
      : { ...form, ...Object.fromEntries(DIRECTORY_KEYS.map((k) => [k, ''])) };
    onApply(next);
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title="Búsqueda avanzada" wide>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="adv-status">Estado</label>
          <Select
            id="adv-status"
            options={statusOptions}
            value={form.status}
            onChange={(v) => set('status', v)}
          />
        </div>
        <div>
          <label className="label" htmlFor="adv-priority">Prioridad</label>
          <Select
            id="adv-priority"
            options={priorityOptions}
            value={form.priority}
            onChange={(v) => set('priority', v)}
          />
        </div>
        <div>
          <label className="label" htmlFor="adv-category">Categoría</label>
          <Select
            id="adv-category"
            options={categoryOptions}
            value={form.category}
            onChange={(v) => set('category', v)}
          />
        </div>
        <div>
          <label className="label" htmlFor="adv-department">Departamento</label>
          <Select
            id="adv-department"
            options={departmentOptions}
            value={form.department}
            onChange={(v) => set('department', v)}
          />
        </div>
        {canViewAll ? (
          <>
            <div>
              <label className="label" htmlFor="adv-user">Solicitante</label>
              <Select
                id="adv-user"
                options={userOptions}
                value={form.user}
                onChange={(v) => set('user', v)}
              />
            </div>
            <div>
              <label className="label" htmlFor="adv-assigned">Técnico asignado</label>
              <Select
                id="adv-assigned"
                options={[{ value: '', label: 'Todos' }, { value: 'none', label: 'Sin asignar' }, ...userOptions.slice(1)]}
                value={form.assigned}
                onChange={(v) => set('assigned', v)}
              />
            </div>
            <div className="sm:col-span-2">
              <label className="label" htmlFor="adv-team">Equipo asignado</label>
              <Select
                id="adv-team"
                options={teamOptions}
                value={form.team}
                onChange={(v) => set('team', v)}
              />
            </div>
          </>
        ) : (
          <p className="sm:col-span-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
            El filtrado por solicitante, técnico o equipo requiere permiso para ver todos los tickets.
          </p>
        )}

        <div className="sm:col-span-2">
          <label className="label" htmlFor="adv-from">Fecha de creación (desde)</label>
          <div className="grid gap-2 sm:grid-cols-2">
            <input id="adv-from" type="date" className="input" value={form.from} onChange={(e) => set('from', e.target.value)} />
            <input
              id="adv-to"
              type="date"
              className="input"
              aria-label="Fecha de creación (hasta)"
              value={form.to}
              onChange={(e) => set('to', e.target.value)}
            />
          </div>
          <p className="mt-1 text-xs text-slate-400">Desde / hasta (dejar vacío para no limitar).</p>
        </div>

        <div className="sm:col-span-2">
          <label className="label" htmlFor="adv-closed-from">Fecha de cierre (desde)</label>
          <div className="grid gap-2 sm:grid-cols-2">
            <input
              id="adv-closed-from"
              type="date"
              className="input"
              value={form.closed_from}
              onChange={(e) => set('closed_from', e.target.value)}
            />
            <input
              id="adv-closed-to"
              type="date"
              className="input"
              aria-label="Fecha de cierre (hasta)"
              value={form.closed_to}
              onChange={(e) => set('closed_to', e.target.value)}
            />
          </div>
        </div>
      </div>

      <div className="mt-5 flex items-center justify-between border-t border-slate-200 pt-4">
        <button type="button" className="btn-ghost" onClick={onReset}>
          Limpiar todo
        </button>
        <div className="flex gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancelar
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={apply}
          >
            {loading && <Spinner className="h-4 w-4 text-white" />}
            Aplicar filtros
          </button>
        </div>
      </div>
    </Modal>
  );
}
