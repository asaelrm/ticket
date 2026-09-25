import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Dashboard from './Dashboard';
import { api } from '../lib/api';
import { useTicketEventInvalidator } from '../lib/ticketEvents';
import { renderWithProviders } from '../test/utils';

vi.mock('../lib/ticketEvents', () => ({
  useTicketEventInvalidator: vi.fn(),
  subscribeTicketEvents: vi.fn(() => () => {}),
  notifyTicketEvent: vi.fn(),
  useTicketEvents: vi.fn(),
}));

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual('../lib/api');
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  };
});

function summary() {
  return {
    counts: { OPEN: 5, ASSIGNED: 3, IN_PROGRESS: 2, PENDING: 1, RESOLVED: 4 },
    critical: 7,
  };
}

function byStatus() {
  return { data: [{ status: 'OPEN', n: 5 }, { status: 'PENDING', n: 1 }] };
}

function byCategory() {
  return { data: [{ name: 'Hardware', n: 8, open: 3, color: '#64748b' }] };
}

function byDepartment() {
  return { data: [{ name: 'TI', n: 6, open: 2 }] };
}

function recent() {
  return {
    data: [
      { id: 1, ticket_number: 'TCK-000001', title: 'PC no enciende', category_name: 'Hardware', priority: 'HIGH', status: 'OPEN', created_at: '2026-09-20T10:00:00Z' },
    ],
  };
}

function sla(overrides = {}) {
  return {
    overdue: 1,
    atRisk: 2,
    healthy: 4,
    top: [
      { id: 5, ticket_number: 'TCK-000005', title: 'Impresora no imprime', reporter_name: 'Luis', priority: 'HIGH', sla_due_at: '2099-01-01T00:00:00Z', is_overdue: false },
    ],
    ...overrides,
  };
}

function setup(overrides = {}) {
  const payload = {
    summary: summary(),
    byStatus: byStatus(),
    byCategory: byCategory(),
    byDepartment: byDepartment(),
    recent: recent(),
    sla: sla(),
    ...overrides,
  };
  api.get.mockImplementation((url) => {
    if (url === '/api/dashboard/summary') return Promise.resolve(payload.summary);
    if (url === '/api/dashboard/by-status') return Promise.resolve(payload.byStatus);
    if (url === '/api/dashboard/by-priority') return Promise.resolve({ data: [{ priority: 'HIGH', n: 2 }] });
    if (url === '/api/dashboard/by-category') return Promise.resolve(payload.byCategory);
    if (url === '/api/dashboard/by-department') return Promise.resolve(payload.byDepartment);
    if (url === '/api/dashboard/trend?range=day') return Promise.resolve({ data: [{ label: '2026-09-01', created: 2, resolved: 1 }] });
    if (url === '/api/dashboard/recent') return Promise.resolve(payload.recent);
    if (url === '/api/dashboard/sla') return Promise.resolve(payload.sla);
    return Promise.reject(new Error(`404 ${url}`));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  setup();
});

function cardValue(label) {
  return within(screen.getByText(label).closest('.card')).getByText(/^\d+$/);
}

describe('Dashboard', () => {
  it('muestra el estado de carga mientras la API responde', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/api/dashboard/summary') return new Promise(() => {});
      if (url === '/api/dashboard/by-status') return Promise.resolve(byStatus());
      if (url === '/api/dashboard/by-priority') return Promise.resolve({ data: [] });
      if (url === '/api/dashboard/by-category') return Promise.resolve(byCategory());
      if (url === '/api/dashboard/by-department') return Promise.resolve(byDepartment());
      if (url === '/api/dashboard/trend?range=day') return Promise.resolve({ data: [] });
      if (url === '/api/dashboard/recent') return Promise.resolve({ data: [] });
      if (url === '/api/dashboard/sla') return Promise.resolve(sla());
      return Promise.reject(new Error(`404 ${url}`));
    });

    renderWithProviders(<Dashboard />, { route: '/app/dashboard' });
    expect(screen.getByText('Cargando dashboard…')).toBeInTheDocument();
  });

  it('muestra el error y permite reintentar', async () => {
    api.get.mockRejectedValueOnce(new Error('Fallo de red'));

    renderWithProviders(<Dashboard />, { route: '/app/dashboard' });
    expect(await screen.findByRole('alert')).toHaveTextContent('Fallo de red');

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));

    expect(await screen.findByText('PC no enciende')).toBeInTheDocument();
  });

  it('muestra las métricas y contadores', async () => {
    renderWithProviders(<Dashboard />, { route: '/app/dashboard' });

    expect(await screen.findByText('Abiertos')).toBeInTheDocument();
    expect(cardValue('Abiertos')).toHaveTextContent('5');
    expect(cardValue('Asignados')).toHaveTextContent('3');
    expect(cardValue('En proceso')).toHaveTextContent('2');
    expect(cardValue('Pendientes')).toHaveTextContent('1');
    expect(cardValue('Resueltos')).toHaveTextContent('4');
    expect(cardValue('Críticos')).toHaveTextContent('7');
    expect(api.get).toHaveBeenCalledWith('/api/dashboard/summary');
  });

  it('muestra el estado de atención SLA y la tabla de top tickets', async () => {
    renderWithProviders(<Dashboard />, { route: '/app/dashboard' });

    expect(await screen.findByText('TCK-000005')).toBeInTheDocument();
    expect(screen.getByText('Impresora no imprime')).toBeInTheDocument();
    expect(screen.getByText('Luis')).toBeInTheDocument();
    expect(screen.getByText('Vencidos').parentElement).toHaveTextContent('1');
    expect(screen.getByText('Próximas 24 h').parentElement).toHaveTextContent('2');
    expect(screen.getByText('Dentro de plazo').parentElement).toHaveTextContent('4');
    expect(screen.getByText(/Vence en/)).toBeInTheDocument();

    const overdueLink = screen.getByRole('link', { name: /Ver retrasados/ });
    expect(overdueLink).toHaveAttribute('href', '/app/tickets?view=overdue');
  });

  it('muestra tickets vencidos con aviso de SLA', async () => {
    setup({
      sla: sla({ top: [{ id: 5, ticket_number: 'TCK-000005', title: 'Impresora no imprime', reporter_name: 'Luis', priority: 'CRITICAL', sla_due_at: '2020-01-01T00:00:00Z', is_overdue: true }] }),
    });

    renderWithProviders(<Dashboard />, { route: '/app/dashboard' });
    await screen.findByText('TCK-000005');
    expect(screen.getByText(/Vencido hace/)).toBeInTheDocument();
  });

  it('muestra el mensaje cuando no hay tickets con SLA', async () => {
    setup({ sla: sla({ top: [] }) });

    renderWithProviders(<Dashboard />, { route: '/app/dashboard' });
    expect(await screen.findByText('Sin tickets abiertos con SLA definido.')).toBeInTheDocument();
  });

  it('muestra los gráficos por estado y los listados de categorías y departamentos', async () => {
    renderWithProviders(<Dashboard />, { route: '/app/dashboard' });

    expect(await screen.findByText('Tickets por estado')).toBeInTheDocument();
    expect(screen.getAllByText('Abierto').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Hardware').length).toBeGreaterThan(0);
    expect(screen.getByText('3 abiertos')).toBeInTheDocument();
    expect(screen.getByText('TI')).toBeInTheDocument();
    expect(screen.getByText('2 abiertos')).toBeInTheDocument();
    expect(screen.getByText('Actualizado a las')).toBeInTheDocument();
  });

  it('muestra los tickets recientes con sus enlaces', async () => {
    renderWithProviders(<Dashboard />, { route: '/app/dashboard' });

    await screen.findByText('TCK-000001');
    const ticketLink = screen.getByRole('link', { name: 'TCK-000001' });
    expect(ticketLink).toHaveAttribute('href', '/app/tickets/1');
    expect(screen.getByRole('link', { name: /PC no enciende/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Ver todos/ })).toHaveAttribute('href', '/app/tickets');
  });

  it('muestra "Sin datos" cuando no hay categorías ni departamentos', async () => {
    setup({ byCategory: { data: [] }, byDepartment: { data: [] } });

    renderWithProviders(<Dashboard />, { route: '/app/dashboard' });
    expect(await screen.findAllByText('Sin datos')).toHaveLength(2);
  });

  it('se suscribe a la invalidación por eventos de tickets', async () => {
    renderWithProviders(<Dashboard />, { route: '/app/dashboard' });
    await screen.findByText('Abiertos');

    expect(useTicketEventInvalidator).toHaveBeenCalledWith(['dashboard']);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/dashboard/summary'));
  });
});