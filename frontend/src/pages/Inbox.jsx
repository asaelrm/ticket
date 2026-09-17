import { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api';
import { TicketTable } from '../components/TicketTable';
import { LoadingScreen, ErrorBox } from '../components/ui';
import { useAuth } from '../context/AuthContext';

const TABS = [
  { key: 'mine', label: 'Asignados a mí' },
  { key: 'my-teams', label: 'Mi equipo' },
  { key: 'open', label: 'Abiertos' },
  { key: 'unassigned', label: 'Sin asignar' },
];

export default function Inbox() {
  const { user } = useAuth();
  const [tab, setTab] = useState('mine');
  const [filters, setFilters] = useState({ page: 1, perPage: 15 });
  const [list, setList] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const query = useCallback(() => {
    const params = new URLSearchParams();
    params.append('perPage', filters.perPage || 15);
    params.append('view', tab === 'unassigned' ? 'open' : tab);
    params.append('active', '1');
    if (tab === 'unassigned') params.append('assigned', 'none');
    return params.toString();
  }, [tab, filters]);

  const load = useCallback(async () => {
    setError('');
    try {
      const data = await api.get(`/api/tickets?${query()}`);
      setList(data);
    } catch (err) {
      setError(err.message || 'No se pudieron cargar los tickets');
    }
  }, [query]);

  useEffect(() => {
    setList(null);
    load();
  }, [load, tab]);

  const canManage = user?.permissions?.includes('ticket.update.any');
  const canAssign = user?.permissions?.includes('ticket.assign');

  async function changeStatus(t, status, body = {}) {
    setBusy(true);
    setError('');
    try {
      if (status === 'CANCELLED') {
        await api.post(`/api/tickets/${t.id}/cancel`, body);
      } else {
        await api.patch(`/api/tickets/${t.id}`, { status });
      }
      await load();
    } catch (err) {
      setError(err.message || 'No se pudo actualizar el ticket');
    } finally {
      setBusy(false);
    }
  }

  async function assignMe(t) {
    setBusy(true);
    setError('');
    try {
      await api.patch(`/api/tickets/${t.id}`, { assigned_to_id: user.id });
      await load();
    } catch (err) {
      setError(err.message || 'No se pudo asignar el ticket');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => {
              setTab(t.key);
              setFilters((p) => ({ ...p, page: 1 }));
            }}
            className={`rounded-full border px-4 py-1.5 text-sm font-medium transition ${
              tab === t.key
                ? 'border-brand-600 bg-brand-600 text-white'
                : 'border-slate-200 bg-white text-slate-600 hover:border-brand-300 hover:text-brand-700'
            }`}
          >
            {t.label}
          </button>
        ))}
        {busy && <span className="inline-flex items-center text-sm text-slate-400">Actualizando…</span>}
      </div>

      {error && <ErrorBox message={error} />}
      {!list ? (
        <LoadingScreen />
      ) : (
        <TicketTable
          list={list}
          basePath="/app/tickets"
          canAssign={canAssign}
          canManage={canManage}
          onAssignMe={assignMe}
          onStatusChange={(t, status, body) => changeStatus(t, status, body)}
          onPage={(page) => setFilters((p) => ({ ...p, page }))}
        />
      )}
    </div>
  );
}