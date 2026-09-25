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

function auditResp(rows = [history()], overrides = {}) {
  return { data: rows, total: rows.length, page: 1, perPage: 30, pages: 1, actions: ACTIONS, ...overrides };
}

function setup(resp = auditResp()) {
  api.get.mockImplementation((url) => {
    if (url.startsWith('/api/audit?')) return Promise.resolve(resp);
    if (url === '/api/users') return Promise.resolve(USERS);
    return Promise.reject(new Error(`404 ${url}`));
  });
}

function auditCalls() {
  return api.get.mock.calls.filter(([u]) => u.startsWith('/api/audit?')).length;
}

function lastAuditUrl() {
  const calls = api.get.mock.calls.filter(([u]) => u.startsWith('/api/audit?'));
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
    expect(api.get).toHaveBeenCalledWith('/api/audit?page=1&perPage=30');
  });

  it('muestra los registros con usuario, acción y detalle', async () => {
    renderWithProviders(<Audit />, { route: '/app/audit' });

    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('Cambio de estado')).toBeInTheDocument();
    expect(screen.getByText('Cambió el estado del ticket')).toBeInTheDocument();
    expect(screen.getByText('OPEN → IN_PROGRESS')).toBeInTheDocument();
    expect(screen.getByText('Fecha')).toBeInTheDocument();
    expect(screen.getByText('Usuario')).toBeInTheDocument();
    expect(screen.getByText('Ticket')).toBeInTheDocument();
    expect(screen.getByText('Acción')).toBeInTheDocument();
    expect(screen.getByText('Detalle')).toBeInTheDocument();
  });

  it('traduce las etiquetas de acción conocidas', async () => {
    setup(
      auditResp([
        history({ id: 1, action: 'CREATED', description: 'Ticket creado' }),
        history({ id: 2, action: 'RESOLVED', description: 'Ticket resuelto' }),
        history({ id: 3, action: 'ESCALATED', description: 'Escalado' }),
        history({ id: 4, action: 'ACCION_DESCONOCIDA', description: 'Acción rara' }),
      ])
    );

    renderWithProviders(<Audit />, { route: '/app/audit' });
    expect(await screen.findByText('Ticket creado')).toBeInTheDocument();
    expect(screen.getByText('Creación')).toBeInTheDocument();
    expect(screen.getByText('Resolución')).toBeInTheDocument();
    expect(screen.getByText('Escalación automática')).toBeInTheDocument();
    expect(screen.getByText('ACCION_DESCONOCIDA')).toBeInTheDocument();
  });

  it('muestra el guion cuando el registro no tiene usuario ni valores previos', async () => {
    setup(auditResp([history({ user_name: null, old_value: null, new_value: null, description: 'Sin actor' })]));

    renderWithProviders(<Audit />, { route: '/app/audit' });
    expect(await screen.findByText('Sin actor')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
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
    setup(auditResp([]));

    renderWithProviders(<Audit />, { route: '/app/audit' });
    expect(await screen.findByText('Sin registros')).toBeInTheDocument();
    expect(screen.getByText('No se encontraron cambios con los criterios seleccionados.')).toBeInTheDocument();
  });

  it('filtra por texto, acción, usuario y rango de fechas', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Audit />, { route: '/app/audit' });
    await screen.findByText('TCK-000011');

    await user.type(screen.getByPlaceholderText('Ticket, título o detalle…'), 'impresora');
    await user.selectOptions(screen.getByLabelText('Acción'), 'RESOLVED');
    await user.selectOptions(screen.getByLabelText('Usuario'), '2');
    await user.type(screen.getByLabelText('Desde'), '2026-09-01');
    await user.type(screen.getByLabelText('Hasta'), '2026-09-30');
    await user.click(screen.getByRole('button', { name: 'Filtrar' }));

    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith(
        '/api/audit?search=impresora&action=RESOLVED&user=2&from=2026-09-01&to=2026-09-30&page=1&perPage=30'
      )
    );
  });

  it('no consulta la API hasta que se envía el formulario', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Audit />, { route: '/app/audit' });
    await screen.findByText('TCK-000011');

    const before = auditCalls();
    await user.type(screen.getByPlaceholderText('Ticket, título o detalle…'), 'abc');
    expect(auditCalls()).toBe(before);
  });

  it('ofrece en el filtro de acción solo las acciones existentes', async () => {
    renderWithProviders(<Audit />, { route: '/app/audit' });

    const select = await screen.findByLabelText('Acción');
    const options = within(select).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Todas', 'Creación', 'Cambio de estado', 'Resolución']);
  });

  it('lista los usuarios obtenidos para el filtro', async () => {
    renderWithProviders(<Audit />, { route: '/app/audit' });

    const select = await screen.findByLabelText('Usuario');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Todos', 'Ada Lovelace', 'Grace Hopper']);
    expect(api.get).toHaveBeenCalledWith('/api/users');
  });

  it('pide la página 1 al filtrar de nuevo', async () => {
    setup(auditResp([history()], { total: 90, page: 3, pages: 3 }));

    const user = userEvent.setup();
    renderWithProviders(<Audit />, { route: '/app/audit' });
    await screen.findByText('TCK-000011');

    await user.click(screen.getByRole('button', { name: 'Siguiente →' }));
    await waitFor(() => expect(lastAuditUrl()).toBe('/api/audit?page=2&perPage=30'));

    await user.type(screen.getByPlaceholderText('Ticket, título o detalle…'), 'pc');
    await user.click(screen.getByRole('button', { name: 'Filtrar' }));
    await waitFor(() => expect(lastAuditUrl()).toBe('/api/audit?search=pc&page=1&perPage=30'));
  });

  it('pagina hacia atrás y adelante', async () => {
    setup(auditResp([history()], { total: 90, page: 1, pages: 3 }));

    const user = userEvent.setup();
    renderWithProviders(<Audit />, { route: '/app/audit' });
    await screen.findByText('TCK-000011');

    expect(screen.getByText('1–30 de 90 · Página 1 de 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '← Anterior' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Siguiente →' }));
    await waitFor(() => expect(lastAuditUrl()).toBe('/api/audit?page=2&perPage=30'));

    await user.click(screen.getByRole('button', { name: '← Anterior' }));
    await waitFor(() => expect(lastAuditUrl()).toBe('/api/audit?page=1&perPage=30'));
  });

  it('cambia el número de registros por página y vuelve a la primera página', async () => {
    setup(auditResp([history()], { total: 90, page: 2, pages: 3 }));

    const user = userEvent.setup();
    renderWithProviders(<Audit />, { route: '/app/audit' });
    await screen.findByText('TCK-000011');

    await user.click(screen.getByRole('button', { name: 'Siguiente →' }));
    await waitFor(() => expect(lastAuditUrl()).toBe('/api/audit?page=2&perPage=30'));

    await user.selectOptions(screen.getByDisplayValue('30'), '50');
    await waitFor(() => expect(lastAuditUrl()).toBe('/api/audit?page=1&perPage=50'));
  });

  it('mantiene la tabla anterior mientras carga la página siguiente', async () => {
    setup(auditResp([history()], { total: 90, page: 1, pages: 3 }));
    const user = userEvent.setup();
    renderWithProviders(<Audit />, { route: '/app/audit' });
    await screen.findByText('TCK-000011');

    api.get.mockImplementation((url) => {
      if (url === '/api/audit?page=2&perPage=30') return new Promise(() => {});
      if (url.startsWith('/api/audit?')) return Promise.resolve(auditResp([history()], { total: 90, page: 1, pages: 3 }));
      if (url === '/api/users') return Promise.resolve(USERS);
      return Promise.reject(new Error(`404 ${url}`));
    });

    await user.click(screen.getByRole('button', { name: 'Siguiente →' }));
    await waitFor(() => expect(screen.getByText('TCK-000011')).toBeInTheDocument());
  });

  it('limpia el formulario de filtros sin volver a consultar', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Audit />, { route: '/app/audit' });
    await screen.findByText('TCK-000011');

    await user.type(screen.getByPlaceholderText('Ticket, título o detalle…'), 'pc');
    await user.click(screen.getByRole('button', { name: 'Filtrar' }));
    await waitFor(() => expect(lastAuditUrl()).toBe('/api/audit?search=pc&page=1&perPage=30'));

    const before = auditCalls();
    await user.click(screen.getByRole('button', { name: 'Limpiar' }));

    expect(screen.getByPlaceholderText('Ticket, título o detalle…')).toHaveValue('');
    expect(screen.getByLabelText('Acción')).toHaveValue('');
    expect(screen.getByLabelText('Usuario')).toHaveValue('');
    expect(auditCalls()).toBe(before);
  });
});
