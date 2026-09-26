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