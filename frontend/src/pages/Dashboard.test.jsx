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

// `open` es el número de tickets NO TERMINALES de la fila y `n` el total de sus
// tickets. El panel usa `open` para decidir qué muestra y qué esconde, así que
// el fixture incluye a propósito una categoría con tickets ya terminados
// (`Red`: n>0 pero open=0) y otra sin ninguno: ambas quedan ocultas por
// defecto y solo aparecen al pulsar "Ver todas".
function byCategory() {
  return {
    data: [
      { id: 11, name: 'Hardware', n: 8, open: 3, color: '#64748b' },
      { id: 12, name: 'Red', n: 5, open: 0, color: '#0891b2' },
      { id: 13, name: 'Accesos', n: 0, open: 0, color: '#ea580c' },
    ],
  };
}

function byDepartment() {
  return {
    data: [
      { id: 4, name: 'TI', n: 6, open: 2 },
      { id: 5, name: 'Finanzas', n: 3, open: 0 },
      { id: 6, name: 'Ventas', n: 0, open: 0 },
    ],
  };
}

function byTechnician() {
  return {
    data: [
      {
        id: 21,
        technician: 'Luis Pérez',
        position: 'Soporte técnico',
        active: 4,
        open: 1,
        assigned: 1,
        in_progress: 1,
        pending: 1,
        overdue: 1,
      },
    ],
    unassigned: 3,
    totals: { technicians: 1, active: 4, overdue: 1 },
  };
}

// El endpoint real devuelve `id` (lo usa /app/tickets/<id>), la categoría y el
// técnico asignado. `reporter_name` también viene, aunque la tabla no lo usa.
function recent() {
  return {
    data: [
      {
        id: 1,
        ticket_number: 'TCK-000001',
        title: 'PC no enciende',
        category_name: 'Hardware',
        priority: 'HIGH',
        status: 'OPEN',
        assigned_name: 'Luis Pérez',
        reporter_name: 'Ana Díaz',
        created_at: '2026-09-20T10:00:00Z',
      },
    ],
  };
}

function trend() {
  return { data: [{ label: '2026-09-01', created: 2, resolved: 1 }] };
}

// Un período sin ningún ticket creado ni resuelto: todos los contadores a cero.
function flatTrend() {
  return {
    data: Array.from({ length: 14 }, (_, i) => ({
      label: `2026-09-${String(i + 1).padStart(2, '0')}`,
      created: 0,
      resolved: 0,
    })),
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
    trend: trend(),
    recent: recent(),
    sla: sla(),
    ...overrides,
  };
  api.get.mockImplementation((url) => {
    if (url === '/api/dashboard/summary') return Promise.resolve(payload.summary);
    if (url === '/api/dashboard/by-status') return Promise.resolve(payload.byStatus);
    if (url === '/api/dashboard/by-category') return Promise.resolve(payload.byCategory);
    if (url === '/api/dashboard/by-department') return Promise.resolve(payload.byDepartment);
    if (url === '/api/dashboard/trend?range=day') return Promise.resolve(payload.trend);
    if (url === '/api/dashboard/recent') return Promise.resolve(payload.recent);
    if (url === '/api/dashboard/sla') return Promise.resolve(payload.sla);
    // Por defecto el reparto de carga no llega: es lo que hace que el panel
    // degrada a vacío, y deja el resto del dashboard sin letras repetidas que
    // ambigüen las consultas. Las pruebas que necesitan técnico lo pasan.
    if (url === '/api/dashboard/by-technician') {
      return payload.byTechnician ? Promise.resolve(payload.byTechnician) : Promise.reject(new Error('404'));
    }
    // Sigue mockeado aunque nadie lo pida: así la prueba que afirma que el
    // dashboard NO lo llama no depende de un 404 que se trague un .catch().
    if (url === '/api/dashboard/needs-attention') return Promise.resolve(attention());
    return Promise.reject(new Error(`404 ${url}`));
  });
}

// Espera a que el panel de categorías esté en pantalla. Se usa en lugar de
// `findByText('Hardware')` porque ese mismo nombre aparece también en la
// columna "Categoría" de los tickets recientes: son dos elementos distintos y
// la búsqueda would match de ambos.
async function renderDashboard() {
  renderWithProviders(<Dashboard />, { route: '/app/dashboard' });
  return screen.findByRole('heading', { name: 'Tickets por categoría' });
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

// Los dos paneles de listados tienen su propio interruptor "Ver todas", así que
// las consultas se acotan a la tarjeta buscada: `getByRole` a pantalla completa
// las confundiría entre sí.
function categoryPanel() {
  return screen.getByRole('heading', { name: 'Tickets por categoría' }).closest('.card');
}

function departmentPanel() {
  return screen.getByRole('heading', { name: 'Tickets por departamento' }).closest('.card');
}

function trendPanel() {
  return screen.getByRole('heading', { name: 'Tendencia últimos 14 días' }).closest('.card');
}

function technicianCard() {
  return screen.getByRole('heading', { name: 'Carga por técnico' }).closest('.card');
}

function recentCard() {
  return screen.getByRole('heading', { name: 'Tickets recientes' }).closest('.card');
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

  // La carga ya no es un spinner: es el esqueleto de la propia pantalla, con la
  // forma del dashboard. Se comprueba que el hueco tiene las mismas piezas que el
  // contenido —los seis accesos, los siete paneles y las tres tablas— y que sigue
  // siendo una región anunciable para la tecnología de asistencia técnica.
  it('sustituye la carga por un esqueleto con la forma del dashboard', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/api/dashboard/summary') return new Promise(() => {});
      return Promise.reject(new Error(`404 ${url}`));
    });

    renderWithProviders(<Dashboard />, { route: '/app/dashboard' });

    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(within(region).getByText('Cargando dashboard…')).toBeInTheDocument();

    // Seis accesos rápidos, siete paneles y tres tablas: los huecos que luego
    // ocupa el contenido, ni uno más ni uno menos.
    expect(region.querySelectorAll('.skeleton').length).toBeGreaterThan(0);
    expect(region.querySelectorAll('.card')).toHaveLength(13);
    expect(region.querySelectorAll('table')).toHaveLength(3);
    // El esqueleto no inventa contenido: mientras carga no hay cifras ni enlaces.
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByText('Abiertos')).not.toBeInTheDocument();
  });

  // El esqueleto tiene que ocupar el sitio del contenido real: al llegar los
  // datos la página no puede dar un salto. Se comprueba que replica las clases
  // que fijan la medida —rejillas, cajas de la gráfica y celdas de las tablas—,
  // porque es su relleno el que hace que cada fila mida lo mismo con esqueleto y
  // con datos.
  it('el esqueleto replica la medida del contenido que sustituye', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/api/dashboard/summary') return new Promise(() => {});
      return Promise.reject(new Error(`404 ${url}`));
    });

    renderWithProviders(<Dashboard />, { route: '/app/dashboard' });

    const region = screen.getByRole('status');
    // Rejilla de los accesos rápidos (2 / 3 / 6 columnas) y caja de la gráfica.
    expect(region.querySelector('.grid.grid-cols-2.md\\:grid-cols-3.xl\\:grid-cols-6')).toBeInTheDocument();
    expect(region.querySelector('.h-40')).toBeInTheDocument();
    // Celdas reales de tabla, no filas de altura fija.
    expect(region.querySelectorAll('.th').length).toBeGreaterThan(0);
    expect(region.querySelectorAll('.td').length).toBeGreaterThan(0);
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

// Navegación del dashboard al listado y a la ficha. Todos los destinos usan
// parámetros que Tickets.jsx ya lee de la URL (`category`, `department`,
// `assigned`, `active`), así que se comprueba el href exacto: es lo que
// acabará navegando y lo que Tickets.test.jsx verifica que llega a /api/tickets.
describe('Dashboard · navegación a Tickets', () => {
  it('oculta por defecto las categorías sin tickets abiertos y las revela con "Ver todas"', async () => {
    const user = userEvent.setup();
    await renderDashboard();

    // "Hardware" tiene 3 abiertos: es la única que se muestra.
    expect(within(categoryPanel()).getByRole('link', { name: /Hardware/ })).toBeInTheDocument();
    // "Red" tiene tickets pero todos ya terminales (open=0) y "Accesos" no
    // tiene ninguno: ninguna de las dos debe ocupar sitio en la vista.
    expect(within(categoryPanel()).queryByRole('link', { name: /^Red/ })).not.toBeInTheDocument();
    expect(within(categoryPanel()).queryByRole('link', { name: /Accesos/ })).not.toBeInTheDocument();

    await user.click(within(categoryPanel()).getByRole('button', { name: 'Ver todas' }));

    expect(within(categoryPanel()).getByRole('link', { name: /^Red/ })).toBeInTheDocument();
    expect(within(categoryPanel()).getByRole('link', { name: /Accesos/ })).toBeInTheDocument();
    // Con todo a la vista ya no queda nada que alternar.
    expect(within(categoryPanel()).queryByRole('button', { name: 'Ver todas' })).not.toBeInTheDocument();

    await user.click(within(categoryPanel()).getByRole('button', { name: 'Ocultar vacías' }));
    expect(within(categoryPanel()).queryByRole('link', { name: /Accesos/ })).not.toBeInTheDocument();
    expect(within(categoryPanel()).getByRole('link', { name: /Hardware/ })).toBeInTheDocument();
  });

  it('no ofrece el interruptor cuando todas las categorías tienen tickets abiertos', async () => {
    setup({ byCategory: { data: [{ id: 11, name: 'Hardware', n: 8, open: 3 }] } });

    await renderDashboard();
    expect(within(categoryPanel()).queryByRole('button', { name: /Ver todas|Ocultar vacías/ })).not.toBeInTheDocument();
  });

  it('avisa cuando existen categorías pero ninguna tiene tickets abiertos', async () => {
    setup({ byCategory: { data: [{ id: 13, name: 'Accesos', n: 0, open: 0 }] } });

    await renderDashboard();
    expect(await screen.findByText('Ninguna categoría tiene tickets abiertos.')).toBeInTheDocument();
    // El interruptor sigue disponible: hay algo que enseñar.
    expect(within(categoryPanel()).getByRole('button', { name: 'Ver todas' })).toBeInTheDocument();
  });

  it('enlaza cada categoría visible con el listado filtrado por ella', async () => {
    await renderDashboard();

    // `category` y `active=1` son los dos filtros que parseFilters de
    // Tickets.jsx lee y que buildConditions de /api/tickets aplica.
    expect(within(categoryPanel()).getByRole('link', { name: /Hardware/ })).toHaveAttribute(
      'href',
      '/app/tickets?category=11&active=1'
    );
  });

  it('oculta los departamentos sin tickets abiertos y permite verlos todos', async () => {
    const user = userEvent.setup();
    await renderDashboard();

    expect(within(departmentPanel()).getByRole('link', { name: /^TI/ })).toBeInTheDocument();
    expect(within(departmentPanel()).queryByRole('link', { name: /Finanzas/ })).not.toBeInTheDocument();
    expect(within(departmentPanel()).queryByRole('link', { name: /Ventas/ })).not.toBeInTheDocument();

    await user.click(within(departmentPanel()).getByRole('button', { name: 'Ver todas' }));
    expect(within(departmentPanel()).getByRole('link', { name: /Finanzas/ })).toBeInTheDocument();
    expect(within(departmentPanel()).getByRole('link', { name: /Ventas/ })).toBeInTheDocument();
  });

  it('enlaza cada departamento visible con el listado filtrado por él', async () => {
    await renderDashboard();

    expect(within(departmentPanel()).getByRole('link', { name: /^TI/ })).toHaveAttribute(
      'href',
      '/app/tickets?department=4&active=1'
    );
  });

  it('enlaza el técnico con el listado de sus tickets sin cambiar sus métricas', async () => {
    setup({ byTechnician: byTechnician() });
    await renderDashboard();

    const card = technicianCard();
    expect(within(card).getByRole('link', { name: /Luis Pérez/ })).toHaveAttribute(
      'href',
      '/app/tickets?assigned=21&active=1'
    );

    // Las cifras de la sección son las de siempre: hacer la fila clicable no
    // puede haberlas movido. Se buscan los rótulos de las tarjetas de resumen
    // (`p`), no los de la tabla, que repiten "Fuera de plazo".
    expect(within(card).getByText('Activos en cola', { selector: 'p' }).parentElement.textContent).toContain('4');
    expect(within(card).getByText('Sin asignar', { selector: 'p' }).parentElement.textContent).toContain('3');
    expect(within(card).getByText('Fuera de plazo', { selector: 'p' }).parentElement.textContent).toContain('1');
    expect(within(card).getByText('En proceso')).toBeInTheDocument();
    expect(within(card).getByText('Pendientes')).toBeInTheDocument();
  });

  it('abre la ficha del ticket reciente y muestra su técnico', async () => {
    await renderDashboard();

    const card = recentCard();
    // El id lo aporta /api/dashboard/recent; sin él el enlace iba a
    // /app/tickets/undefined.
    expect(within(card).getByRole('link', { name: 'TCK-000001' })).toHaveAttribute('href', '/app/tickets/1');
    expect(within(card).getByRole('link', { name: 'PC no enciende' })).toHaveAttribute('href', '/app/tickets/1');
    // El resto de datos de la fila, incluido el técnico asignado.
    expect(within(card).getByText('Hardware')).toBeInTheDocument();
    expect(within(card).getByText('Alta')).toBeInTheDocument();
    expect(within(card).getByText('Abierto')).toBeInTheDocument();
    expect(within(card).getByText('Luis Pérez')).toBeInTheDocument();
  });

  it('pinta un guion cuando el ticket reciente no tiene técnico', async () => {
    setup({ recent: { data: [{ ...recent().data[0], assigned_name: null }] } });

    await renderDashboard();
    expect(within(recentCard()).getAllByText('—').length).toBeGreaterThan(0);
  });

  it('avisa cuando todavía no hay tickets recientes', async () => {
    setup({ recent: { data: [] } });

    await renderDashboard();
    expect(await screen.findByText('Todavía no hay tickets registrados.')).toBeInTheDocument();
  });
});

describe('Dashboard · tendencia de 14 días', () => {
  it('dibuja la gráfica cuando hay actividad', async () => {
    setup({ trend: { data: [{ label: '2026-09-01', created: 4, resolved: 2 }] } });

    await renderDashboard();
    expect(within(trendPanel()).queryByText('Sin actividad registrada en este período.')).not.toBeInTheDocument();
    expect(within(trendPanel()).getByTitle('2026-09-01: 4 creados')).toBeInTheDocument();
    expect(within(trendPanel()).getByTitle('2026-09-01: 2 resueltos')).toBeInTheDocument();
    // Las leyendas siguen estando.
    expect(within(trendPanel()).getByText('Creados')).toBeInTheDocument();
    expect(within(trendPanel()).getByText('Resueltos')).toBeInTheDocument();
  });

  it('muestra un estado vacío centrado cuando el período no registra actividad', async () => {
    setup({ trend: flatTrend() });

    await renderDashboard();
    const message = await screen.findByText('Sin actividad registrada en este período.');

    // No debe quedar una gráfica de barras planas detrás del mensaje.
    expect(within(trendPanel()).queryByTitle(/creados/)).not.toBeInTheDocument();
    expect(within(trendPanel()).queryByTitle(/resueltos/)).not.toBeInTheDocument();
    // Pero las leyendas se conservan: el usuario sigue sabiendo qué se mediría.
    expect(within(trendPanel()).getByText('Creados')).toBeInTheDocument();
    expect(within(trendPanel()).getByText('Resueltos')).toBeInTheDocument();
    // Y el mensaje queda centrado en la caja, no pegado a un borde.
    expect(message.parentElement.className).toContain('justify-center');
    expect(message.parentElement.className).toContain('text-center');
  });

  // El período vacío y el período con actividad se parecen mucho: los dos
  // traen 14 etiquetas y los dos pueden tener un día con datos. El único límite
  // entre "estado vacío" y "gráfica" es que algún contador pase de cero, así que
  // aquí se prueba justo ese borde: 14 puntos presentes, 13 a cero.
  it('dibuja la gráfica si un solo día de los 14 tiene actividad', async () => {
    const data = Array.from({ length: 14 }, (_, i) => ({
      label: `2026-09-${String(i + 1).padStart(2, '0')}`,
      created: 0,
      resolved: 0,
    }));
    data[9] = { label: '2026-09-10', created: 12, resolved: 0 };
    setup({ trend: { data } });

    await renderDashboard();
    expect(within(trendPanel()).queryByText('Sin actividad registrada en este período.')).not.toBeInTheDocument();
    expect(within(trendPanel()).getByTitle('2026-09-10: 12 creados')).toBeInTheDocument();
    // Los días a cero conservan su barra baja: la línea de base sigue leyéndose
    // como línea de base y no desaparecen del período.
    expect(within(trendPanel()).getByTitle('2026-09-01: 0 creados')).toBeInTheDocument();
  });

  // Un "resuelto" basta igual que un "creado": el estado vacío se decide por
  // cualquier actividad, no solo por la de entrada.
  it('dibuja la gráfica si el único movimiento es una resolución', async () => {
    const data = Array.from({ length: 14 }, (_, i) => ({
      label: `2026-09-${String(i + 1).padStart(2, '0')}`,
      created: 0,
      resolved: 0,
    }));
    data[13] = { label: '2026-09-14', created: 0, resolved: 1 };
    setup({ trend: { data } });

    await renderDashboard();
    expect(within(trendPanel()).queryByText('Sin actividad registrada en este período.')).not.toBeInTheDocument();
    expect(within(trendPanel()).getByTitle('2026-09-14: 1 resueltos')).toBeInTheDocument();
  });

  it('el estado vacío conserva la altura de la caja de la gráfica', async () => {
    setup({ trend: flatTrend() });

    await renderDashboard();
    const message = await screen.findByText('Sin actividad registrada en este período.');
    // Misma caja `h-40` que la gráfica: la tarjeta no cambia de alto al alternar
    // entre los dos estados, así que la rejilla de dos columnas no baila.
    expect(message.parentElement.className).toContain('h-40');
  });

  it('trata un período sin puntos como estado vacío y no como un fallo', async () => {
    setup({ trend: { data: [] } });

    await renderDashboard();
    expect(await screen.findByText('Sin actividad registrada en este período.')).toBeInTheDocument();
  });
});

describe('Dashboard · accesibilidad de lo clicable', () => {
  it('los enlaces de los paneles se anuncian como enlaces y no como divs', async () => {
    setup({ byTechnician: byTechnician() });
    await renderDashboard();

    const targets = [
      within(categoryPanel()).getByRole('link', { name: /Hardware/ }),
      within(departmentPanel()).getByRole('link', { name: /^TI/ }),
      within(technicianCard()).getByRole('link', { name: /Luis Pérez/ }),
      within(recentCard()).getByRole('link', { name: 'TCK-000001' }),
    ];
    for (const el of targets) {
      expect(el.tagName).toBe('A');
      expect(el).toHaveAttribute('href');
      expect(el).not.toHaveAttribute('tabindex');
      expect(el).not.toHaveAttribute('role');
    }
  });

  it('cada elemento clicable declara cursor y foco visible', async () => {
    setup({ byTechnician: byTechnician() });
    await renderDashboard();

    const targets = [
      within(categoryPanel()).getByRole('link', { name: /Hardware/ }),
      within(departmentPanel()).getByRole('link', { name: /^TI/ }),
      within(technicianCard()).getByRole('link', { name: /Luis Pérez/ }),
      within(categoryPanel()).getByRole('button', { name: 'Ver todas' }),
    ];
    for (const el of targets) {
      expect(el.className).toContain('cursor-pointer');
      // Sin `focus-visible` el usuario de teclado no distingue dónde está.
      expect(el.className).toContain('focus-visible:outline-2');
    }
  });

  it('el interruptor es un botón real, alcanzable con el teclado', async () => {
    const user = userEvent.setup();
    await renderDashboard();

    const toggle = within(categoryPanel()).getByRole('button', { name: 'Ver todas' });
    toggle.focus();
    expect(toggle).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(within(categoryPanel()).getByRole('link', { name: /Accesos/ })).toBeInTheDocument();
  });
});
