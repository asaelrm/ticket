import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Audit from './Audit';
import { api } from '../lib/api';
import { renderWithProviders } from '../test/utils';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual('../lib/api');
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  };
});

const USERS = { data: [{ id: 2, name: 'Ada', last_name: 'Lovelace' }, { id: 3, name: 'Grace', last_name: 'Hopper' }] };
const ACTIONS = ['CREATED', 'STATUS_CHANGED', 'RESOLVED'];

function history(overrides = {}) {
  return {
    id: 1,
    ticket_id: 11,
    ticket_number: 'TCK-000011',
    user_name: 'Ada Lovelace',
    action: 'STATUS_CHANGED',
    description: 'Cambió el estado del ticket',
    old_value: 'OPEN',
    new_value: 'IN_PROGRESS',
    created_at: '2026-09-20T10:00:00Z',
    ...overrides,
  };
}

// La respuesta hace eco de la página solicitada para que la paginación sea coherente.
function setup(rows = [history()], { total = 90 } = {}) {
  api.get.mockImplementation((url) => {
    if (url.startsWith('/api/audit?')) {
      const params = new URLSearchParams(url.slice('/api/audit?'.length));
      const page = Number(params.get('page') || 1);
      const perPage = Number(params.get('perPage') || 10);
      return Promise.resolve({
        data: rows,
        total,
        page,
        perPage,
        pages: Math.max(1, Math.ceil(total / perPage)),
        actions: ACTIONS,
      });
    }
    if (url === '/api/users') return Promise.resolve(USERS);
    return Promise.reject(new Error(`404 ${url}`));
  });
}

function auditCalls() {
  return api.get.mock.calls.filter(([u]) => u.startsWith('/api/audit?'));
}

function lastAuditUrl() {
  const calls = auditCalls();
  return calls[calls.length - 1][0];
}

beforeEach(() => {
  vi.resetAllMocks();
  setup();
});

describe('Audit', () => {
  it('muestra la pantalla de carga mientras la API responde', () => {
    api.get.mockImplementation((url) => (url.startsWith('/api/audit?') ? new Promise(() => {}) : Promise.resolve(USERS)));

    renderWithProviders(<Audit />, { route: '/app/audit' });
    expect(screen.getByText('Cargando auditoría…')).toBeInTheDocument();
  });

  it('consulta la auditoría sin filtros y con la paginación por defecto', async () => {
    renderWithProviders(<Audit />, { route: '/app/audit' });

    expect(await screen.findByText('TCK-000011')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/api/audit?page=1&perPage=10');
  });

  it('muestra los registros con usuario, acción y detalle', async () => {
    renderWithProviders(<Audit />, { route: '/app/audit' });

    expect(await screen.findByText('TCK-000011')).toBeInTheDocument();
    const table = within(screen.getByRole('table'));
    expect(table.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(table.getByText('Cambio de estado')).toBeInTheDocument();
    expect(table.getByText('Cambió el estado del ticket')).toBeInTheDocument();
    expect(table.getByText('OPEN → IN_PROGRESS')).toBeInTheDocument();
    expect(table.getByText('Fecha')).toBeInTheDocument();
    expect(table.getByText('Usuario')).toBeInTheDocument();
    expect(table.getByText('Ticket')).toBeInTheDocument();
    expect(table.getByText('Acción')).toBeInTheDocument();
    expect(table.getByText('Detalle')).toBeInTheDocument();
  });

  it('traduce las etiquetas de acción conocidas y conserva las desconocidas', async () => {
    setup([
      history({ id: 1, action: 'CREATED', description: 'Ticket creado' }),
      history({ id: 2, action: 'RESOLVED', description: 'Ticket resuelto' }),
      history({ id: 3, action: 'ESCALATED', description: 'Escalado' }),
      history({ id: 4, action: 'ACCION_DESCONOCIDA', description: 'Acción rara' }),
    ]);

    renderWithProviders(<Audit />, { route: '/app/audit' });
    expect(await screen.findByText('Ticket creado')).toBeInTheDocument();
    const table = within(screen.getByRole('table'));
    expect(table.getByText('Creación')).toBeInTheDocument();
    expect(table.getByText('Resolución')).toBeInTheDocument();
    expect(table.getByText('Escalación automática')).toBeInTheDocument();
    expect(table.getByText('ACCION_DESCONOCIDA')).toBeInTheDocument();
  });

  it('muestra el guion cuando el registro no tiene usuario ni valores previos', async () => {
    setup([history({ user_name: null, old_value: null, new_value: null, description: 'Sin actor' })], { total: 1 });

    renderWithProviders(<Audit />, { route: '/app/audit' });
    expect(await screen.findByText('Sin actor')).toBeInTheDocument();
    expect(within(screen.getByRole('table')).getAllByText('—').length).toBeGreaterThan(0);
  });

  it('enlaza cada registro con su ticket', async () => {
    renderWithProviders(<Audit />, { route: '/app/audit' });

    const link = await screen.findByRole('link', { name: 'TCK-000011' });
    expect(link).toHaveAttribute('href', '/app/tickets/11');
  });

  it('muestra el error de carga', async () => {
    api.get.mockImplementation((url) => (url.startsWith('/api/audit?') ? Promise.reject(new Error('No se pudieron cargar los registros')) : Promise.resolve(USERS)));

    renderWithProviders(<Audit />, { route: '/app/audit' });
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudieron cargar los registros');
  });

  it('muestra el estado vacío cuando no hay coincidencias', async () => {
    setup([], { total: 0 });

    renderWithProviders(<Audit />, { route: '/app/audit' });
    expect(await screen.findByText('Sin registros')).toBeInTheDocument();
    expect(screen.getByText('No se encontraron cambios con los criterios seleccionados.')).toBeInTheDocument();
  });

  it('no consulta la API mientras se escribe en los filtros', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Audit />, { route: '/app/audit' });
    await screen.findByText('TCK-000011');

    const before = auditCalls().length;
    await user.type(screen.getByPlaceholderText('Ticket, título o detalle…'), 'abc');
    expect(auditCalls().length).toBe(before);
  });

  it('envía al API todos los filtros escritos al pulsar Filtrar', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Audit />, { route: '/app/audit' });
    await screen.findByText('TCK-000011');
    await screen.findByRole('option', { name: 'Resolución' });

    await user.type(screen.getByPlaceholderText('Ticket, título o detalle…'), 'impresora');
    await user.selectOptions(screen.getByLabelText('Acción'), 'RESOLVED');
    await user.selectOptions(screen.getByLabelText('Usuario'), '2');
    await user.type(screen.getByLabelText('Desde'), '2026-09-01');
    await user.type(screen.getByLabelText('Hasta'), '2026-09-30');

    const before = auditCalls().length;
    await user.click(screen.getByRole('button', { name: 'Filtrar' }));

    await waitFor(() =>
      expect(lastAuditUrl()).toBe(
        '/api/audit?search=impresora&action=RESOLVED&user=2&from=2026-09-01&to=2026-09-30&page=1&perPage=10'
      )
    );
    expect(auditCalls().length).toBe(before + 1);
    expect(screen.getByPlaceholderText('Ticket, título o detalle…')).toHaveValue('impresora');
    expect(screen.getByLabelText('Acción')).toHaveValue('RESOLVED');
  });

  it('la consulta distingue los filtros aplicados en su queryKey', async () => {
    const user = userEvent.setup();
    const { queryClient } = renderWithProviders(<Audit />, { route: '/app/audit' });
    await screen.findByText('TCK-000011');
    await screen.findByRole('option', { name: 'Creación' });

    expect(queryClient.getQueryData(['audit', { search: '', action: '', user: '', from: '', to: '', page: 1, perPage: 10 }])).toBeDefined();

    await user.selectOptions(screen.getByLabelText('Acción'), 'CREATED');
    await user.click(screen.getByRole('button', { name: 'Filtrar' }));

    await waitFor(() =>
      expect(queryClient.getQueryData(['audit', { search: '', action: 'CREATED', user: '', from: '', to: '', page: 1, perPage: 10 }])).toBeDefined()
    );
  });

  it('aplicar filtros vacíos consulta sin parámetros de filtro', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Audit />, { route: '/app/audit' });
    await screen.findByText('TCK-000011');

    await user.type(screen.getByPlaceholderText('Ticket, título o detalle…'), 'pc');
    await user.click(screen.getByRole('button', { name: 'Filtrar' }));
    await waitFor(() => expect(lastAuditUrl()).toBe('/api/audit?search=pc&page=1&perPage=10'));

    await user.click(screen.getByRole('button', { name: 'Limpiar' }));
    await user.click(screen.getByRole('button', { name: 'Filtrar' }));
    await waitFor(() => expect(lastAuditUrl()).toBe('/api/audit?page=1&perPage=10'));
  });

  it('la paginación tampoco arrastra los filtros pendientes del formulario', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Audit />, { route: '/app/audit' });
    await screen.findByText('TCK-000011');

    await user.type(screen.getByPlaceholderText('Ticket, título o detalle…'), 'impresora');
    await user.click(screen.getByRole('button', { name: 'Siguiente →' }));

    await waitFor(() => expect(lastAuditUrl()).toBe('/api/audit?page=2&perPage=10'));
  });

  it('ofrece en el filtro de acción solo las acciones existentes', async () => {
    renderWithProviders(<Audit />, { route: '/app/audit' });

    const select = await screen.findByLabelText('Acción');
    await within(select).findByRole('option', { name: 'Resolución' });
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Todas',
      'Creación',
      'Cambio de estado',
      'Resolución',
    ]);
  });

  it('lista los usuarios obtenidos para el filtro', async () => {
    renderWithProviders(<Audit />, { route: '/app/audit' });

    const select = await screen.findByLabelText('Usuario');
    await within(select).findByRole('option', { name: 'Ada Lovelace' });
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Todos', 'Ada Lovelace', 'Grace Hopper']);
    expect(api.get).toHaveBeenCalledWith('/api/users');
  });

  it('pagina hacia atrás y adelante', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Audit />, { route: '/app/audit' });
    await screen.findByText('TCK-000011');

    expect(screen.getByText('1–10 de 90 · Página 1 de 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '← Anterior' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Siguiente →' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Siguiente →' }));
    await waitFor(() => expect(lastAuditUrl()).toBe('/api/audit?page=2&perPage=10'));
    expect(await screen.findByText('11–20 de 90 · Página 2 de 3')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '← Anterior' }));
    await waitFor(() => expect(lastAuditUrl()).toBe('/api/audit?page=1&perPage=10'));
  });

  it('deshabilita el avance en la última página', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Audit />, { route: '/app/audit' });
    await screen.findByText('TCK-000011');

    await user.click(screen.getByRole('button', { name: 'Siguiente →' }));
    await screen.findByText('11–20 de 90 · Página 2 de 3');
    await user.click(screen.getByRole('button', { name: 'Siguiente →' }));
    await screen.findByText('21–30 de 90 · Página 3 de 3');

    expect(screen.getByRole('button', { name: 'Siguiente →' })).toBeDisabled();
    expect(lastAuditUrl()).toBe('/api/audit?page=3&perPage=10');
  });

  it('cambia el número de registros por página y vuelve a la primera página', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Audit />, { route: '/app/audit' });
    await screen.findByText('TCK-000011');

    await user.click(screen.getByRole('button', { name: 'Siguiente →' }));
    await waitFor(() => expect(lastAuditUrl()).toBe('/api/audit?page=2&perPage=10'));

    await user.selectOptions(screen.getByRole('combobox', { name: /Mostrar/ }), '50');
    await waitFor(() => expect(lastAuditUrl()).toBe('/api/audit?page=1&perPage=50'));
  });

  it('el selector de registros por página muestra el mismo valor que se envía a la API', async () => {
    renderWithProviders(<Audit />, { route: '/app/audit' });
    await screen.findByText('TCK-000011');

    const select = screen.getByRole('combobox', { name: /Mostrar/ });
    expect(within(select).getAllByRole('option').map((o) => o.value)).toEqual(['10', '25', '50', '100']);
    expect(select).toHaveValue('10');
    expect(lastAuditUrl()).toBe('/api/audit?page=1&perPage=10');
  });

  it('mantiene la tabla anterior mientras carga la página siguiente', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Audit />, { route: '/app/audit' });
    await screen.findByText('TCK-000011');

    const base = api.get.getMockImplementation();
    api.get.mockImplementation((url) => {
      if (url === '/api/audit?page=2&perPage=10') return new Promise(() => {});
      return base(url);
    });

    await user.click(screen.getByRole('button', { name: 'Siguiente →' }));
    await waitFor(() => expect(screen.getByText('TCK-000011')).toBeInTheDocument());
    expect(screen.queryByText('Sin registros')).not.toBeInTheDocument();
  });

  it('limpia el formulario de filtros sin volver a consultar', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Audit />, { route: '/app/audit' });
    await screen.findByText('TCK-000011');
    await screen.findByRole('option', { name: 'Ada Lovelace' });

    await user.type(screen.getByPlaceholderText('Ticket, título o detalle…'), 'pc');
    await user.selectOptions(screen.getByLabelText('Acción'), 'CREATED');
    await user.selectOptions(screen.getByLabelText('Usuario'), '3');

    const before = auditCalls().length;
    await user.click(screen.getByRole('button', { name: 'Limpiar' }));

    expect(screen.getByPlaceholderText('Ticket, título o detalle…')).toHaveValue('');
    expect(screen.getByLabelText('Acción')).toHaveValue('');
    expect(screen.getByLabelText('Usuario')).toHaveValue('');
    expect(screen.getByLabelText('Desde')).toHaveValue('');
    expect(screen.getByLabelText('Hasta')).toHaveValue('');
    expect(auditCalls().length).toBe(before);
  });
});
