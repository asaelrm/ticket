import { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api';
import TicketFilters from '../components/TicketFilters';
import { TicketTable } from '../components/TicketTable';
import { LoadingScreen, ErrorBox } from '../components/ui';

const DEFAULT_FILTERS = { page: 1, perPage: 15 };

export default function MyTickets() {
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [list, setList] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async (f) => {
    setError('');
    try {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(f)) {
        if (v !== '' && v != null) params.append(k, v);
      }
      params.append('perPage', f.perPage || 15);
      params.append('own', '1');
      const data = await api.get(`/api/tickets?${params}`);
      setList(data);
    } catch (err) {
      setError(err.message || 'No se pudieron cargar los tickets');
    }
  }, []);

  useEffect(() => {
    // Debounce: evita una petición por cada tecla al escribir en la búsqueda.
    const timer = setTimeout(() => load(filters), 250);
    return () => clearTimeout(timer);
  }, [load, filters]);

  // Refresco silencioso en vivo cada 30 s (solo cuando la pestaña es visible).
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load(filters);
    }, 30000);
    return () => clearInterval(timer);
  }, [load, filters]);

  return (
    <div>
      <TicketFilters
        filters={filters}
        onChange={setFilters}
        onReset={() => setFilters(DEFAULT_FILTERS)}
        showUser={false}
      />
      {error && <ErrorBox message={error} />}
      {!list ? <LoadingScreen /> : <TicketTable list={list} basePath="/app/my-tickets" onPage={(page) => setFilters((p) => ({ ...p, page }))} />}
    </div>
  );
}