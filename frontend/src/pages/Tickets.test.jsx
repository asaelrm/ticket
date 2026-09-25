import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Tickets from './Tickets';
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
  open: 3,
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

const ADMIN = { id: 7, name: 'Admin', department_id: 3, permissions: ['ticket.export', 'ticket.assign', 'ticket.update.any'] };

beforeEach(() => {
  vi.clearAllMocks();
  authState.user = ADMIN;
  api.get.mockImplementation((url) => {
    if (url.startsWith('/api/tickets/counters')) return Promise.resolve(COUNTERS);
    if (url.startsWith('/api/tickets?')) return Promise.resolve(listResp());
    return Promise.reject(new Error(`404 ${url}`));
  });
});

describe('Tickets', () => {
  it('renderiza el listado recibido de la API', async () => {
    renderWithProviders(<Tickets />, { route: '/app/tickets' });

    expect(await screen.findByText('TCK-000001')).toBeInTheDocument();
    expect(screen.getByText('PC no enciende')).toBeInTheDocument();
    expect(screen.getByText('Exportar')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/tickets\?/));
    expect(api.get).toHaveBeenCalledWith('/api/tickets/counters');
  });

  it('muestra estado de carga mientras la API responde', async () => {
    let resolveList;
    api.get.mockImplementation((url) => {
      if (url.startsWith('/api/tickets/counters')) return Promise.resolve(COUNTERS);
      if (url.startsWith('/api/tickets?')) return new Promise((r) => { resolveList = r; });
      return Promise.reject(new Error('404'));
    });

    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    expect(screen.getAllByText('Cargando…').length).toBeGreaterThan(0);

    await act(async () => {
      resolveList(listResp());
    });
    expect(await screen.findByText('TCK-000001')).toBeInTheDocument();
  });

  it('muestra el error devuelto por la API', async () => {
    api.get.mockImplementation((url) => {
      if (url.startsWith('/api/tickets/counters')) return Promise.resolve(COUNTERS);
      return Promise.reject(new Error('Error 500'));
    });

    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    expect(await screen.findByRole('alert')).toHaveTextContent('Error 500');
  });

  it('aplica el filtro rápido "Abiertos" a la consulta', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByRole('button', { name: /Abiertos/ }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('view=open')));
  });

  it('cambia el orden y lo refleja en la consulta', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    await screen.findByText('TCK-000001');

    await user.selectOptions(screen.getByTitle('Ordenar por'), 'priority');
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('sort=priority')));
  });

  it('pagina a la siguiente página', async () => {
    const user = userEvent.setup();
    api.get.mockImplementation((url) => {
      if (url.startsWith('/api/tickets/counters')) return Promise.resolve(COUNTERS);
      if (url.startsWith('/api/tickets?')) return Promise.resolve(listResp([row()], 1, 2, 20));
      return Promise.reject(new Error('404'));
    });

    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    await screen.findByText('TCK-000001');

    const next = screen.getByRole('button', { name: /Siguiente/ });
    expect(next).toBeEnabled();
    await user.click(next);

    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('page=2')));
  });

  it('cambia el estado del ticket e invalida el listado', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    await screen.findByText('TCK-000001');

    const ticketCalls = () => api.get.mock.calls.filter(([u]) => u.startsWith('/api/tickets?')).length;
    const before = ticketCalls();

    await user.click(screen.getByRole('button', { name: '⋯' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Marcar en proceso' }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/tickets/1', { status: 'IN_PROGRESS' }));
    await waitFor(() => expect(ticketCalls()).toBeGreaterThan(before));
  });

  it('asigna el ticket al usuario actual', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByRole('button', { name: '⋯' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Asignarme a mí' }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/tickets/1', { assigned_to_id: 7 }));
  });

  it('oculta acciones y exportación cuando el usuario no tiene permisos', async () => {
    authState.user = { id: 7, name: 'Usuario', permissions: [] };

    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    await screen.findByText('TCK-000001');

    expect(screen.queryByRole('button', { name: '⋯' })).not.toBeInTheDocument();
    expect(screen.queryByText('Exportar')).not.toBeInTheDocument();
  });
});