import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Reports from './Reports';
import { api } from '../lib/api';
import { printDocument } from '../lib/print';
import { renderWithProviders, pickOption } from '../test/utils';
import { cssVariables, contrastRatio, themeColors } from '../test/contrast';

const { download } = vi.hoisted(() => ({
  download: vi.fn(),
}));

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual('../lib/api');
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
    download,
  };
});

vi.mock('../lib/print', () => ({
  printDocument: vi.fn(() => true),
}));

const DEPARTMENTS = { data: [{ id: 1, name: 'TI' }, { id: 2, name: 'RRHH' }] };
const CATEGORIES = { data: [{ id: 1, name: 'Hardware' }, { id: 2, name: 'Software' }] };

function report(overrides = {}) {
  return {
    summary: { total: 10, open: 4, resolved: 3, unresolved_week: 1, avg_resolution_hours: 5 },
    byStatus: [{ status: 'OPEN', n: 4 }, { status: 'CLOSED', n: 2 }],
    byPriority: [{ priority: 'HIGH', n: 2 }],
    byCategory: [{ name: 'Hardware', n: 3, open: 1, color: '#64748b' }],
    byDepartment: [{ name: 'TI', n: 5, open: 2 }],
    byDay: [{ day: '2026-09-20', n: 3 }],
    byUser: [{ reporter: 'Ana Díaz', total: 4, open: 1 }],
    byTechnician: [
      {
        id: 3,
        technician: 'Juan Pérez',
        assigned: 6,
        open: 2,
        resolved: 4,
        closed: 3,
        total_time_minutes: 300,
        avg_time_minutes: 75,
        avg_resolution_hours: 6.5,
        sla_comparable: 4,
        sla_within: 3,
        sla_breached: 1,
        sla_pct: 75,
      },
    ],
    byTeam: {
      basis: 'current_assignment',
      note: 'Los tickets completados se atribuyen al equipo asignado actualmente; el modelo no guarda el equipo que los resolvió en su momento.',
      data: [
        {
          id: 1,
          team: 'Soporte Norte',
          assigned: 7,
          open: 3,
          completed: 5,
          avg_resolution_hours: 8,
          sla_comparable: 5,
          sla_within: 4,
          sla_breached: 1,
          sla_pct: 80,
        },
      ],
    },
    csat: {
      responses: 4,
      eligible: 5,
      response_rate: 80,
      average: 4.25,
      has_data: true,
      distribution: [
        { rating: 1, n: 0 },
        { rating: 2, n: 1 },
        { rating: 3, n: 0 },
        { rating: 4, n: 1 },
        { rating: 5, n: 2 },
      ],
      by_technician: [{ label: 'Juan Pérez', responses: 4, average: 4.25 }],
      by_department: [{ label: 'TI', responses: 3, average: 4.5 }],
      by_category: [{ label: 'Hardware', responses: 2, average: 5 }],
      by_month: [{ month: '2026-09', responses: 4, average: 4.25 }],
    },
    details: [
      { ticket_number: 'TCK-000012', title: 'Monitor falla', status: 'OPEN', priority: 'HIGH', reporter: 'Ana Díaz', assigned_to: 'Juan', department: 'TI', category: 'Hardware', created_at: '2026-09-01T08:00:00Z', resolved_at: null, closed_at: null },
    ],
    ...overrides,
  };
}

function setup(reportOverrides = {}) {
  setupPayload(report(reportOverrides));
}

function setupPayload(payload) {
  api.get.mockImplementation((url) => {
    if (url === '/api/departments?active=1') return Promise.resolve(DEPARTMENTS);
    if (url === '/api/categories?active=1') return Promise.resolve(CATEGORIES);
    if (url.startsWith('/api/reports/full')) return Promise.resolve(payload);
    return Promise.reject(new Error(`404 ${url}`));
  });
}

// Lo que devuelve el backend cuando ningún ticket cumple la consulta: todas las
// listas vacías, el resumen en cero y el CSAT sin una sola respuesta.
function emptyReport(overrides = {}) {
  return report({
    summary: { total: 0, open: 0, resolved: 0, unresolved_week: 0, avg_resolution_hours: 0 },
    byStatus: [],
    byPriority: [],
    byCategory: [],
    byDepartment: [],
    byDay: [],
    byUser: [],
    byTechnician: [],
    byTeam: { basis: 'current_assignment', note: 'Sin histórico de equipo.', data: [] },
    csat: {
      responses: 0,
      eligible: 0,
      response_rate: null,
      average: null,
      has_data: false,
      distribution: [1, 2, 3, 4, 5].map((rating) => ({ rating, n: 0 })),
      by_technician: [],
      by_department: [],
      by_category: [],
      by_month: [],
    },
    details: [],
    ...overrides,
  });
}

// Todas las barras en cero: el backend cuenta desde la tabla de tickets, pero
// categorías y departamentos se listan aunque no tengan ninguno, así que un
// gráfico con diez ceros también es un gráfico vacío.
function reportConCategoriasVacias(overrides = {}) {
  return report({
    byCategory: [
      { name: 'Hardware', n: 0, open: 0, color: '#64748b' },
      { name: 'Software', n: 0, open: 0, color: '#0ea5e9' },
    ],
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('alert', vi.fn());
  setup();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Reports', () => {
  it('muestra el estado de carga mientras la API responde', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/api/departments?active=1') return Promise.resolve(DEPARTMENTS);
      if (url === '/api/categories?active=1') return Promise.resolve(CATEGORIES);
      if (url.startsWith('/api/reports/full')) return new Promise(() => {});
      return Promise.reject(new Error(`404 ${url}`));
    });

    renderWithProviders(<Reports />, { route: '/app/reports' });
    expect(screen.getByText('Cargando reportes…')).toBeInTheDocument();
  });

  it('muestra el error y permite reintentar', async () => {
    let failedOnce = false;
    api.get.mockImplementation((url) => {
      if (url === '/api/departments?active=1') return Promise.resolve(DEPARTMENTS);
      if (url === '/api/categories?active=1') return Promise.resolve(CATEGORIES);
      if (url.startsWith('/api/reports/full')) {
        if (!failedOnce) {
          failedOnce = true;
          return Promise.reject(new Error('Fallo en reportes'));
        }
        return Promise.resolve(report());
      }
      return Promise.reject(new Error(`404 ${url}`));
    });

    renderWithProviders(<Reports />, { route: '/app/reports' });
    expect(await screen.findByRole('alert')).toHaveTextContent('Fallo en reportes');

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));

    expect(await screen.findByText('Total tickets')).toBeInTheDocument();
  });

  it('muestra los KPIs y las tablas de resultados', async () => {
    renderWithProviders(<Reports />, { route: '/app/reports' });

    expect(await screen.findByText('Total tickets')).toBeInTheDocument();
    const totalKpi = screen.getByText('Total tickets').parentElement;
    expect(totalKpi).toHaveTextContent('10');
    const kpiTiming = screen.getByText('Tiempo medio resolución').parentElement;
    expect(kpiTiming).toHaveTextContent('5 h');

    expect(screen.getByText('Tickets por estado')).toBeInTheDocument();
    expect(screen.getAllByText('Abierto').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Hardware').length).toBeGreaterThan(0);
    expect(screen.getByText('1 abiertos')).toBeInTheDocument();
    expect(screen.getAllByText('TI').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Ana Díaz').length).toBeGreaterThan(0);
    expect(screen.getByText('TCK-000012')).toBeInTheDocument();
    expect(screen.getByText('Monitor falla')).toBeInTheDocument();
  });

  it('aplica filtros de estado y prioridad', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Reports />, { route: '/app/reports' });
    await screen.findByText('Total tickets');

    await pickOption(user, screen.getByLabelText('Estado'), 'Abierto');
    await pickOption(user, screen.getByLabelText('Prioridad'), 'Alta');
    await user.click(screen.getByRole('button', { name: 'Aplicar' }));

    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('status=OPEN&priority=HIGH')));
  });

  it('aplica filtros de fechas desde/hasta', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Reports />, { route: '/app/reports' });
    await screen.findByText('Total tickets');

    await user.type(screen.getByLabelText('Desde'), '2026-08-01');
    await user.type(screen.getByLabelText('Hasta'), '2026-08-31');
    await user.click(screen.getByRole('button', { name: 'Aplicar' }));

    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('from=2026-08-01&to=2026-08-31')));
  });

  it('aplica filtros de departamento y categoría', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Reports />, { route: '/app/reports' });
    await screen.findByText('Total tickets');

    await pickOption(user, screen.getByLabelText('Departamento'), 'RRHH');
    await pickOption(user, screen.getByLabelText('Categoría'), 'Software');
    await user.click(screen.getByRole('button', { name: 'Aplicar' }));

    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('department=2&category=2')));
  });

  it('aplica el preset "Este mes" con rango calculado', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Reports />, { route: '/app/reports' });
    await screen.findByText('Total tickets');

    await user.click(screen.getByRole('button', { name: 'Este mes' }));

    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringMatching(/\/api\/reports\/full\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/)));
  });

  it('exporta el CSV con las secciones seleccionadas', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Reports />, { route: '/app/reports' });
    await screen.findByText('Total tickets');

    await user.click(screen.getByRole('button', { name: 'Exportar CSV' }));

    expect(download).toHaveBeenCalledWith(
      expect.stringMatching(/^\/api\/reports\/export\?sections=summary/)
    );
    expect(download.mock.calls[0][0]).toContain('status');
  });

  it('respeta la selección de secciones al exportar CSV', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Reports />, { route: '/app/reports' });
    await screen.findByText('Total tickets');

    await user.click(screen.getByLabelText('Estados'));
    await user.click(screen.getByRole('button', { name: 'Exportar CSV' }));

    expect(download).toHaveBeenCalledTimes(1);
    expect(download.mock.calls[0][0]).toContain('sections=summary');
    expect(download.mock.calls[0][0]).not.toContain('status');
  });

  it('genera el PDF por impresión con las secciones activas', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Reports />, { route: '/app/reports' });
    await screen.findByText('Total tickets');

    await user.click(screen.getByLabelText('Estados'));
    await user.click(screen.getByRole('button', { name: 'Descargar PDF' }));

    expect(printDocument).toHaveBeenCalledWith(expect.objectContaining({ title: 'Reporte de tickets' }));
    const arg = printDocument.mock.calls[0][0];
    const titles = arg.sections.map((s) => s.title);
    expect(titles).not.toContain('Tickets por estado');
    expect(titles).toContain('Resumen');
    expect(arg.meta.length).toBeGreaterThan(0);
  });

  it('muestra un aviso persistente cuando el navegador bloquea el PDF', async () => {
    const user = userEvent.setup();
    printDocument.mockReturnValueOnce(false);
    renderWithProviders(<Reports />, { route: '/app/reports' });
    await screen.findByText('Total tickets');

    await user.click(screen.getByRole('button', { name: 'Descargar PDF' }));

    // Ni alert nativo ni window.alert: el aviso vive en la región de avisos.
    expect(alert).not.toHaveBeenCalled();
    const region = await screen.findByRole('status');
    expect(region).toHaveTextContent(
      'El navegador bloqueó la ventana del PDF. Habilite las ventanas emergentes e intente nuevamente.'
    );
    // Un error no se cierra solo: por eso lleva el tipo `error` (sin plazo) y
    // mantiene el cierre manual.
    expect(screen.getByTestId('toast')).toHaveAttribute('data-type', 'error');

    await user.click(screen.getByRole('button', { name: 'Cerrar notificación' }));
    expect(screen.queryByText(/bloqueó la ventana del PDF/)).not.toBeInTheDocument();
  });

  it('no exporta CSV sin secciones seleccionadas', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Reports />, { route: '/app/reports' });
    await screen.findByText('Total tickets');

    for (const label of ['Resumen', 'Estados', 'Prioridades', 'Categorías', 'Departamentos', 'Reporteros', 'Resueltos por día', 'Rendimiento por técnico', 'Rendimiento por equipo', 'Satisfacción (CSAT)', 'Detalle de tickets']) {
      await user.click(screen.getByLabelText(label));
    }

    expect(screen.getByRole('button', { name: 'Descargar PDF' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Exportar CSV' }));
    expect(download).not.toHaveBeenCalled();
  });

  it('explica cada sección sin datos en vez de dejar un "Sin datos" suelto', async () => {
    setup({
      byStatus: [],
      byPriority: [],
      byCategory: [],
      byDepartment: [],
      byUser: [],
      details: [],
    });

    renderWithProviders(<Reports />, { route: '/app/reports' });
    expect(await screen.findByText('Total tickets')).toBeInTheDocument();

    // Cada tarjeta dice qué le falta, no sólo que no hay nada.
    expect(screen.getByText('Sin tickets por estado')).toBeInTheDocument();
    expect(screen.getByText('Sin tickets abiertos')).toBeInTheDocument();
    expect(screen.getByText('Sin tickets por categoría')).toBeInTheDocument();
    expect(screen.getByText('Sin tickets por departamento')).toBeInTheDocument();
    expect(screen.getByText('Sin datos de reportadores')).toBeInTheDocument();
    expect(screen.getByText('Sin tickets que detallar')).toBeInTheDocument();
    // El mensaje genérico desaparece: no explicaba nada.
    expect(screen.queryByText('Sin datos')).not.toBeInTheDocument();
  });

  it('muestra el resumen de registros y el límite de exportación', async () => {
    renderWithProviders(<Reports />, { route: '/app/reports' });

    expect(await screen.findByText(/registro\(s\), máximo 500 en exportación/)).toBeInTheDocument();
  });
});

// Un reporte sin resultados se explica una vez y con una salida, en lugar de
// repetir "Sin datos" en once tarjetas. Los tres casos se distinguen con lo que
// el frontend ya sabe: qué filtros hay aplicados y si el período es el culpable.
describe('Reports: la consulta no devuelve tickets', () => {
  it('dice que todavía no hay tickets cuando no hay filtros', async () => {
    setupPayload(emptyReport());

    renderWithProviders(<Reports />, { route: '/app/reports' });

    expect(await screen.findByText('Todavía no hay tickets registrados')).toBeInTheDocument();
    expect(screen.getByText(/Los reportes se rellenarán solos/)).toBeInTheDocument();
    // Sin filtros que quitar, no se ofrece ninguna acción: no hay salida que ofrecer.
    expect(screen.queryByRole('button', { name: /Limpiar filtros|Ver todo el historial/ })).not.toBeInTheDocument();
  });

  it('no dibuja gráficos, tablas ni KPIs en cero cuando no hay nada que medir', async () => {
    setupPayload(emptyReport());

    renderWithProviders(<Reports />, { route: '/app/reports' });

    expect(await screen.findByText('Todavía no hay tickets registrados')).toBeInTheDocument();
    expect(screen.queryByText('Total tickets')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Tickets por estado' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Rendimiento por técnico' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Detalle de tickets' })).not.toBeInTheDocument();
    expect(screen.queryByText('Valoración media')).not.toBeInTheDocument();
    expect(screen.queryAllByRole('table')).toHaveLength(0);
  });

  it('distingue que el período seleccionado no tiene tickets y ofrece volver a todo', async () => {
    const user = userEvent.setup();
    setupPayload(emptyReport());

    renderWithProviders(<Reports />, { route: '/app/reports' });
    expect(await screen.findByText('Todavía no hay tickets registrados')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Este mes' }));

    expect(await screen.findByText('No hay tickets en el período seleccionado')).toBeInTheDocument();
    expect(screen.queryByText('Todavía no hay tickets registrados')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Ver todo el historial' }));

    // La salida es real: se vuelve a pedir el reporte sin fechas.
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/reports/full'));
    expect(await screen.findByText('Todavía no hay tickets registrados')).toBeInTheDocument();
  });

  it('distingue que los filtros no encontraron resultados y ofrece limpiarlos', async () => {
    const user = userEvent.setup();
    setupPayload(emptyReport());

    renderWithProviders(<Reports />, { route: '/app/reports' });
    expect(await screen.findByText('Todavía no hay tickets registrados')).toBeInTheDocument();

    await pickOption(user, screen.getByLabelText('Estado'), 'Abierto');
    await user.click(screen.getByRole('button', { name: 'Aplicar' }));

    expect(await screen.findByText('Ningún ticket coincide con estos filtros')).toBeInTheDocument();
    expect(screen.queryByText('Todavía no hay tickets registrados')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Limpiar filtros' }));

    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/reports/full'));
    // El estado vacío es el de "no hay tickets", ya sin filtros que lo oculten.
    expect(await screen.findByText('Todavía no hay tickets registrados')).toBeInTheDocument();
    // Y los controles vuelven a su estado inicial, no sólo la consulta.
    expect(screen.getByLabelText('Desde')).toHaveValue('');
    expect(screen.getByLabelText('Hasta')).toHaveValue('');
  });

  it('con filtros y período a la vez, el mensaje menciona las dos causas', async () => {
    const user = userEvent.setup();
    setupPayload(emptyReport());

    renderWithProviders(<Reports />, { route: '/app/reports' });
    await screen.findByText('Todavía no hay tickets registrados');

    await user.click(screen.getByRole('button', { name: 'Este mes' }));
    await pickOption(user, screen.getByLabelText('Departamento'), 'RRHH');
    await user.click(screen.getByRole('button', { name: 'Aplicar' }));

    expect(await screen.findByText('Ningún ticket coincide con estos filtros')).toBeInTheDocument();
    expect(screen.getByText(/menos filtros o con un período más amplio/)).toBeInTheDocument();
  });

  it('mantiene filtros, secciones y exportación disponibles aunque no haya resultados', async () => {
    const user = userEvent.setup();
    setupPayload(emptyReport());

    renderWithProviders(<Reports />, { route: '/app/reports' });
    expect(await screen.findByText('Todavía no hay tickets registrados')).toBeInTheDocument();

    // El panel de filtros sigue ahí: es la herramienta para salir del vacío.
    expect(screen.getByLabelText('Desde')).toBeInTheDocument();
    expect(screen.getByLabelText('Estado')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Aplicar' })).toBeInTheDocument();
    expect(screen.getByLabelText('Detalle de tickets')).toBeChecked();

    // Exportar no se Rompe: puede seguir siendo útil como reporte en blanco.
    await user.click(screen.getByRole('button', { name: 'Exportar CSV' }));
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('el mensaje del estado vacío no depende del icono ni del color', async () => {
    setupPayload(emptyReport());

    renderWithProviders(<Reports />, { route: '/app/reports' });

    const mensaje = await screen.findByText('Todavía no hay tickets registrados');
    expect(mensaje.tagName).toBe('P');
    // El emoji es decorativo: el texto es el que comunica el estado.
    const icono = mensaje.closest('div').querySelector('[aria-hidden="true"]');
    expect(icono).toBeInTheDocument();
    expect(icono.textContent).toBe('🎫');
    expect(mensaje).toHaveTextContent('Todavía no hay tickets registrados');
  });

  it('el texto del estado vacío mantiene el mínimo de contraste en claro y en oscuro', () => {
    const paleta = themeColors();
    const claro = cssVariables(':root');
    const oscuro = cssVariables(":root[data-theme='dark']");

    // EmptyState usa `text-slate-700` (título) y `text-slate-500` (explicación).
    // En tema oscuro index.css los reescribe a --text y --text-muted, así que
    // sobre la tarjeta hay que comprobar las dos paletas.
    expect(contrastRatio(paleta['slate-700'], claro['--surface'])).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(paleta['slate-500'], claro['--surface'])).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(oscuro['--text'], oscuro['--surface'])).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(oscuro['--text-muted'], oscuro['--surface'])).toBeGreaterThanOrEqual(4.5);
  });
});

describe('Reports: gráficos sin datos útiles', () => {
  it('sustituye un gráfico de barras en cero por su estado vacío', async () => {
    setupPayload(reportConCategoriasVacias());

    renderWithProviders(<Reports />, { route: '/app/reports' });

    // Hay tickets (el resumen no está vacío), pero ninguna categoría los tiene.
    expect(await screen.findByText('Total tickets')).toBeInTheDocument();
    const tarjeta = screen.getByText('Tickets por categoría').parentElement;
    expect(tarjeta).toHaveTextContent('Sin tickets por categoría');
    expect(tarjeta).not.toHaveTextContent('Hardware');
    expect(tarjeta).not.toHaveTextContent('0 abiertos');
  });

  it('no dibuja la distribución de estrellas cuando no hay respuestas', async () => {
    setupPayload(report({
      csat: {
        responses: 0, eligible: 4, response_rate: 0, average: null, has_data: false,
        distribution: [1, 2, 3, 4, 5].map((rating) => ({ rating, n: 0 })),
        by_technician: [], by_department: [], by_category: [], by_month: [],
      },
    }));

    renderWithProviders(<Reports />, { route: '/app/reports' });

    const tarjeta = (await screen.findByText('Distribución de respuestas')).parentElement;
    expect(tarjeta).toHaveTextContent('Sin respuestas de satisfacción');
    // Cinco barras de estrella a cero se leerían como un gráfico de datos.
    expect(tarjeta).not.toHaveTextContent('★');
  });

  it('mantiene el gráfico con datos reales', async () => {
    renderWithProviders(<Reports />, { route: '/app/reports' });

    const tarjeta = (await screen.findByText('Tickets por categoría')).parentElement;
    expect(tarjeta).toHaveTextContent('Hardware');
    expect(tarjeta).toHaveTextContent('1 abiertos');
    expect(tarjeta).not.toHaveTextContent('Sin tickets por categoría');
  });
});

describe('Reports: rendimiento por técnico y por equipo', () => {
  it('lista el trabajo de cada técnico con su tiempo y su SLA', async () => {
    renderWithProviders(<Reports />, { route: '/app/reports' });

    expect(await screen.findByRole('heading', { name: 'Rendimiento por técnico' })).toBeInTheDocument();
    expect(screen.getAllByText('Juan Pérez').length).toBe(2, 'aparece en su tabla y en el desglose de CSAT');
    expect(screen.getByText('5 h 0 min')).toBeInTheDocument();
    expect(screen.getByText('1 h 15 min')).toBeInTheDocument();
    expect(screen.getByText('6.5 h')).toBeInTheDocument();
    expect(screen.getByText('75.0%')).toBeInTheDocument();
  });

  it('advierte que los tickets del equipo se atribuyen al equipo actual', async () => {
    renderWithProviders(<Reports />, { route: '/app/reports' });

    expect(await screen.findByRole('heading', { name: 'Rendimiento por equipo' })).toBeInTheDocument();
    expect(screen.getByText('Soporte Norte')).toBeInTheDocument();
    expect(screen.getByText(/no guarda el equipo que los resolvió/)).toBeInTheDocument();
  });

  it('dice "Sin datos" en vez de mostrar un cero cuando no hay SLA comparable', async () => {
    setup({
      byTechnician: [
        {
          id: 3, technician: 'Juan Pérez', assigned: 0, open: 0, resolved: 0, closed: 0,
          total_time_minutes: 0, avg_time_minutes: null, avg_resolution_hours: null,
          sla_comparable: 0, sla_within: 0, sla_breached: 0, sla_pct: null,
        },
      ],
    });

    renderWithProviders(<Reports />, { route: '/app/reports' });

    expect(await screen.findByRole('heading', { name: 'Rendimiento por técnico' })).toBeInTheDocument();
    expect(screen.getByText('Sin SLA comparable')).toBeInTheDocument();
    expect(screen.getAllByText('Sin datos').length).toBeGreaterThanOrEqual(2);
  });

  it('no muestra filas de técnicos ni de equipos cuando no hay datos', async () => {
    setup({ byTechnician: [], byTeam: { basis: 'current_assignment', note: 'Sin histórico de equipo.', data: [] } });

    renderWithProviders(<Reports />, { route: '/app/reports' });

    expect(await screen.findByRole('heading', { name: 'Rendimiento por técnico' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Rendimiento por equipo' })).toBeInTheDocument();
    // El encabezado sobrevive y la tabla se sustituye por su estado vacío.
    expect(screen.getByText('Sin trabajo asignado a técnicos')).toBeInTheDocument();
    expect(screen.getByText('Sin trabajo en equipos')).toBeInTheDocument();
    expect(screen.queryByText('5 h 0 min')).toBeNull();
  });
});

describe('Reports: satisfacción del cliente', () => {
  it('muestra media, respuestas, base y tasa', async () => {
    renderWithProviders(<Reports />, { route: '/app/reports' });

    expect(await screen.findByText('Valoración media')).toBeInTheDocument();
    expect(screen.getByText('Valoración media').parentElement).toHaveTextContent('4.25 / 5');
    expect(screen.getByText('Respuestas recibidas').parentElement).toHaveTextContent('4');
    expect(screen.getByText('Tasa de respuesta').parentElement).toHaveTextContent('80%');
  });

  it('distingue "sin respuestas" de una valoración cero', async () => {
    setup({
      csat: {
        responses: 0, eligible: 5, response_rate: 0, average: null, has_data: false,
        distribution: [{ rating: 1, n: 0 }, { rating: 2, n: 0 }, { rating: 3, n: 0 }, { rating: 4, n: 0 }, { rating: 5, n: 0 }],
        by_technician: [], by_department: [], by_category: [], by_month: [],
      },
    });

    renderWithProviders(<Reports />, { route: '/app/reports' });

    expect(await screen.findByText('Valoración media')).toBeInTheDocument();
    expect(screen.getByText('Sin respuestas')).toBeInTheDocument();
    expect(screen.getByText('Tasa de respuesta').parentElement).toHaveTextContent('0%');
    // El desglose mensual vacío se explica; la distribución de estrellas no se
    // dibuja porque cinco barras en cero no dicen nada.
    expect(screen.getByText('Evolución mensual').parentElement).toHaveTextContent('Sin historial de satisfacción');
    expect(screen.getAllByText('Sin respuestas de satisfacción').length).toBeGreaterThanOrEqual(2);
  });

  it('distingue una tasa sin base comparable de un 0% real', async () => {
    setup({
      csat: {
        responses: 0, eligible: 0, response_rate: null, average: null, has_data: false,
        distribution: [{ rating: 1, n: 0 }, { rating: 2, n: 0 }, { rating: 3, n: 0 }, { rating: 4, n: 0 }, { rating: 5, n: 0 }],
        by_technician: [], by_department: [], by_category: [], by_month: [],
      },
    });

    renderWithProviders(<Reports />, { route: '/app/reports' });

    expect(await screen.findByText('Valoración media')).toBeInTheDocument();
    expect(screen.getByText('Sin base comparable')).toBeInTheDocument();
  });

  it('muestra la distribución por estrellas y la evolución mensual', async () => {
    renderWithProviders(<Reports />, { route: '/app/reports' });

    expect(await screen.findByText('Distribución de respuestas')).toBeInTheDocument();
    expect(screen.getByText('★★★★★ 5')).toBeInTheDocument();
    expect(screen.getByText('★★ 2')).toBeInTheDocument();

    expect(screen.getByText('Evolución mensual')).toBeInTheDocument();
    expect(screen.getByText('2026-09')).toBeInTheDocument();
    expect(screen.getByText('4 respuesta(s)')).toBeInTheDocument();
  });

  it('desglosa el CSAT por técnico, departamento y categoría', async () => {
    renderWithProviders(<Reports />, { route: '/app/reports' });

    expect(await screen.findByText('CSAT por técnico')).toBeInTheDocument();
    expect(screen.getByText('CSAT por departamento')).toBeInTheDocument();
    expect(screen.getByText('CSAT por categoría')).toBeInTheDocument();
    expect(screen.getByText('4.5 / 5')).toBeInTheDocument();
    expect(screen.getByText('5 / 5')).toBeInTheDocument();
  });

  it('no rompe la vista si el backend no devuelve la sección de CSAT', async () => {
    const payload = report();
    delete payload.csat;
    api.get.mockImplementation((url) => {
      if (url === '/api/departments?active=1') return Promise.resolve(DEPARTMENTS);
      if (url === '/api/categories?active=1') return Promise.resolve(CATEGORIES);
      if (url.startsWith('/api/reports/full')) return Promise.resolve(payload);
      return Promise.reject(new Error(`404 ${url}`));
    });

    renderWithProviders(<Reports />, { route: '/app/reports' });

    expect(await screen.findByText('Total tickets')).toBeInTheDocument();
    expect(screen.queryByText('Valoración media')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Rendimiento por técnico' })).toBeInTheDocument();
  });
});