import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Inbox from './Inbox';
import { api } from '../lib/api';
import { renderWithProviders } from '../test/utils';

const { authState } = vi.hoisted(() => ({
  authState: { user: null },
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: authState.user }),
  can: (user, permission) => !!user?.permissions?.includes(permission),
}));

vi.mock('../lib/ticketEvents', () => ({
  useTicketEventInvalidator: vi.fn(),
  subscribeTicketEvents: vi.fn(() => () => {}),
  notifyTicketEvent: vi.fn(),
}));

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual('../lib/api');
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  };
});

const COUNTERS = {
  open: 1,
  pending: 1,
  attended: 2,
  in_progress: 1,
  overdue: 1,
  assigned_to_me: 2,
  assigned_to_my_teams: 4,
  unassigned: 1,
  closed: { month: 5 },
};

function row(overrides = {}) {
  return {
    id: 1,
    ticket_number: 'TCK-000001',
    title: 'PC no enciende',
    status: 'OPEN',
    priority: 'HIGH',
    category_name: 'Hardware',
    reporter_name: 'Ana Díaz',
    created_at: '2026-09-20T10:00:00Z',
    updated_at: '2026-09-20T10:00:00Z',
    is_overdue: false,
    comment_count: 0,
    attachment_count: 0,
    ...overrides,
  };
}

function listResp(rows = [row()], page = 1, pages = 1, total = rows.length) {
  return { data: rows, total, page, pages, perPage: 15 };
}

const ADMIN = { id: 7, name: 'Admin', department_id: 3, permissions: ['ticket.assign', 'ticket.update.any'] };
// Técnico del seed: tiene ticket.assign/update.any/resolve/close.
const FULL = {
  id: 7,
  name: 'Admin',
  department_id: 3,
  permissions: ['ticket.assign', 'ticket.update.any', 'ticket.resolve', 'ticket.close'],
};

beforeEach(() => {
  vi.clearAllMocks();
  authState.user = ADMIN;
  api.get.mockImplementation((url) => {
    if (url.startsWith('/api/tickets/counters')) return Promise.resolve(COUNTERS);
    if (url.startsWith('/api/tickets?')) return Promise.resolve(listResp());
    if (url.startsWith('/api/categories')) return Promise.resolve({ data: [{ id: 1, name: 'Hardware' }] });
    if (url.startsWith('/api/users/assignable')) return Promise.resolve({ data: [{ id: 9, name: 'Beto', last_name: 'Gómez', department_name: 'TI' }] });
    return Promise.reject(new Error(`404 ${url}`));
  });
});

describe('Inbox', () => {
  it('renderiza las pestañas y el listado recibido', async () => {
    renderWithProviders(<Inbox />, { route: '/app/inbox' });

    expect(await screen.findByText('TCK-000001')).toBeInTheDocument();
    expect(screen.getByText('PC no enciende')).toBeInTheDocument();
    expect(screen.getByText('Asignados a mí')).toBeInTheDocument();
    expect(screen.getByText('Mi equipo')).toBeInTheDocument();
    expect(screen.getByText('Abiertos')).toBeInTheDocument();
    expect(screen.getByText('Sin asignar')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith(expect.stringContaining('view=mine'));
  });

  it('muestra estado de carga mientras la API responde', async () => {
    let resolveList;
    api.get.mockImplementation((url) => {
      if (url.startsWith('/api/tickets/counters')) return Promise.resolve(COUNTERS);
      if (url.startsWith('/api/tickets?')) return new Promise((r) => { resolveList = r; });
      if (url.startsWith('/api/categories')) return Promise.resolve({ data: [{ id: 1, name: 'Hardware' }] });
      return Promise.reject(new Error('404'));
    });

    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    expect(screen.getAllByText('Cargando…').length).toBeGreaterThan(0);

    await act(async () => {
      resolveList(listResp());
    });
    expect(await screen.findByText('TCK-000001')).toBeInTheDocument();
  });

  it('muestra contadores en las pestañas', async () => {
    renderWithProviders(<Inbox />, { route: '/app/inbox' });

    const mineTab = await screen.findByRole('button', { name: /Asignados a mí/ });
    expect(await within(mineTab).findByText('2')).toBeInTheDocument();
    expect(await within(screen.getByRole('button', { name: /Mi equipo/ })).findByText('4')).toBeInTheDocument();
  });

  it('cambia de pestaña y consulta la vista "open"', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByRole('button', { name: /^Abiertos/ }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('view=open')));
  });

  it('aplica el filtro de estado a la consulta', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    await user.selectOptions(screen.getByLabelText('Estado'), 'OPEN');
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('status=OPEN')));
  });

  it('cambia el estado del ticket e invalida el listado', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    const ticketCalls = () => api.get.mock.calls.filter(([u]) => u.startsWith('/api/tickets?')).length;
    const before = ticketCalls();

    await user.click(screen.getByRole('button', { name: '⋯' }));
    await user.click(await screen.findByRole('menuitem', { name: /Marcar en proceso/ }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/tickets/1', { status: 'IN_PROGRESS' }));
    await waitFor(() => expect(ticketCalls()).toBeGreaterThan(before));
  });

  it('asigna el ticket al usuario actual', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByRole('button', { name: '⋯' }));
    await user.click(await screen.findByRole('menuitem', { name: /Asignarme a mí/ }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/tickets/1', { assigned_to_id: 7 }));
  });

  it('asigna en lote los tickets seleccionados', async () => {
    const user = userEvent.setup();
    api.get.mockImplementation((url) => {
      if (url.startsWith('/api/tickets/counters')) return Promise.resolve(COUNTERS);
      if (url.startsWith('/api/tickets?')) {
        return Promise.resolve(
          listResp([row(), row({ id: 2, ticket_number: 'TCK-000002', title: 'Impresora atascada' })])
        );
      }
      if (url.startsWith('/api/categories')) return Promise.resolve({ data: [{ id: 1, name: 'Hardware' }] });
      return Promise.reject(new Error('404'));
    });

    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByLabelText('Seleccionar todos los de la página'));
    await user.click(await screen.findByRole('button', { name: /^Asignarme$/ }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/tickets/1', { assigned_to_id: 7 }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/tickets/2', { assigned_to_id: 7 }));
    expect(screen.queryByText(/2 seleccionado\(s\)/)).not.toBeInTheDocument();
  });
});

// El backend rechaza PATCH con RESOLVED/CLOSED (tickets.js:861) y exige los
// endpoints dedicados. Estos tests fijan ese contrato para las acciones masivas
// y para el menú de fila, que comparten la misma mutación.
describe('Inbox · acciones de estado con los endpoints dedicados', () => {
  function twoRows() {
    api.get.mockImplementation((url) => {
      if (url.startsWith('/api/tickets/counters')) return Promise.resolve(COUNTERS);
      if (url.startsWith('/api/tickets?')) {
        return Promise.resolve(
          listResp([row(), row({ id: 2, ticket_number: 'TCK-000002', title: 'Impresora atascada' })])
        );
      }
      if (url.startsWith('/api/categories')) return Promise.resolve({ data: [{ id: 1, name: 'Hardware' }] });
      return Promise.reject(new Error('404'));
    });
  }

  it('resuelve en lote con POST /resolve y el campo solución obligatorio', async () => {
    const user = userEvent.setup();
    authState.user = FULL;
    twoRows();

    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByLabelText('Seleccionar todos los de la página'));
    await user.click(await screen.findByRole('button', { name: /^Resuelto$/ }));

    // La caja pide la solución antes de tocar el backend.
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText(/Solución \/ trabajo realizado/)).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText(/Solución \/ trabajo realizado/), 'Se cambió la fuente de poder');
    await user.click(within(dialog).getByRole('button', { name: 'Resolver 2 ticket(s)' }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/api/tickets/1/resolve', { resolution: 'Se cambió la fuente de poder' })
    );
    expect(api.post).toHaveBeenCalledWith('/api/tickets/2/resolve', { resolution: 'Se cambió la fuente de poder' });
    // Nunca debe caer en el PATCH genérico que el backend rechaza.
    expect(api.patch).not.toHaveBeenCalledWith('/api/tickets/1', { status: 'RESOLVED' });
    expect(api.patch).not.toHaveBeenCalledWith('/api/tickets/2', { status: 'RESOLVED' });
  });

  it('no envía nada si la solución está vacía', async () => {
    const user = userEvent.setup();
    authState.user = FULL;
    twoRows();

    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');
    await user.click(screen.getByLabelText('Seleccionar todos los de la página'));
    await user.click(await screen.findByRole('button', { name: /^Resuelto$/ }));

    expect(await screen.findByRole('button', { name: 'Resolver 2 ticket(s)' })).toBeDisabled();
    expect(api.post).not.toHaveBeenCalled();
  });
  it('cierra en lote con POST /close y no con PATCH', async () => {
    const user = userEvent.setup();
    authState.user = FULL;
    twoRows();

    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');
    await user.click(screen.getByLabelText('Seleccionar todos los de la página'));
    await user.click(await screen.findByRole('button', { name: /^Cerrar$/ }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/tickets/1/close', {}));
    expect(api.post).toHaveBeenCalledWith('/api/tickets/2/close', {});
    expect(api.patch).not.toHaveBeenCalledWith('/api/tickets/1', { status: 'CLOSED' });
  });

  it('sólo modifica los tickets seleccionados', async () => {
    const user = userEvent.setup();
    authState.user = FULL;
    api.get.mockImplementation((url) => {
      if (url.startsWith('/api/tickets/counters')) return Promise.resolve(COUNTERS);
      if (url.startsWith('/api/tickets?')) {
        return Promise.resolve(
          listResp([
            row(),
            row({ id: 2, ticket_number: 'TCK-000002', title: 'Impresora atascada' }),
            row({ id: 3, ticket_number: 'TCK-000003', title: 'WiFi intermitente' }),
          ])
        );
      }
      if (url.startsWith('/api/categories')) return Promise.resolve({ data: [{ id: 1, name: 'Hardware' }] });
      return Promise.reject(new Error('404'));
    });

    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByLabelText('Seleccionar TCK-000001'));
    await user.click(screen.getByLabelText('Seleccionar TCK-000002'));
    expect(screen.getByText('2 seleccionado(s)')).toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: /^Cerrar$/ }));

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(api.post).toHaveBeenCalledWith('/api/tickets/1/close', {});
    expect(api.post).toHaveBeenCalledWith('/api/tickets/2/close', {});
    expect(api.post).not.toHaveBeenCalledWith('/api/tickets/3/close', {});
  });

  it('refresca el listado y los contadores tras el lote', async () => {
    const user = userEvent.setup();
    authState.user = FULL;
    twoRows();

    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    const listCalls = () => api.get.mock.calls.filter(([u]) => u.startsWith('/api/tickets?')).length;
    const counterCalls = () => api.get.mock.calls.filter(([u]) => u.startsWith('/api/tickets/counters')).length;
    const beforeList = listCalls();
    const beforeCounters = counterCalls();

    await user.click(screen.getByLabelText('Seleccionar todos los de la página'));
    await user.click(await screen.findByRole('button', { name: /^Cerrar$/ }));

    await waitFor(() => expect(listCalls()).toBeGreaterThan(beforeList));
    await waitFor(() => expect(counterCalls()).toBeGreaterThan(beforeCounters));
    await waitFor(() => expect(screen.queryByText(/seleccionado\(s\)/)).not.toBeInTheDocument());
  });

  it('informa el motivo real cuando parte del lote falla', async () => {
    const user = userEvent.setup();
    authState.user = FULL;
    twoRows();
    api.post.mockImplementation((url) => {
      if (url === '/api/tickets/1/close') {
        return Promise.reject(new Error('Debe registrar una resolución antes de cerrar el ticket.'));
      }
      return Promise.resolve({});
    });

    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');
    await user.click(screen.getByLabelText('Seleccionar todos los de la página'));
    await user.click(await screen.findByRole('button', { name: /^Cerrar$/ }));

    const alert = await screen.findByText(/1 de 2 ticket\(s\) no se pudieron actualizar/);
    expect(alert).toBeInTheDocument();
    expect(screen.getByText(/Debe registrar una resolución antes de cerrar el ticket/)).toBeInTheDocument();
    // El ticket que sí pudo cerrarse no se revierte por el fallo del otro.
    expect(api.post).toHaveBeenCalledWith('/api/tickets/2/close', {});
  });

  it('omite Resuelto y Cerrar sin ticket.resolve / ticket.close', async () => {
    const user = userEvent.setup();
    authState.user = ADMIN; // solo ticket.assign + ticket.update.any
    twoRows();

    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');
    await user.click(screen.getByLabelText('Seleccionar todos los de la página'));

    expect(await screen.findByRole('button', { name: /^En proceso$/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Resuelto$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Cerrar$/ })).not.toBeInTheDocument();
  });

  it('el menú de fila resuelve por /resolve en lugar de PATCH', async () => {
    const user = userEvent.setup();
    authState.user = FULL;
    twoRows();

    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getAllByRole('button', { name: '⋯' })[0]);
    await user.click(await screen.findByRole('menuitem', { name: /Marcar resuelto/ }));

    await user.type(await screen.findByLabelText(/Solución \/ trabajo realizado/), 'Se reinició el equipo');
    await user.click(screen.getByRole('button', { name: 'Resolver 1 ticket(s)' }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/api/tickets/1/resolve', { resolution: 'Se reinició el equipo' })
    );
    expect(api.patch).not.toHaveBeenCalledWith('/api/tickets/1', { status: 'RESOLVED' });
  });

  it('el menú de fila cierra por /close y mantiene PATCH para "en proceso"', async () => {
    const user = userEvent.setup();
    authState.user = FULL;
    twoRows();

    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getAllByRole('button', { name: '⋯' })[0]);
    await user.click(await screen.findByRole('menuitem', { name: /Marcar en proceso/ }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/tickets/1', { status: 'IN_PROGRESS' }));

    await user.click(screen.getAllByRole('button', { name: '⋯' })[0]);
    await user.click(await screen.findByRole('menuitem', { name: /Cerrar ticket/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/tickets/1/close', {}));
  });
});

// El backend exige ticket.assign para /api/users/assignable. La pantalla no
// debe pedir ese directorio a quien no puede asignar.
describe('Inbox · directorio de técnicos asignables', () => {
  it('lo carga para un usuario con ticket.assign y permite asignar en lote', async () => {
    const user = userEvent.setup();
    authState.user = FULL;
    api.get.mockImplementation((url) => {
      if (url.startsWith('/api/tickets/counters')) return Promise.resolve(COUNTERS);
      if (url.startsWith('/api/tickets?')) {
        return Promise.resolve(
          listResp([row(), row({ id: 2, ticket_number: 'TCK-000002', title: 'Impresora atascada' })])
        );
      }
      if (url.startsWith('/api/categories')) return Promise.resolve({ data: [{ id: 1, name: 'Hardware' }] });
      if (url.startsWith('/api/users/assignable')) {
        return Promise.resolve({ data: [{ id: 9, name: 'Beto', last_name: 'Gómez', department_name: 'TI' }] });
      }
      return Promise.reject(new Error('404'));
    });

    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');
    await user.click(screen.getByLabelText('Seleccionar todos los de la página'));

    expect(api.get).not.toHaveBeenCalledWith('/api/users/assignable');
    await user.click(await screen.findByRole('button', { name: 'Asignar a…' }));

    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/users/assignable'));
    await user.selectOptions(await screen.findByLabelText('Técnico asignado'), '9');
    await user.click(screen.getByRole('button', { name: 'Asignar' }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/tickets/1', { assigned_to_id: 9 }));
    expect(api.patch).toHaveBeenCalledWith('/api/tickets/2', { assigned_to_id: 9 });
  });

  it('no pide el directorio si el usuario no tiene ticket.assign', async () => {
    const user = userEvent.setup();
    authState.user = { id: 7, name: 'Sin asignar', permissions: ['ticket.update.any', 'ticket.resolve'] };

    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');
    await user.click(screen.getByLabelText('Seleccionar todos los de la página'));

    expect(screen.queryByRole('button', { name: 'Asignar a…' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Asignarme$/ })).not.toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalledWith('/api/users/assignable');
  });
});