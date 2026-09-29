import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, STATUSES, PRIORITIES, STATUS_LABEL, PRIORITY_LABEL } from '../lib/api';
import Select from './Select';

const PERIODS = [
  ['today', 'Hoy'],
  ['week', 'Esta semana'],
  ['month', 'Este mes'],
  ['year', 'Este año'],
];

export default function TicketFilters({ showUser, onChange, onReset, filters }) {
  const [expanded, setExpanded] = useState(false);

  const { data: categories = [] } = useQuery({
    queryKey: ['categories-active'],
    queryFn: () => api.get('/api/categories?active=1').then((d) => d.data || []),
  });

  const { data: departments = [] } = useQuery({
    queryKey: ['active-departments'],
    queryFn: () => api.get('/api/departments?active=1').then((d) => d.data || []),
  });

  const { data: users = [] } = useQuery({
    queryKey: ['users-all'],
    queryFn: () => api.get('/api/users?perPage=100').then((d) => d.data || []),
    enabled: showUser,
  });

  const set = (key, value) => onChange({ ...filters, [key]: value, page: 1 });

  // La opción vacía de cada `<select>` era seleccionable, así que se mantiene
  // como primera opción real y no como `placeholder`: así se puede volver a ella,
  // igual que en el nativo. El resto conserva orden y rótulo.
  const statusOptions = useMemo(
    () => [{ value: '', label: 'Todos' }, ...STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))],
    []
  );
  const priorityOptions = useMemo(
    () => [{ value: '', label: 'Todas' }, ...PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))],
    []
  );
  const categoryOptions = useMemo(
    () => [{ value: '', label: 'Todas' }, ...categories.map((c) => ({ value: c.id, label: c.name }))],
    [categories]
  );
  const departmentOptions = useMemo(
    () => [{ value: '', label: 'Todos' }, ...departments.map((d) => ({ value: d.id, label: d.name }))],
    [departments]
  );
  const userOptions = useMemo(
    () => [{ value: '', label: 'Todos' }, ...users.map((u) => ({ value: u.id, label: `${u.name} ${u.last_name}` }))],
    [users]
  );
  const periodOptions = useMemo(
    () => [{ value: '', label: '—' }, ...PERIODS.map(([v, l]) => ({ value: v, label: l }))],
    []
  );

  const activeCount = Object.entries({
    search: filters.search,
    status: filters.status,
    priority: filters.priority,
    category: filters.category,
    department: filters.department,
    user: filters.user,
    assigned: filters.assigned,
    period: filters.period,
    date: filters.date,
    from: filters.from,
    to: filters.to,
  }).filter(([, v]) => v && v !== 'none').length;

  return (
    <div className="card mb-4">
      <div className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center">
        <div className="relative flex-1">
          <svg className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="7" />
            <path strokeLinecap="round" d="m20 20-3.5-3.5" />
          </svg>
          <input
            className="input !pl-9"
            value={filters.search}
            onChange={(e) => set('search', e.target.value)}
            placeholder="Buscar por número, título, texto…"
          />
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-secondary" type="button" onClick={() => setExpanded(!expanded)}>
            Filtros
            {activeCount > 0 && (
              <span className="badge bg-brand-600 text-white">{activeCount}</span>
            )}
          </button>
          {activeCount > 0 && (
            <button className="btn-ghost text-sm" type="button" onClick={onReset}>
              Limpiar
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="grid gap-3 border-t border-slate-200 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="label" htmlFor="tf-status">Estado</label>
            <Select
              id="tf-status"
              options={statusOptions}
              value={filters.status || ''}
              onChange={(v) => set('status', v)}
            />
          </div>
          <div>
            <label className="label" htmlFor="tf-priority">Prioridad</label>
            <Select
              id="tf-priority"
              options={priorityOptions}
              value={filters.priority || ''}
              onChange={(v) => set('priority', v)}
            />
          </div>
          <div>
            <label className="label" htmlFor="tf-category">Categoría</label>
            <Select
              id="tf-category"
              options={categoryOptions}
              value={filters.category || ''}
              onChange={(v) => set('category', v)}
            />
          </div>
          {showUser && (
            <div>
              <label className="label" htmlFor="tf-user">Usuario</label>
              <Select
                id="tf-user"
                options={userOptions}
                value={filters.user || ''}
                onChange={(v) => set('user', v)}
              />
            </div>
          )}
          <div>
            <label className="label" htmlFor="tf-department">Departamento</label>
            <Select
              id="tf-department"
              options={departmentOptions}
              value={filters.department || ''}
              onChange={(v) => set('department', v)}
            />
          </div>
          <div>
            <label className="label" htmlFor="tf-period">Período</label>
            <Select
              id="tf-period"
              options={periodOptions}
              value={filters.period || ''}
              onChange={(v) => set('period', v)}
            />
          </div>
          <div>
            <label className="label">Fecha exacta</label>
            <input
              type="date"
              className="input"
              value={filters.date || ''}
              onChange={(e) => set('date', e.target.value)}
            />
          </div>
          <div className="sm:col-span-2 lg:col-span-1">
            <label className="label">Desde / Hasta</label>
            <div className="flex gap-2">
              <input
                type="date"
                className="input"
                value={filters.from || ''}
                onChange={(e) => set('from', e.target.value)}
              />
              <input
                type="date"
                className="input"
                value={filters.to || ''}
                onChange={(e) => set('to', e.target.value)}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}