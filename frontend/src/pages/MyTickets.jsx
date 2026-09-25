import { useEffect, useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useTicketEventInvalidator } from '../lib/ticketEvents';
import TicketFilters from '../components/TicketFilters';
import { TicketTable } from '../components/TicketTable';
import { LoadingScreen, ErrorBox } from '../components/ui';

const DEFAULT_FILTERS = { page: 1, perPage: 15 };

export default function MyTickets() {
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [debounced, setDebounced] = useState(DEFAULT_FILTERS);

  // Debounce: evita una petición por cada tecla al escribir en la búsqueda.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(filters), 250);
    return () => clearTimeout(timer);
  }, [filters]);

  const { data: list, error: queryError } = useQuery({
    queryKey: ['my-tickets', debounced],
    queryFn: async () => {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(debounced)) {
        if (v !== '' && v != null) params.append(k, v);
      }
      params.append('perPage', debounced.perPage || 15);
      params.append('own', '1');
      return api.get(`/api/tickets?${params}`);
    },
    // Conserva los datos anteriores al cambiar filtros (igual que el original, que no limpiaba la lista).
    placeholderData: keepPreviousData,
  });

  // Tiempo real por SSE (conexión global); sin polling de lista.
  useTicketEventInvalidator(['my-tickets']);

  return (
    <div>
      <TicketFilters
        filters={filters}
        onChange={setFilters}
        onReset={() => setFilters(DEFAULT_FILTERS)}
        showUser={false}
      />
      {queryError && <ErrorBox message={queryError.message || 'No se pudieron cargar los tickets'} />}
      {!list ? <LoadingScreen /> : <TicketTable list={list} basePath="/app/my-tickets" onPage={(page) => setFilters((p) => ({ ...p, page }))} />}
    </div>
  );
}