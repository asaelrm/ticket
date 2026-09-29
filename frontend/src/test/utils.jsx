import React from 'react';
import { render, screen } from '@testing-library/react';
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

/**
 * Elige una opción en un `Select`.
 *
 * Sustituye a `user.selectOptions()` para el componente propio: el control es un
 * botón `role="combobox"` y el menú se monta en `document.body` por el portal, así
 * que las opciones se buscan siempre en el documento completo, nunca dentro del
 * diálogo o tarjeta que contiene el control.
 */
export async function pickOption(user, trigger, optionName) {
  await user.click(trigger);
  await user.click(screen.getByRole('option', { name: optionName }));
}

/**
 * Devuelve las etiquetas de las opciones de un `Select` sin dejar el desplegable
 * abierto. Útil para comprobar qué permisos o filtros ofrece cada control: los
 * `<option>` solo existen en el DOM mientras el `listbox` está abierto.
 */
export async function optionLabels(user, trigger) {
  await user.click(trigger);
  const labels = screen.getByRole('listbox').querySelectorAll('[role="option"]');
  const texts = Array.from(labels, (o) => o.textContent);
  await user.keyboard('{Escape}');
  return texts;
}