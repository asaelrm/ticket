import React from 'react';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: Infinity,
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: false,
      },
    },
  });
}

export function renderWithProviders(ui, { queryClient, route = '/', path, ...options } = {}) {
  const client = queryClient || createQueryClient();
  const wrapper = ({ children }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path={path || '*'} element={ui} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { ...render(ui, { wrapper, ...options }), queryClient: client };
}