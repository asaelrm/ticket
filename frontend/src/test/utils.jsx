import React from 'react';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  MemoryRouter,
  unstable_HistoryRouter as HistoryRouter,
  Routes,
  Route,
} from 'react-router-dom';

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

function normalizeEntry(entry) {
  const url = new URL(entry, 'https://tickets.test');
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Historia mínima con la interfaz que espera `HistoryRouter`, para poder
 * reproducir el botón atrás/adelante del navegador desde la prueba.
 *
 * `MemoryRouter` lleva su historial interno y `createMemoryRouter` dispara la
 * carga de datos de React Router, que en jsdom choca con el `AbortSignal` de
 * undici. Con `HistoryRouter` la navegación es la misma que la del navegador
 * (PUSH al filtrar, POP al atrás) sin pasar por ninguna petición real.
 */
function createTestHistory(initialEntry = '/') {
  const entries = [normalizeEntry(initialEntry)];
  let index = 0;
  const listeners = new Set();
  const current = () => entries[index];
  const toLocation = () => {
    const url = new URL(current(), 'https://tickets.test');
    return {
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
      state: null,
      key: String(index),
    };
  };
  // Resuelve contra la ruta actual para que '?view=open' no pierda el pathname.
  const resolve = (to) => {
    const url = new URL(current(), 'https://tickets.test');
    const raw = typeof to === 'string' ? to : `${to.pathname || ''}${to.search || ''}${to.hash || ''}`;
    const next = new URL(raw, `https://tickets.test${url.pathname}`);
    return `${next.pathname}${next.search}${next.hash}`;
  };
  const notify = (action) => {
    const location = toLocation();
    listeners.forEach((listener) => listener({ action, location }));
  };

  return {
    get action() { return 'POP'; },
    get index() { return index; },
    get length() { return entries.length; },
    get location() { return toLocation(); },
    push(to) {
      entries.splice(index + 1);
      entries.push(resolve(to));
      index = entries.length - 1;
      notify('PUSH');
    },
    replace(to) {
      entries[index] = resolve(to);
      notify('REPLACE');
    },
    go(delta) {
      const next = Math.min(Math.max(index + delta, 0), entries.length - 1);
      if (next === index) return;
      index = next;
      notify('POP');
    },
    listen(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    createHref(to) { return resolve(to); },
    block() { return () => {}; },
  };
}

/** Igual que `renderWithProviders`, pero con `history.go()` disponible. */
export function renderWithHistory(ui, { queryClient, route = '/', path, ...options } = {}) {
  const client = queryClient || createQueryClient();
  const history = createTestHistory(route);
  const result = render(
    <QueryClientProvider client={client}>
      <HistoryRouter history={history}>
        <Routes>
          <Route path={path || '*'} element={ui} />
        </Routes>
      </HistoryRouter>
    </QueryClientProvider>,
    options
  );
  return { ...result, history, queryClient: client };
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