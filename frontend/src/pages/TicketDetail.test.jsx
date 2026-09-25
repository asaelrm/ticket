import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TicketDetail from './TicketDetail';
import { api } from '../lib/api';
import { renderWithProviders } from '../test/utils';

const { authState } = vi.hoisted(() => ({
  authState: { user: null },
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: authState.user }),
  can: (user, permission) => !!user?.permissions?.includes(permission),
}));

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual('../lib/api');
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  };
});

let es;

class MockEventSource {
  constructor(url) {
    this.url = url;
    this.listeners = {};
    this.onopen = null;
    this.onerror = null;
    this.onmessage = null;
    this.close = vi.fn();
    es = this;
  }
  addEventListener(type, cb) {
    this.listeners[type] = cb;
  }
  removeEventListener() {}
  emit(type, data) {
    const cb = this.listeners[type];
    if (cb) cb({ data: JSON.stringify(data) });
  }
}

function ticket(overrides = {}) {
  return {
    id: 1,
    ticket_number: 'TCK-000001',
    title: 'PC no enciende',
    description: 'El equipo no enciende desde ayer por la tarde.',
    status: 'OPEN',
    priority: 'HIGH',
    category_id: 1,
    category_name: 'Hardware',
    reporter_id: 2,
    reporter_name: 'Ana DÃ­az',
    assigned_to_id: null,
    assigned_name: null,
    assigned_team_id: null,
    team_name: null,
    department_id: 1,
    department_name: 'TI',
    created_at: '2026-09-20T10:00:00Z',
    updated_at: '2026-09-20T10:00:00Z',
    sla_due_at: '2026-09-28T10:00:00Z',
    ...overrides,
  };
}

function detailData(overrides = {}, ticketOverrides = {}) {
  return {
    ticket: ticket(ticketOverrides),
    comments: [
      {
        id: 1,
        user_id: 3,
        user_name: 'Carlos Ruiz',
        message: 'Revisando el problemaâ€¦',
        is_internal: false,
        created_at: '2026-09-21T09:00:00Z',
      },
    ],
    attachments: [],
    history: [
      { id: 1, action: 'CREATED', user_name: 'Ana DÃ­az', description: 'creÃ³ el ticket', created_at: '2026-09-20T10:00:00Z' },
    ],
    can: {
      comment: true,
      note: true,
      manage: true,
      resolve: true,
      close: true,
      cancel: true,
      reopen: true,
      assign: true,
    },
    ...overrides,
  };
}

const OPTIONS = {
  csat_enabled: true,
  root_causes: ['Hardware', 'Software'],
  resolution_categories: ['Reemplazo', 'ReparaciÃ³n'],
  pending_reasons: ['Esperando cliente', 'Dependencia externa'],
};

const USERS = [{ id: 5, name: 'Juan', last_name: 'PÃ©rez' }];
const TEAMS = [{ id: 3, name: 'Soporte' }];
const CATEGORIES = [{ id: 2, name: 'Software' }];

const USER_TECH = { id: 9, name: 'TÃ©cnico' };

beforeEach(() => {
  es = undefined;
  vi.clearAllMocks();
  vi.stubGlobal('EventSource', MockEventSource);
  authState.user = USER_TECH;
  api.get.mockImplementation((url) => {
    if (url === '/api/tickets/1') return Promise.resolve(detailData());
    if (url === '/api/tickets/options') return Promise.resolve(OPTIONS);
    if (url === '/api/users/assignable') return Promise.resolve({ data: USERS });
    if (url === '/api/teams/assignable') return Promise.resolve({ data: TEAMS });
    if (url === '/api/categories?active=1') return Promise.resolve({ data: CATEGORIES });
    return Promise.reject(new Error(`404 ${url}`));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function fieldSelect(labelText) {
  const label = screen.getByText(labelText, { selector: 'label' });
  return label.closest('div').querySelector('select');
}

describe('TicketDetail', () => {
  it('muestra los datos del ticket tras la carga', async () => {
    renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });

    expect(await screen.findByText('PC no enciende')).toBeInTheDocument();
    expect(screen.getByText('TCK-000001')).toBeInTheDocument();
    expect(screen.getByText('El equipo no enciende desde ayer por la tarde.')).toBeInTheDocument();
    expect(screen.getAllByText('Ana DÃ­az').length).toBeGreaterThan(0);
    expect(screen.getByText(/reportÃ³/)).toBeInTheDocument();
    expect(screen.getByText('Revisando el problemaâ€¦')).toBeInTheDocument();
    expect(screen.getByText('Carlos Ruiz')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/api/tickets/1');
    expect(api.get).toHaveBeenCalledWith('/api/tickets/options');
  });

  it('muestra el estado de carga mientras la API responde', async () => {
    let resolveDetail;
    api.get.mockImplementation((url) => {
      if (url === '/api/tickets/1') return new Promise((r) => { resolveDetail = r; });
      if (url === '/api/tickets/options') return Promise.resolve(OPTIONS);
      if (url === '/api/users/assignable') return Promise.resolve({ data: USERS });
      if (url === '/api/teams/assignable') return Promise.resolve({ data: TEAMS });
      if (url === '/api/categories?active=1') return Promise.resolve({ data: CATEGORIES });
      return Promise.reject(new Error(`404 ${url}`));
    });

    renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
    expect(screen.getByText('Cargando ticketâ€¦')).toBeInTheDocument();

    resolveDetail(detailData());
    expect(await screen.findByText('PC no enciende')).toBeInTheDocument();
  });

  it('muestra el error de carga y permite reintentar', async () => {
    api.get.mockRejectedValueOnce(new Error('Ticket no encontrado'));

    renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
    expect(await screen.findByRole('alert')).toHaveTextContent('Ticket no encontrado');

    const callsBefore = api.get.mock.calls.filter(([u]) => u === '/api/tickets/1').length;
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reintentar' }));

    await waitFor(() => expect(api.get.mock.calls.filter(([u]) => u === '/api/tickets/1').length).toBeGreaterThan(callsBefore));
    expect(await screen.findByText('PC no enciende')).toBeInTheDocument();
  });

  it('actualiza el estado del ticket', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
    await screen.findByText('PC no enciende');

    await user.selectOptions(fieldSelect('Estado'), 'IN_PROGRESS');
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/tickets/1', { status: 'IN_PROGRESS' }));
  });

  it('actualiza la prioridad del ticket', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
    await screen.findByText('PC no enciende');

    await user.selectOptions(fieldSelect('Prioridad'), 'LOW');
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/tickets/1', { priority: 'LOW' }));
  });

  it('asigna el ticket a un usuario', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
    await screen.findByText('PC no enciende');

    await user.selectOptions(fieldSelect('Asignado a'), '5');
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/tickets/1', { assigned_to_id: 5 }));
  });

  it('asigna el ticket a un equipo', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
    await screen.findByText('PC no enciende');

    await user.selectOptions(fieldSelect('Equipo'), '3');
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/tickets/1', { assigned_team_id: 3 }));
  });

  it('cambia la categorÃ­a del ticket', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
    await screen.findByText('PC no enciende');

    await user.selectOptions(fieldSelect('CategorÃ­a'), '2');
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/tickets/1', { category_id: 2 }));
  });

  it('resuelve el ticket desde el drawer y envÃ­a la soluciÃ³n', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
    await screen.findByText('PC no enciende');

    await user.click(screen.getByRole('button', { name: 'Resolver ticket' }));
    const drawer = await screen.findByRole('dialog', { name: 'Resolver ticket' });

    await user.type(within(drawer).getByLabelText(/SoluciÃ³n/), 'Se reemplazÃ³ la GPU');
    await user.click(within(drawer).getByRole('button', { name: 'Resolver ticket' }));

    await waitFor(() => {
      const calls = api.post.mock.calls.filter(([u]) => u === '/api/tickets/1/resolve');
      expect(calls).toHaveLength(1);
      const fd = calls[0][2];
      expect(fd.get('resolution')).toBe('Se reemplazÃ³ la GPU');
      expect(fd.get('notify')).toBe('1');
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Resolver ticket' })).not.toBeInTheDocument());
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/tickets/1'));
  });

  it('cierra el ticket con una nota', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
    await screen.findByText('PC no enciende');

    await user.click(screen.getByRole('button', { name: 'Cerrar' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cerrar ticket' });

    await user.type(within(dialog).getByPlaceholderText('Comentario interno sobre el cierreâ€¦'), 'Todo verificado');
    await user.click(within(dialog).getByRole('button', { name: 'Cerrar ticket' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/tickets/1/close', { note: 'Todo verificado' }));
  });

  it('cancela el ticket con motivo obligatorio', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
    await screen.findByText('PC no enciende');

    await user.click(screen.getByRole('button', { name: 'Cancelar ticket' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancelar ticket' });

    const submit = within(dialog).getByRole('button', { name: 'Cancelar ticket' });
    expect(submit).toBeDisabled();

    await user.type(within(dialog).getByLabelText('Motivo de cancelaciÃ³n *'), 'El usuario ya no lo necesita');
    expect(submit).toBeEnabled();
    await user.click(submit);

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/tickets/1/cancel', { reason: 'El usuario ya no lo necesita' }));
  });

  it('reabre el ticket resuelto', async () => {
    const user = userEvent.setup();
    api.get.mockImplementation((url) => {
      if (url === '/api/tickets/1') return Promise.resolve(detailData({}, { status: 'RESOLVED' }));
      if (url === '/api/tickets/options') return Promise.resolve(OPTIONS);
      if (url === '/api/users/assignable') return Promise.resolve({ data: USERS });
      if (url === '/api/teams/assignable') return Promise.resolve({ data: TEAMS });
      if (url === '/api/categories?active=1') return Promise.resolve({ data: CATEGORIES });
      return Promise.reject(new Error(`404 ${url}`));
    });

    renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
    await screen.findByText('PC no enciende');

    await user.click(screen.getByRole('button', { name: 'Reabrir' }));
    const drawer = await screen.findByRole('dialog', { name: 'Reabrir ticket' });

    const submit = within(drawer).getByRole('button', { name: 'Reabrir' });
    expect(submit).toBeDisabled();

    await user.type(within(drawer).getByPlaceholderText('Explique por quÃ© el ticket debe reabrirseâ€¦'), 'El usuario volviÃ³ a reportar el fallo');
    await user.click(submit);

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/tickets/1/reopen', { reason: 'El usuario volviÃ³ a reportar el fallo' }));
  });

  it('marca el ticket como pendiente desde el selector de estado', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
    await screen.findByText('PC no enciende');

    await user.selectOptions(fieldSelect('Estado'), 'PENDING');
    const drawer = await screen.findByRole('dialog', { name: 'Marcar como pendiente' });

    await user.selectOptions(within(drawer).getAllByRole('combobox')[0], 'Esperando cliente');
    await user.click(within(drawer).getByRole('button', { name: 'Marcar pendiente' }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/tickets/1', { status: 'PENDING', pending_reason: 'Esperando cliente' }));
  });

  it('envÃ­a un comentario pÃºblico', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
    await screen.findByText('PC no enciende');

    await user.type(screen.getByPlaceholderText('Escriba una respuesta para el empleadoâ€¦'), 'Ya estamos trabajando en ello');
    await user.click(screen.getByRole('button', { name: 'Enviar respuesta' }));

    await waitFor(() => {
      const calls = api.post.mock.calls.filter(([u]) => u === '/api/tickets/1/comments');
      expect(calls).toHaveLength(1);
      const fd = calls[0][2];
      expect(fd.get('message')).toBe('Ya estamos trabajando en ello');
    });
    await waitFor(() => expect(screen.getByPlaceholderText('Escriba una respuesta para el empleadoâ€¦')).toHaveValue(''));
  });

  it('envÃ­a una nota interna marcada como interna', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
    await screen.findByText('PC no enciende');

    const editorCard = screen.getByPlaceholderText('Escriba una respuesta para el empleadoâ€¦').closest('.card');
    await user.click(within(editorCard).getByRole('button', { name: /Nota interna/ }));

    const internalArea = await screen.findByPlaceholderText('Escriba una nota interna (no visible para el empleado)â€¦');
    await user.type(internalArea, 'Nota visible solo para el equipo');
    await user.click(screen.getByRole('button', { name: 'Guardar nota interna' }));

    await waitFor(() => {
      const calls = api.post.mock.calls.filter(([u]) => u === '/api/tickets/1/comments');
      expect(calls).toHaveLength(1);
      const fd = calls[0][2];
      expect(fd.get('message')).toBe('Nota visible solo para el equipo');
      expect(fd.get('is_internal')).toBe('1');
    });
  });

  it('muestra los adjuntos de imagen y de archivo', async () => {
    const attachments = [
      { id: 10, comment_id: null, original_name: 'foto.png', mime_type: 'image/png', size_bytes: 2048 },
      { id: 11, comment_id: null, original_name: 'log.txt', mime_type: 'text/plain', size_bytes: 512 },
    ];
    api.get.mockImplementation((url) => {
      if (url === '/api/tickets/1') return Promise.resolve(detailData({ attachments }));
      if (url === '/api/tickets/options') return Promise.resolve(OPTIONS);
      if (url === '/api/users/assignable') return Promise.resolve({ data: USERS });
      if (url === '/api/teams/assignable') return Promise.resolve({ data: TEAMS });
      if (url === '/api/categories?active=1') return Promise.resolve({ data: CATEGORIES });
      return Promise.reject(new Error(`404 ${url}`));
    });

    renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
    await screen.findByText('Adjuntos (2)');

    expect(screen.getByAltText('foto.png')).toHaveAttribute('src', '/api/files/10');
    expect(screen.getByText('log.txt')).toBeInTheDocument();
    expect(screen.getByText('512 B')).toBeInTheDocument();
  });

  it('se conecta al stream SSE del ticket en vivo y recibe comentarios', async () => {
    renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
    await screen.findByText('PC no enciende');

    expect(es).toBeDefined();
    expect(es.url).toBe('/api/tickets/1/stream');
    expect(screen.getByText('Sin conexiÃ³n')).toBeInTheDocument();

    es.emit('ready');
    await waitFor(() => expect(screen.getByText('En vivo')).toBeInTheDocument());

    es.emit('comment', {
      comment: { id: 99, user_id: 3, user_name: 'Carlos Ruiz', message: 'Comentario en vivo por SSE', is_internal: false, created_at: '2026-09-22T10:00:00Z' },
      attachments: [],
    });
    expect(await screen.findByText('Comentario en vivo por SSE')).toBeInTheDocument();
  });

  it('muestra al usuario que estÃ¡ escribiendo y refresca por SSE', async () => {
    renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
    await screen.findByText('PC no enciende');

    const detailCalls = () => api.get.mock.calls.filter(([u]) => u === '/api/tickets/1').length;
    const before = detailCalls();

    es.emit('typing', { user_id: 7, user_name: 'LucÃ­a' });
    await waitFor(() => expect(screen.getByText('LucÃ­a estÃ¡ escribiendoâ€¦')).toBeInTheDocument());

    es.emit('refresh', {});
    await waitFor(() => expect(detailCalls()).toBeGreaterThan(before));
  });

  it('cierra el stream SSE al desmontar', async () => {
    const result = renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
    await screen.findByText('PC no enciende');

    expect(es).toBeDefined();
    result.unmount();
    expect(es.close).toHaveBeenCalled();
  });

  it('oculta acciones y muestra solo lectura sin permisos de gestiÃ³n', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/api/tickets/1') return Promise.resolve(detailData({ can: { comment: false, note: false, manage: false, resolve: false, close: false, cancel: false, reopen: false, assign: false } }));
      if (url === '/api/tickets/options') return Promise.resolve(OPTIONS);
      if (url === '/api/users/assignable') return Promise.resolve({ data: USERS });
      if (url === '/api/teams/assignable') return Promise.resolve({ data: TEAMS });
      if (url === '/api/categories?active=1') return Promise.resolve({ data: CATEGORIES });
      return Promise.reject(new Error(`404 ${url}`));
    });

    renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
    await screen.findByText('PC no enciende');

    expect(screen.queryByRole('button', { name: 'Responder' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Resolver ticket/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getAllByText('Abierto').length).toBeGreaterThan(0);
  });

  it('muestra y envÃ­a la encuesta CSAT al reporter', async () => {
    const user = userEvent.setup();
    authState.user = { id: 2, name: 'Ana DÃ­az' };
    api.get.mockImplementation((url) => {
      if (url === '/api/tickets/1') return Promise.resolve(detailData({}, { status: 'RESOLVED' }));
      if (url === '/api/tickets/options') return Promise.resolve(OPTIONS);
      if (url === '/api/users/assignable') return Promise.resolve({ data: USERS });
      if (url === '/api/teams/assignable') return Promise.resolve({ data: TEAMS });
      if (url === '/api/categories?active=1') return Promise.resolve({ data: CATEGORIES });
      return Promise.reject(new Error(`404 ${url}`));
    });

    renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
    await screen.findByText('PC no enciende');

    expect(screen.getByText('Â¿CÃ³mo fue la atenciÃ³n recibida?')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '4 estrellas' }));
    await user.type(screen.getByPlaceholderText('Comentario (opcional)â€¦'), 'Muy satisfecho');
    await user.click(screen.getByRole('button', { name: 'Enviar calificaciÃ³n' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/tickets/1/csat', { rating: 4, comment: 'Muy satisfecho' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Â¡Gracias!' })).toBeInTheDocument());
  });

  it('muestra la calificaciÃ³n CSAT ya respondida', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/api/tickets/1') return Promise.resolve(detailData({}, { status: 'CLOSED', csat_answered_at: '2026-09-25T08:00:00Z', csat_rating: 5, csat_comment: 'Excelente atenciÃ³n' }));
      if (url === '/api/tickets/options') return Promise.resolve(OPTIONS);
      if (url === '/api/users/assignable') return Promise.resolve({ data: USERS });
      if (url === '/api/teams/assignable') return Promise.resolve({ data: TEAMS });
      if (url === '/api/categories?active=1') return Promise.resolve({ data: CATEGORIES });
      return Promise.reject(new Error(`404 ${url}`));
    });

    renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
    await screen.findByText('PC no enciende');

    expect(screen.getByText('SatisfacciÃ³n del usuario:')).toBeInTheDocument();
    expect(screen.getByText(/Excelente atenciÃ³n/)).toBeInTheDocument();
  });
});