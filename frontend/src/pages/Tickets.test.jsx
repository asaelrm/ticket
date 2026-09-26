import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Tickets from './Tickets';
import { api } from '../lib/api';
import { renderWithProviders } from '../test/utils';

const { authState, download } = vi.hoisted(() => ({
  authState: { user: null },
  download: vi.fn(),
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
    download,
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
    if (url === '/api/categories') return Promise.resolve({ data: [] });
    if (url === '/api/departments') return Promise.resolve({ data: [] });
    if (url === '/api/users/assignable') return Promise.resolve({ data: [] });
    if (url === '/api/teams/assignable') return Promise.resolve({ data: [] });
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
    await user.click(await screen.findByRole('menuitem', { name: /Marcar en proceso/ }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/tickets/1', { status: 'IN_PROGRESS' }));
    await waitFor(() => expect(ticketCalls()).toBeGreaterThan(before));
  });

  it('asigna el ticket al usuario actual', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByRole('button', { name: '⋯' }));
    await user.click(await screen.findByRole('menuitem', { name: /Asignarme a mí/ }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/tickets/1', { assigned_to_id: 7 }));
  });

  it('oculta acciones y exportación cuando el usuario no tiene permisos', async () => {
    authState.user = { id: 7, name: 'Usuario', permissions: [] };

    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    await screen.findByText('TCK-000001');

    expect(screen.queryByRole('button', { name: '⋯' })).not.toBeInTheDocument();
    expect(screen.queryByText('Exportar')).not.toBeInTheDocument();
  });

  it('abre y cierra el modal de búsqueda avanzada', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByRole('button', { name: /Búsqueda avanzada/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Búsqueda avanzada' });
    expect(dialog).toBeInTheDocument();
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/categories'));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/departments'));
    expect(api.get).toHaveBeenCalledWith('/api/users/assignable');
    expect(api.get).toHaveBeenCalledWith('/api/teams/assignable');

    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('dialog', { name: 'Búsqueda avanzada' })).not.toBeInTheDocument();
  });

  it('aplica filtros avanzados a la consulta', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByRole('button', { name: /Búsqueda avanzada/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Búsqueda avanzada' });

    await user.selectOptions(within(dialog).getAllByRole('combobox')[0], 'IN_PROGRESS');
    await user.click(within(dialog).getByRole('button', { name: 'Aplicar filtros' }));

    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('status=IN_PROGRESS')));

    const searchBtn = screen.getByRole('button', { name: /Búsqueda avanzada/ });
    expect(within(searchBtn).getByText('1')).toBeInTheDocument();
  });

  it('preselecciona los filtros avanzados desde la URL', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Tickets />, { route: '/app/tickets?status=PENDING&priority=HIGH' });
    await screen.findByText('TCK-000001');

    const searchBtn = screen.getByRole('button', { name: /Búsqueda avanzada/ });
    expect(within(searchBtn).getByText('2')).toBeInTheDocument();

    await user.click(searchBtn);
    const dialog = await screen.findByRole('dialog', { name: 'Búsqueda avanzada' });

    const combos = within(dialog).getAllByRole('combobox');
    expect(combos[0]).toHaveValue('PENDING');
    expect(combos[1]).toHaveValue('HIGH');
  });

  it('limpia los filtros avanzados aplicados', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Tickets />, { route: '/app/tickets?status=PENDING' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByRole('button', { name: /Búsqueda avanzada/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Búsqueda avanzada' });

    await user.click(within(dialog).getByRole('button', { name: 'Limpiar todo' }));

    await waitFor(() => {
      const calls = api.get.mock.calls.filter(([u]) => u.startsWith('/api/tickets?'));
      expect(calls.length).toBeGreaterThan(0);
      expect(calls[calls.length - 1][0]).not.toContain('status=');
    });
  });

  it('cancela un ticket con motivo y refresca el listado', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    await screen.findByText('TCK-000001');

    const ticketCalls = () => api.get.mock.calls.filter(([u]) => u.startsWith('/api/tickets?')).length;
    const before = ticketCalls();

    await user.click(screen.getByRole('button', { name: '⋯' }));
    await user.click(await screen.findByRole('menuitem', { name: /Cancelar ticket/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Cancelar TCK-000001' });
    const submit = within(dialog).getByRole('button', { name: 'Cancelar ticket' });
    expect(submit).toBeDisabled();

    await user.type(within(dialog).getByLabelText(/Motivo de cancelación/), 'El usuario ya no lo necesita');
    await user.click(submit);

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/tickets/1/cancel', { reason: 'El usuario ya no lo necesita' }));
    await waitFor(() => expect(ticketCalls()).toBeGreaterThan(before));
    expect(screen.queryByRole('dialog', { name: 'Cancelar TCK-000001' })).not.toBeInTheDocument();
  });

  it('muestra el error global cuando la cancelación falla', async () => {
    api.post.mockRejectedValueOnce(new Error('Motivo rechazado'));

    const user = userEvent.setup();
    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByRole('button', { name: '⋯' }));
    await user.click(await screen.findByRole('menuitem', { name: /Cancelar ticket/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Cancelar TCK-000001' });
    await user.type(within(dialog).getByLabelText(/Motivo de cancelación/), 'Intento fallido');
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar ticket' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Motivo rechazado');
  });

  it('exporta en CSV con los filtros actuales', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByRole('button', { name: 'Exportar' }));
    await user.click(await screen.findByRole('menuitem', { name: 'CSV' }));

    expect(download).toHaveBeenCalledWith('/api/tickets/export?');
  });

  it('incluye los filtros y excluye la paginación en la exportación', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByRole('button', { name: /Abiertos/ }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('view=open')));

    await user.click(screen.getByRole('button', { name: 'Exportar' }));
    await user.click(await screen.findByRole('menuitem', { name: 'CSV' }));

    expect(download).toHaveBeenLastCalledWith(expect.stringContaining('view=open'));
    expect(download.mock.lastCall[0]).not.toContain('sort=');
    expect(download.mock.lastCall[0]).not.toContain('page=');
  });

  it('exporta en XLSX y PDF con el parámetro de formato', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByRole('button', { name: 'Exportar' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Excel (XLSX)' }));
    expect(download).toHaveBeenCalledWith(expect.stringContaining('format=xlsx'));

    await user.click(screen.getByRole('button', { name: 'Exportar' }));
    await user.click(await screen.findByRole('menuitem', { name: 'PDF' }));
    expect(download).toHaveBeenCalledWith(expect.stringContaining('format=pdf'));
  });

  it('muestra exportación sin acciones cuando solo hay permiso de exportar', async () => {
    authState.user = { id: 7, name: 'Usuario', permissions: ['ticket.export'] };

    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    await screen.findByText('TCK-000001');

    expect(screen.getByText('Exportar')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '⋯' })).not.toBeInTheDocument();
  });
});

// El backend rechaza PATCH con RESOLVED/CLOSED: el menú de fila debe usar los
// endpoints dedicados igual que la bandeja.
describe('Tickets · acciones de estado con los endpoints dedicados', () => {
  const FULL = { id: 7, name: 'Admin', permissions: ['ticket.assign', 'ticket.update.any', 'ticket.resolve', 'ticket.close'] };

  it('resuelve por /resolve indicando la solución', async () => {
    const user = userEvent.setup();
    authState.user = FULL;
    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByRole('button', { name: '⋯' }));
    await user.click(await screen.findByRole('menuitem', { name: /Marcar resuelto/ }));

    // No se llama al backend hasta recoger la solución obligatoria.
    expect(api.post).not.toHaveBeenCalled();
    await user.type(await screen.findByLabelText(/Solución \/ trabajo realizado/), 'Se reinició el router');
    await user.click(screen.getByRole('button', { name: 'Resolver 1 ticket(s)' }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/api/tickets/1/resolve', { resolution: 'Se reinició el router' })
    );
    expect(api.patch).not.toHaveBeenCalledWith('/api/tickets/1', { status: 'RESOLVED' });
  });

  it('cierra por /close y mantiene PATCH para "en proceso"', async () => {
    const user = userEvent.setup();
    authState.user = FULL;
    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByRole('button', { name: '⋯' }));
    await user.click(await screen.findByRole('menuitem', { name: /Marcar en proceso/ }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/tickets/1', { status: 'IN_PROGRESS' }));

    await user.click(screen.getByRole('button', { name: '⋯' }));
    await user.click(await screen.findByRole('menuitem', { name: /Cerrar ticket/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/tickets/1/close', {}));
  });

  it('sigue cancelando por /cancel con el motivo obligatorio', async () => {
    const user = userEvent.setup();
    authState.user = FULL;
    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByRole('button', { name: '⋯' }));
    await user.click(await screen.findByRole('menuitem', { name: /Cancelar ticket/ }));

    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Motivo de cancelación/), 'Duplicado');
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar ticket' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/tickets/1/cancel', { reason: 'Duplicado' }));
  });
});