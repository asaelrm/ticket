import { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import TicketFilters from '../components/TicketFilters';
import { TicketTable } from '../components/TicketTable';
import { LoadingScreen, ErrorBox } from '../components/ui';
import { Link } from 'react-router-dom';

const DEFAULT_FILTERS = { page: 1, perPage: 15 };

export default function Tickets() {
  const { user } = useAuth();
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [list, setList] = useState(null);
  const [error, setError] = useState('');
  const canExport = user?.permissions?.includes('ticket.export');

  const load = useCallback(async (f) => {
    setError('');
    try {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(f)) {
        if (v !== '' && v != null && v !== 'none') params.append(k, v);
      }
      params.append('perPage', f.perPage || 15);
      const data = await api.get(`/api/tickets?${params}`);
      setList(data);
    } catch (err) {
      setError(err.message || 'No se pudieron cargar los tickets');
    }
  }, []);

  useEffect(() => {
    load(filters);
  }, [load, filters]);

  function exportCsv() {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) {
      if (v !== '' && v != null && v !== 'none' && !['page', 'perPage'].includes(k)) params.append(k, v);
    }
    const url = `/api/tickets/export?${params}`;
    const a = document.createElement('a');
    a.href = url;
    a.click();
  }

  return (
    <div>
      <TicketFilters
        filters={filters}
        onChange={setFilters}
        onReset={() => setFilters(DEFAULT_FILTERS)}
        showUser
      />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-500">
          {list ? `${list.total} tickets encontrados` : 'Cargando…'}
        </p>
        <div className="flex gap-2">
          {canExport && (
            <button type="button" className="btn-secondary" onClick={exportCsv}>
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
              </svg>
              Exportar CSV
            </button>
          )}
          <Link to="/app/new-ticket" className="btn-primary">
            + Reportar
          </Link>
        </div>
      </div>
      {error && <ErrorBox message={error} />}
      {!list ? <LoadingScreen /> : <TicketTable list={list} basePath="/app/tickets" onPage={(page) => setFilters((p) => ({ ...p, page }))} />}
    </div>
  );
}