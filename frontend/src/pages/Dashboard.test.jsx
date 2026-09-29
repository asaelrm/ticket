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

// Por defecto el endpoint de triaje devuelve datos: aunque la sección ya no se
// pinta, el dashboard no debe pedirlo y las pruebas lo comprueban.
function attention() {
  return {
    data: [
      {
        id: 11,
        ticket_number: 'TCK-000011',
        title: 'Servidor caído',
        status: 'IN_PROGRESS',
        priority: 'CRITICAL',
        technician_name: 'Luis Pérez',
        category_name: 'Redes',
        sla_due_at: '2020-01-01T00:00:00Z',
        reasons: ['SLA_OVERDUE', 'CRITICAL'],
      },
    ],
    totals: { total: 1, overdue: 1, critical: 1, dueSoon: 0, unassigned: 0 },
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
    if (url === '/api/dashboard/by-category') return Promise.resolve(payload.byCategory);
    if (url === '/api/dashboard/by-department') return Promise.resolve(payload.byDepartment);
    if (url === '/api/dashboard/trend?range=day') return Promise.resolve({ data: [{ label: '2026-09-01', created: 2, resolved: 1 }] });
    if (url === '/api/dashboard/recent') return Promise.resolve(payload.recent);
    if (url === '/api/dashboard/sla') return Promise.resolve(payload.sla);
    // Sigue mockeado aunque nadie lo pida: así la prueba que afirma que el
    // dashboard NO lo llama no depende de un 404 que se trague un .catch().
    if (url === '/api/dashboard/needs-attention') return Promise.resolve(attention());
    return Promise.reject(new Error(`404 ${url}`));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  setup();
});

// Las seis tarjetas superiores son enlaces. Se localizan por el texto del rótulo
// y se devuelven como <a>, que es lo que hace clicables y navegables con teclado.
function shortcut(label) {
  return screen.getByRole('link', { name: new RegExp(`^${label}`) });
}

function cardValue(label) {
  return within(screen.getByText(label, { selector: 'p.truncate' }).closest('.card')).getByText(/^\d+$/);
}

// "Fuera de plazo" y "Por vencer" son rótulos que se repiten en varias tarjetas
// del dashboard, así que las aserciones de "Tiempos de atención" también se acotan.
function timesCard() {
  return screen.getByRole('link', { name: /Ver retrasados/ }).closest('.card');
}

function timesStat(label) {
  return within(timesCard()).getByText(label, { selector: 'p' }).parentElement;
}

describe('Dashboard', () => {
  it('muestra el estado de carga mientras la API responde', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/api/dashboard/summary') return new Promise(() => {});
      if (url === '/api/dashboard/by-status') return Promise.resolve(byStatus());
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

  it('muestra los tiempos de atención y la tabla de top tickets', async () => {
    renderWithProviders(<Dashboard />, { route: '/app/dashboard' });

    expect(await screen.findByText(/#TCK-000005/)).toBeInTheDocument();
    expect(screen.getByText('Impresora no imprime')).toBeInTheDocument();
    expect(screen.getByText('Luis')).toBeInTheDocument();
    expect(screen.getByText('Tiempos de atención')).toBeInTheDocument();
    expect(screen.getByText('Seguimiento de los tiempos establecidos según la prioridad')).toBeInTheDocument();
    expect(within(timesStat('Fuera de plazo')).getByText(/^\d+$/)).toHaveTextContent('1');
    expect(within(timesStat('Por vencer')).getByText(/^\d+$/)).toHaveTextContent('2');
    expect(within(timesStat('En tiempo')).getByText(/^\d+$/)).toHaveTextContent('4');
    expect(screen.getByText(/Vence en/)).toBeInTheDocument();

    const overdueLink = screen.getByRole('link', { name: /Ver retrasados/ });
    expect(overdueLink).toHaveAttribute('href', '/app/tickets?view=overdue');
  });

  it('no muestra la sigla SLA en los textos visibles', async () => {
    renderWithProviders(<Dashboard />, { route: '/app/dashboard' });

    await screen.findByText('Tiempos de atención');
    expect(within(timesCard()).queryByText(/SLA/)).not.toBeInTheDocument();
    expect(screen.getByText('Carga por técnico').closest('.card').textContent).not.toMatch(/SLA/);
  });

  it('muestra tickets fuera de plazo con su cuenta atrás', async () => {
    setup({
      sla: sla({ top: [{ id: 5, ticket_number: 'TCK-000005', title: 'Impresora no imprime', reporter_name: 'Luis', priority: 'CRITICAL', sla_due_at: '2020-01-01T00:00:00Z', is_overdue: true }] }),
    });

    renderWithProviders(<Dashboard />, { route: '/app/dashboard' });
    await screen.findByText(/#TCK-000005/);
    expect(within(timesCard()).getByText(/Vencido hace/)).toBeInTheDocument();
  });

  it('avisa cuando no hay tickets con tiempo de atención definido', async () => {
    setup({ sla: sla({ top: [] }) });

    renderWithProviders(<Dashboard />, { route: '/app/dashboard' });
    expect(await screen.findByText('Sin tickets abiertos con tiempo de atención definido.')).toBeInTheDocument();
  });

  it('muestra los gráficos por estado y los listados de categorías y departamentos', async () => {
    renderWithProviders(<Dashboard />, { route: '/app/dashboard' });

    expect(await screen.findByText('Tickets por estado')).toBeInTheDocument();
    expect(screen.getAllByText('Abierto').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Hardware').length).toBeGreaterThan(0);
    expect(screen.getByText('3 abiertos')).toBeInTheDocument();
    expect(screen.getByText('TI')).toBeInTheDocument();
    expect(screen.getByText('2 abiertos')).toBeInTheDocument();
    expect(screen.getByText(/Actualizado a las/)).toBeInTheDocument();
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

  // Accesos rápidos. Los destinos usan solo filtros que /api/tickets ya soporta:
  // `status` y `priority` son listas de su enum, y `active=1` acota a los estados
  // no terminales. Se comprueba el href exacto, que es lo que acabará navegando.
  it.each([
    ['Abiertos', '/app/tickets?status=OPEN'],
    ['Asignados', '/app/tickets?status=ASSIGNED'],
    ['En proceso', '/app/tickets?status=IN_PROGRESS'],
    ['Pendientes', '/app/tickets?status=PENDING'],
    ['Resueltos', '/app/tickets?status=RESOLVED'],
  ])('convierte la tarjeta "%s" en un acceso al filtro de tickets', async (label, href) => {
    renderWithProviders(<Dashboard />, { route: '/app/dashboard' });

    await screen.findByText('Abiertos');
    expect(shortcut(label)).toHaveAttribute('href', href);
  });

  it('lleva la tarjeta Críticos solo a los críticos activos', async () => {
    renderWithProviders(<Dashboard />, { route: '/app/dashboard' });

    await screen.findByText('Abiertos');
    // `active=1` es lo que hace que la lista cuadre con el contador: sin él
    // saldrían también los críticos ya resueltos, cerrados o cancelados.
    expect(shortcut('Críticos')).toHaveAttribute('href', '/app/tickets?priority=CRITICAL&active=1');
  });

  it('deja las tarjetas en el orden de tabulación y con foco visible', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Dashboard />, { route: '/app/dashboard' });

    await screen.findByText('Abiertos');
    // Es un <a href>, así que entra en el tabulador sin tabindex artificial y
    // Enter navega por la ruta del enlace sin ningún manejador propio.
    const card = shortcut('Abiertos');
    expect(card).not.toHaveAttribute('tabindex');
    await user.tab();
    expect(card).toHaveFocus();

    // El foco de teclado tiene que verse: sin `focus-visible` el usuario de
    // teclado no distingue dónde está.
    expect(card.className).toContain('focus-visible:outline-2');
    expect(card.className).toContain('cursor-pointer');
  });

  it('ya no pide ni muestra la sección "Requieren atención"', async () => {
    renderWithProviders(<Dashboard />, { route: '/app/dashboard' });

    await screen.findByText('Tiempos de atención');
    expect(screen.queryByText('Requieren atención')).not.toBeInTheDocument();
    expect(screen.queryByText('Tickets que requieren seguimiento inmediato')).not.toBeInTheDocument();
    expect(screen.queryByText(/No hay tickets que requieran atención/)).not.toBeInTheDocument();
    // El ticket del fixture de triaje no aparece por ninguna otra vía.
    expect(screen.queryByText('Servidor caído')).not.toBeInTheDocument();

    // El endpoint se conserva en el backend, pero el dashboard deja de llamarlo.
    expect(api.get).not.toHaveBeenCalledWith('/api/dashboard/needs-attention');
    expect(api.get.mock.calls.map(([url]) => url)).not.toContain('/api/dashboard/needs-attention');
  });

  it('mantiene el resto de secciones tras retirar el triaje', async () => {
    renderWithProviders(<Dashboard />, { route: '/app/dashboard' });

    await screen.findByText('Tiempos de atención');
    expect(screen.getByText('Carga por técnico')).toBeInTheDocument();
    expect(screen.getByText('Tickets por estado')).toBeInTheDocument();
    expect(screen.getByText('Tickets por categoría')).toBeInTheDocument();
    expect(screen.getByText('Tickets por departamento')).toBeInTheDocument();
    expect(screen.getByText('Tickets recientes')).toBeInTheDocument();
    expect(screen.getByText('Tendencia últimos 14 días')).toBeInTheDocument();
  });

  it('se suscribe a la invalidación por eventos de tickets', async () => {
    renderWithProviders(<Dashboard />, { route: '/app/dashboard' });
    await screen.findByText('Abiertos');

    expect(useTicketEventInvalidator).toHaveBeenCalledWith(['dashboard']);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/dashboard/summary'));
  });
});
