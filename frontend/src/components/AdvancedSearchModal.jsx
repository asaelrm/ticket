import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, STATUSES, PRIORITIES, STATUS_LABEL, PRIORITY_LABEL } from '../lib/api';
import { Modal, Spinner } from './ui';

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

export default function AdvancedSearchModal({ open, onClose, filters, onApply, onClear }) {
  const [form, setForm] = useState(EMPTY);
  const [options, setOptions] = useState({ categories: [], departments: [], users: [], teams: [] });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm({ ...EMPTY, ...Object.fromEntries(ADVANCED_KEYS.map((k) => [k, filters[k] ?? ''])) });
  }, [open, filters]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    Promise.all([
      api.get('/api/categories').then((d) => d.data || []).catch(() => []),
      api.get('/api/departments').then((d) => d.data || []).catch(() => []),
      api.get('/api/users/assignable')
        .then((d) => d.data || [])
        .catch(() => api.get('/api/users?perPage=100').then((d) => d.data || []).catch(() => [])),
      api.get('/api/teams/assignable').then((d) => d.data || []).catch(() => []),
    ])
      .then(([categories, departments, users, teams]) => {
        if (active) setOptions({ categories, departments, users, teams });
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [open]);

  const set = (key, value) => setForm({ ...form, [key]: value });

  function onReset() {
    setForm(EMPTY);
    onClear?.();
  }

  return (
    <Modal open={open} onClose={onClose} title="Búsqueda avanzada" wide>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label">Estado</label>
          <select className="input" value={form.status} onChange={(e) => set('status', e.target.value)}>
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
          <select className="input" value={form.priority} onChange={(e) => set('priority', e.target.value)}>
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
          <select className="input" value={form.category} onChange={(e) => set('category', e.target.value)}>
            <option value="">Todas</option>
            {options.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Departamento</label>
          <select className="input" value={form.department} onChange={(e) => set('department', e.target.value)}>
            <option value="">Todos</option>
            {options.departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Solicitante</label>
          <select className="input" value={form.user} onChange={(e) => set('user', e.target.value)}>
            <option value="">Todos</option>
            {options.users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} {u.last_name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Técnico asignado</label>
          <select className="input" value={form.assigned} onChange={(e) => set('assigned', e.target.value)}>
            <option value="">Todos</option>
            <option value="none">Sin asignar</option>
            {options.users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} {u.last_name}
              </option>
            ))}
          </select>
        </div>
        <div className="sm:col-span-2">
          <label className="label">Equipo asignado</label>
          <select className="input" value={form.team} onChange={(e) => set('team', e.target.value)}>
            <option value="">Todos</option>
            {options.teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.member_count ? ` (${t.member_count})` : ''}
              </option>
            ))}
          </select>
        </div>

        <div className="sm:col-span-2">
          <label className="label">Fecha de creación</label>
          <div className="grid gap-2 sm:grid-cols-2">
            <input type="date" className="input" value={form.from} onChange={(e) => set('from', e.target.value)} />
            <input type="date" className="input" value={form.to} onChange={(e) => set('to', e.target.value)} />
          </div>
          <p className="mt-1 text-xs text-slate-400">Desde / hasta (dejar vacío para no limitar).</p>
        </div>

        <div className="sm:col-span-2">
          <label className="label">Fecha de cierre</label>
          <div className="grid gap-2 sm:grid-cols-2">
            <input type="date" className="input" value={form.closed_from} onChange={(e) => set('closed_from', e.target.value)} />
            <input type="date" className="input" value={form.closed_to} onChange={(e) => set('closed_to', e.target.value)} />
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
            onClick={() => {
              onApply(form);
              onClose();
            }}
          >
            {loading && <Spinner className="h-4 w-4 text-white" />}
            Aplicar filtros
          </button>
        </div>
      </div>
    </Modal>
  );
}
