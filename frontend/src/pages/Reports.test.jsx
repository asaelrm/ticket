import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Reports from './Reports';
import { api } from '../lib/api';
import { printDocument } from '../lib/print';
import { renderWithProviders } from '../test/utils';

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
    details: [
      { ticket_number: 'TCK-000012', title: 'Monitor falla', status: 'OPEN', priority: 'HIGH', reporter: 'Ana Díaz', assigned_to: 'Juan', department: 'TI', category: 'Hardware', created_at: '2026-09-01T08:00:00Z', resolved_at: null, closed_at: null },
    ],
    ...overrides,
  };
}

function setup(reportOverrides = {}) {
  const payload = report(reportOverrides);
  api.get.mockImplementation((url) => {
    if (url === '/api/departments?active=1') return Promise.resolve(DEPARTMENTS);
    if (url === '/api/categories?active=1') return Promise.resolve(CATEGORIES);
    if (url.startsWith('/api/reports/full')) return Promise.resolve(payload);
    return Promise.reject(new Error(`404 ${url}`));
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
    api.get.mockRejectedValueOnce(new Error('Fallo en reportes'));

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
    expect(screen.getByText('1 abierto')).toBeInTheDocument();
    expect(screen.getAllByText('TI').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Ana Díaz').length).toBeGreaterThan(0);
    expect(screen.getByText('TCK-000012')).toBeInTheDocument();
    expect(screen.getByText('Monitor falla')).toBeInTheDocument();
  });

  it('aplica filtros de estado y prioridad', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Reports />, { route: '/app/reports' });
    await screen.findByText('Total tickets');

    await user.selectOptions(screen.getByLabelText('Estado'), 'OPEN');
    await user.selectOptions(screen.getByLabelText('Prioridad'), 'HIGH');
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

    await user.selectOptions(screen.getByLabelText('Departamento'), '2');
    await user.selectOptions(screen.getByLabelText('Categoría'), '2');
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

  it('avisa con alert cuando el navegador bloquea el PDF', async () => {
    const user = userEvent.setup();
    printDocument.mockReturnValueOnce(false);
    renderWithProviders(<Reports />, { route: '/app/reports' });
    await screen.findByText('Total tickets');

    await user.click(screen.getByRole('button', { name: 'Descargar PDF' }));

    expect(alert).toHaveBeenCalledWith(expect.stringContaining('bloqueó la ventana del PDF'));
  });

  it('no exporta CSV sin secciones seleccionadas', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Reports />, { route: '/app/reports' });
    await screen.findByText('Total tickets');

    for (const label of ['Resumen', 'Estados', 'Prioridades', 'Categorías', 'Departamentos', 'Reporteros', 'Resueltos por día', 'Detalle de tickets']) {
      await user.click(screen.getByLabelText(label));
    }

    expect(screen.getByRole('button', { name: 'Descargar PDF' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Exportar CSV' }));
    expect(download).not.toHaveBeenCalled();
  });

  it('muestra estados vacíos en las secciones sin datos', async () => {
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
    expect(screen.getAllByText('Sin datos').length).toBeGreaterThanOrEqual(5);
  });

  it('muestra el resumen de registros y el límite de exportación', async () => {
    renderWithProviders(<Reports />, { route: '/app/reports' });

    expect(await screen.findByText(/registro\(s\), máximo 500 en exportación/)).toBeInTheDocument();
  });
});