import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, STATUSES, PRIORITIES, STATUS_LABEL, PRIORITY_LABEL } from '../lib/api';

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
            <label className="label">Estado</label>
            <select className="input" value={filters.status || ''} onChange={(e) => set('status', e.target.value)}>
              <option value="">Todos</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Prioridad</label>
            <select className="input" value={filters.priority || ''} onChange={(e) => set('priority', e.target.value)}>
              <option value="">Todas</option>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABEL[p]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Categoría</label>
            <select className="input" value={filters.category || ''} onChange={(e) => set('category', e.target.value)}>
              <option value="">Todas</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          {showUser && (
            <div>
              <label className="label">Usuario</label>
              <select className="input" value={filters.user || ''} onChange={(e) => set('user', e.target.value)}>
                <option value="">Todos</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} {u.last_name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className="label">Departamento</label>
            <select className="input" value={filters.department || ''} onChange={(e) => set('department', e.target.value)}>
              <option value="">Todos</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Período</label>
            <select className="input" value={filters.period || ''} onChange={(e) => set('period', e.target.value)}>
              <option value="">—</option>
              {PERIODS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
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