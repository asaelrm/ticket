import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TicketDetail from './TicketDetail';
import { api } from '../lib/api';
import { renderWithHistory, renderWithProviders } from '../test/utils';
import {
  EDITOR_SURFACE,
  TOOLBAR_SURFACE,
  composite,
  contrastRatio,
  expectContrast,
  expectPlaceholderContrast,
  readColors,
  resolveColor,
} from '../test/contrast';

const { authState } = vi.hoisted(() => ({
  authState: { user: null },
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: authState.user }),
  can: (user, permission) => !!user?.permissions?.includes(permission),
}));

// Crea un spy similar a vi.fn() pero con dos ajustes para reproducir el
// comportamiento real de la API:
//  - sus métodos devuelven una Promise resuelta (el código encadena .catch),
//  - descarta los argumentos finales undefined (la mutation genérica siempre
//    llama api.post(path, body, formData) con formData undefined en modo JSON,
//    y toHaveBeenCalledWith compara el número exacto de argumentos).
function makeApiMethod() {
  const spy = vi.fn(() => Promise.resolve({}));
  return new Proxy(spy, {
    apply(target, ctx, args) {
      let n = args.length;
      while (n > 0 && args[n - 1] === undefined) n -= 1;
      return Reflect.apply(target, ctx, args.slice(0, n));
    },
  });
}

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual('../lib/api');
  return {
    ...actual,
    api: {
      get: makeApiMethod(),
      post: makeApiMethod(),
      put: makeApiMethod(),
      patch: makeApiMethod(),
      del: makeApiMethod(),
    },
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
    reporter_name: 'Ana Díaz',
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
        message: 'Revisando el problema…',
        is_internal: false,
        created_at: '2026-09-21T09:00:00Z',
      },
    ],
    attachments: [],
    history: [
      { id: 1, action: 'CREATED', user_name: 'Ana Díaz', description: 'creó el ticket', created_at: '2026-09-20T10:00:00Z' },
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
  resolution_categories: ['Reemplazo', 'Reparación'],
  pending_reasons: ['Esperando cliente', 'Dependencia externa'],
};

const USERS = [{ id: 5, name: 'Juan', last_name: 'Pérez' }];
const TEAMS = [{ id: 3, name: 'Soporte' }];
const CATEGORIES = [{ id: 2, name: 'Software' }];

const USER_TECH = { id: 9, name: 'Técnico' };

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

// El panel de gestión expone un `Select` por campo, con su etiqueta enlazada por
// `htmlFor`, así que se localiza por etiqueta. Antes se alcanzaba el select
// nativo con `querySelector('select')`; ahora es el propio control.
function fieldSelect(labelText) {
  return screen.getByLabelText(labelText);
}

// Abre el desplegable de un campo y elige una opción por su rótulo visible.
// El menú se monta en `document.body` (portal), así que las opciones se buscan
// en todo el documento y no dentro del drawer que abrió el control.
async function pickField(user, labelText, optionName) {
  await user.click(fieldSelect(labelText));
  await user.click(screen.getByRole('option', { name: optionName }));
}

// Abre el desplegable de Estado y devuelve los rótulos que ofrece, en orden.
// Sirve para comprobar qué transiciones se ofrecen de verdad, sin tener que
// Pulsarlas todas.
async function offeredStatusOptions(user) {
  await user.click(fieldSelect('Estado'));
  const labels = screen.getAllByRole('option').map((o) => o.textContent.trim());
  await user.keyboard('{Escape}');
  return labels;
}

// Vista del detalle con un estado y unos permisos concretos. `detailData`
// reemplaza `can` entero, así que se parte del juego completo del que usa el
// resto de la suite y se ajusta sólo lo que interesa en cada caso.
const FULL_CAN = {
  comment: true,
  note: true,
  manage: true,
  resolve: true,
  close: true,
  cancel: true,
  reopen: true,
  assign: true,
};

function detailWith(status, can = {}) {
  return detailData({ can: { ...FULL_CAN, ...can } }, { status });
}

function mockDetail(payload) {
  api.get.mockImplementation((url) => {
    if (url === '/api/tickets/1') return Promise.resolve(payload);
    if (url === '/api/tickets/options') return Promise.resolve(OPTIONS);
    if (url === '/api/users/assignable') return Promise.resolve({ data: USERS });
    if (url === '/api/teams/assignable') return Promise.resolve({ data: TEAMS });
    if (url === '/api/categories?active=1') return Promise.resolve({ data: CATEGORIES });
    return Promise.reject(new Error(`404 ${url}`));
  });
}

describe('TicketDetail', () => {
  it('muestra los datos del ticket tras la carga', async () => {
    renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });

    expect(await screen.findByText('PC no enciende')).toBeInTheDocument();
    // El número sale en la cabecera y también en la miga de pan, así que la
    // aserción se acota a la cabecera: es lo que comprueba esta prueba.
    const header = screen.getByRole('heading', { level: 1 }).closest('.card');
    expect(within(header).getByText('TCK-000001')).toBeInTheDocument();
    expect(screen.getByText('El equipo no enciende desde ayer por la tarde.')).toBeInTheDocument();
    expect(screen.getAllByText('Ana Díaz').length).toBeGreaterThan(0);
    expect(screen.getByText(/reportó/)).toBeInTheDocument();
    expect(screen.getByText('Revisando el problema…')).toBeInTheDocument();
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
    expect(screen.getByText('Cargando ticket…')).toBeInTheDocument();

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

    await pickField(user, 'Estado', 'En proceso');
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/tickets/1', { status: 'IN_PROGRESS' }));
  });

  it('actualiza la prioridad del ticket', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
    await screen.findByText('PC no enciende');

    await pickField(user, 'Prioridad', 'Baja');
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/tickets/1', { priority: 'LOW' }));
  });

  it('asigna el ticket a un usuario', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
    await screen.findByText('PC no enciende');

    await pickField(user, 'Asignado a', 'Juan Pérez');
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/tickets/1', { assigned_to_id: 5 }));
  });

  it('asigna el ticket a un equipo', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
    await screen.findByText('PC no enciende');

    await pickField(user, 'Equipo', 'Soporte');
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/tickets/1', { assigned_team_id: 3 }));
  });

  it('cambia la categoría del ticket', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
    await screen.findByText('PC no enciende');

    await pickField(user, 'Categoría', 'Software');
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/tickets/1', { category_id: 2 }));
  });

  it('solo muestra los selectores que el permiso permite', async () => {
    const user = userEvent.setup();
    // manage=false pero assign=true: el panel de gestión aparece, con
    // únicamente los dos selectores de asignación.
    api.get.mockImplementation((url) => {
      if (url === '/api/tickets/1')
        return Promise.resolve(
          detailData({ can: { comment: true, note: true, manage: false, resolve: false, close: false, cancel: false, reopen: false, assign: true } })
        );
      if (url === '/api/tickets/options') return Promise.resolve(OPTIONS);
      if (url === '/api/users/assignable') return Promise.resolve({ data: USERS });
      if (url === '/api/teams/assignable') return Promise.resolve({ data: TEAMS });
      if (url === '/api/categories?active=1') return Promise.resolve({ data: CATEGORIES });
      return Promise.reject(new Error(`404 ${url}`));
    });

    renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
    await screen.findByText('PC no enciende');

    expect(screen.getByLabelText('Asignado a')).toBeInTheDocument();
    expect(screen.getByLabelText('Equipo')).toBeInTheDocument();
    expect(screen.queryByLabelText('Estado')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Prioridad')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Categoría')).not.toBeInTheDocument();

    // Y los que sí se pintan siguen funcionando.
    await pickField(user, 'Equipo', 'Soporte');
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/tickets/1', { assigned_team_id: 3 }));
  });

  it('sin permiso de resolver, marcar resuelto va directo al PATCH', async () => {
    const user = userEvent.setup();
    api.get.mockImplementation((url) => {
      if (url === '/api/tickets/1')
        return Promise.resolve(
          detailData({ can: { comment: true, note: true, manage: true, resolve: false, close: false, cancel: false, reopen: false, assign: true } })
        );
      if (url === '/api/tickets/options') return Promise.resolve(OPTIONS);
      if (url === '/api/users/assignable') return Promise.resolve({ data: USERS });
      if (url === '/api/teams/assignable') return Promise.resolve({ data: TEAMS });
      if (url === '/api/categories?active=1') return Promise.resolve({ data: CATEGORIES });
      return Promise.reject(new Error(`404 ${url}`));
    });

    renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
    await screen.findByText('PC no enciende');

    await pickField(user, 'Estado', 'Resuelto');

    // Sin `resolve` no se abre el drawer de solución: se hace PATCH directo.
    expect(screen.queryByRole('dialog', { name: /Resolver/i })).not.toBeInTheDocument();
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/tickets/1', { status: 'RESOLVED' }));
  });

  it('con permiso de resolver, elegir "Resuelto" abre el drawer de solución', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
    await screen.findByText('PC no enciende');

    await pickField(user, 'Estado', 'Resuelto');

    expect(await screen.findByRole('dialog', { name: /Resol/i })).toBeInTheDocument();
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('deshabilita los selectores mientras guarda el cambio', async () => {
    const user = userEvent.setup();
    const original = api.patch.getMockImplementation();
    let finish;
    api.patch.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));

    renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
    await screen.findByText('PC no enciende');

    // Antes de guardar están activos.
    expect(fieldSelect('Estado')).toBeEnabled();

    await user.click(fieldSelect('Estado'));
    await user.click(screen.getByRole('option', { name: 'En proceso' }));

    await waitFor(() => expect(fieldSelect('Estado')).toBeDisabled());
    // El bloqueo se extiende a todos los selectores de gestión.
    expect(fieldSelect('Prioridad')).toBeDisabled();
    expect(fieldSelect('Asignado a')).toBeDisabled();
    expect(fieldSelect('Equipo')).toBeDisabled();
    expect(fieldSelect('Categoría')).toBeDisabled();

    await act(async () => { finish({ data: detailData() }); });
    await waitFor(() => expect(fieldSelect('Estado')).toBeEnabled());
    api.patch.mockImplementation(original);
  });

  it('resuelve el ticket desde el drawer y envía la solución', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
    await screen.findByText('PC no enciende');

    await user.click(screen.getByRole('button', { name: 'Resolver ticket' }));
    const drawer = await screen.findByRole('dialog', { name: 'Resolver ticket' });

    await user.type(within(drawer).getByLabelText(/Solución/), 'Se reemplazó la GPU');
    await user.click(within(drawer).getByRole('button', { name: 'Resolver ticket' }));

    await waitFor(() => {
      const calls = api.post.mock.calls.filter(([u]) => u === '/api/tickets/1/resolve');
      expect(calls).toHaveLength(1);
      const fd = calls[0][2];
      expect(fd.get('resolution')).toBe('Se reemplazó la GPU');
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

    await user.type(within(dialog).getByPlaceholderText('Comentario interno sobre el cierre…'), 'Todo verificado');
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

    await user.type(within(dialog).getByLabelText('Motivo de cancelación *'), 'El usuario ya no lo necesita');
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

    await user.type(within(drawer).getByPlaceholderText('Explique por qué el ticket debe reabrirse…'), 'El usuario volvió a reportar el fallo');
    await user.click(submit);

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/tickets/1/reopen', { reason: 'El usuario volvió a reportar el fallo' }));
  });

  // El selector de gestión se queda en lo que el backend admite: desde un
  // RESOLVED/CLOSED la vuelta a la cola es sólo por el flujo con motivo. La
  // protección real está en PATCH (routes/tickets.js); esto es coherencia de UX
  // para no ofrecer una opción que el servidor va a rechazar.
  describe('Selector de estado en estados terminales', () => {
    it.each(['RESOLVED', 'CLOSED'])('no ofrece reabrir un %s sin ticket.reopen', async (status) => {
      const user = userEvent.setup();
      mockDetail(detailWith(status, { reopen: false }));
      renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
      await screen.findByText('PC no enciende');

      // Sólo el estado actual: ni siquiera aparece "Abierto", así que no hay
      // forma de enviar la petición que el backend rechaza.
      expect(await offeredStatusOptions(user)).toEqual([status === 'RESOLVED' ? 'Resuelto' : 'Cerrado']);
      // Coherente con el botón de cabecera, que tampoco se pinta sin permiso.
      expect(screen.queryByRole('button', { name: 'Reabrir' })).not.toBeInTheDocument();
      // El control conserva su valor en vez de caer en el placeholder.
      expect(fieldSelect('Estado')).toHaveTextContent(status === 'RESOLVED' ? 'Resuelto' : 'Cerrado');
      expect(api.patch).not.toHaveBeenCalled();
    });

    it.each(['RESOLVED', 'CLOSED'])('mantiene la reapertura con motivo en un %s con ticket.reopen', async (status) => {
      const user = userEvent.setup();
      mockDetail(detailWith(status));
      renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
      await screen.findByText('PC no enciende');

      // `Select` conserva el orden de STATUSES, así que "Abierto" va primero.
      expect(await offeredStatusOptions(user)).toEqual([
        'Abierto',
        status === 'RESOLVED' ? 'Resuelto' : 'Cerrado',
      ]);

      await pickField(user, 'Estado', 'Abierto');
      const drawer = await screen.findByRole('dialog', { name: 'Reabrir ticket' });
      const submit = within(drawer).getByRole('button', { name: 'Reabrir' });
      expect(submit).toBeDisabled();

      await user.type(within(drawer).getByPlaceholderText('Explique por qué el ticket debe reabrirse…'), 'Sigue sin resolverse');
      await user.click(submit);

      await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/tickets/1/reopen', { reason: 'Sigue sin resolverse' }));
      // La reapertura nunca pasa por el PATCH genérico.
      expect(api.patch).not.toHaveBeenCalled();
    });

    it.each(['RESOLVED', 'CLOSED'])('no ofrece saltos directos a la cola desde un %s', async (status) => {
      const user = userEvent.setup();
      mockDetail(detailWith(status));
      renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
      await screen.findByText('PC no enciende');

      const options = await offeredStatusOptions(user);
      // Ni con permiso de reapertura el selector permite devolver el ticket a
      // la cola sin pasar por el modal con motivo.
      expect(options).not.toContain('Asignado');
      expect(options).not.toContain('En proceso');
      expect(options).not.toContain('Pendiente');
      expect(api.patch).not.toHaveBeenCalled();
    });

    it('mantiene CANCELLED como estaba: el selector no se toca', async () => {
      const user = userEvent.setup();
      mockDetail(detailWith('CANCELLED'));
      renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
      await screen.findByText('PC no enciende');

      // CANCELLED no es reabrible: su regla es "no se cambia de estado" y la
      // gestiona el backend con su propio mensaje. Por eso aquí no se filtra
      // nada y el desplegable sigue mostrando los siete estados.
      expect(await offeredStatusOptions(user)).toEqual([
        'Abierto',
        'Asignado',
        'En proceso',
        'Pendiente',
        'Resuelto',
        'Cerrado',
        'Cancelado',
      ]);
      expect(api.patch).not.toHaveBeenCalled();
    });
  });

  it('marca el ticket como pendiente desde el selector de estado', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
    await screen.findByText('PC no enciende');

    await pickField(user, 'Estado', 'Pendiente');
    const drawer = await screen.findByRole('dialog', { name: 'Marcar como pendiente' });

    // El motivo vive en el drawer, pero su menú se portaliza a `document.body`.
    await user.click(within(drawer).getByLabelText('Motivo'));
    await user.click(screen.getByRole('option', { name: 'Esperando cliente' }));
    await user.click(within(drawer).getByRole('button', { name: 'Marcar pendiente' }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/tickets/1', { status: 'PENDING', pending_reason: 'Esperando cliente' }));
  });

  it('envía un comentario público', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
    await screen.findByText('PC no enciende');

    await user.type(screen.getByPlaceholderText('Escriba una respuesta para el empleado…'), 'Ya estamos trabajando en ello');
    await user.click(screen.getByRole('button', { name: 'Enviar respuesta' }));

    await waitFor(() => {
      const calls = api.post.mock.calls.filter(([u]) => u === '/api/tickets/1/comments');
      expect(calls).toHaveLength(1);
      const fd = calls[0][2];
      expect(fd.get('message')).toBe('Ya estamos trabajando en ello');
    });
    await waitFor(() => expect(screen.getByPlaceholderText('Escriba una respuesta para el empleado…')).toHaveValue(''));
  });

  describe('legibilidad del editor', () => {    // La paleta de index.css está invertida para el tema oscuro: slate-50..300
    // son superficies oscuras y slate-400..950 textos claros. El editor usaba
    // text-slate-100, que resuelve a un azul marino (#0C3347) sobre un fondo
    // #0b3046: ratio ~1:1 y el texto escrito era invisible. Estos tests leen las
    // clases reales del DOM, así que vuelven a fallar si alguien reintroduce un
    // token oscuro sobre una superficie oscura.

    async function renderEditor() {
      renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
      await screen.findByText('PC no enciende');
      return screen.getByPlaceholderText('Escriba una respuesta para el empleado…');
    }

    it('el texto que se escribe es legible sobre el fondo del editor', async () => {
      const textarea = await renderEditor();
      expect(expectContrast(textarea, { surface: EDITOR_SURFACE, label: 'texto del editor' })).toBeGreaterThanOrEqual(4.5);
    });

    it('el placeholder es legible sobre el fondo del editor', async () => {
      const textarea = await renderEditor();
      expect(expectPlaceholderContrast(textarea, { surface: EDITOR_SURFACE, label: 'placeholder del editor' })).toBeGreaterThanOrEqual(3);
    });

    it('el cursor de escritura se ve sobre el fondo del editor', async () => {
      // El caret hereda el color del texto: si el texto es invisible, el cursor
      // tampoco se distingue y el campo parece deshabilitado.
      const textarea = await renderEditor();
      const { text } = readColors(textarea.className);
      const visible = contrastRatio(resolveColor(text, EDITOR_SURFACE), EDITOR_SURFACE) >= 4.5;
      expect(visible, `el caret hereda ${text}; si no se ve, el campo parece deshabilitado`).toBe(true);
    });

    it('los botones de formato son legibles sobre la barra', async () => {
      await renderEditor();
      for (const label of ['Negrita', 'Cursiva', 'Lista', 'Código']) {
        const button = screen.getByRole('button', { name: label });
        expect(expectContrast(button, { surface: TOOLBAR_SURFACE, label: `botón ${label}` })).toBeGreaterThanOrEqual(4.5);
      }
    });

    it('el botón de formato explica su función con tooltip y sigue aplicando el formato', async () => {
      const user = userEvent.setup();
      const textarea = await renderEditor();
      const negrita = screen.getByRole('button', { name: 'Negrita' });

      // Sin `title` nativo: no aparece al navegar con teclado ni se adapta al
      // tema oscuro. El nombre accesible no cambia.
      expect(negrita).not.toHaveAttribute('title');
      await user.hover(negrita);
      expect(await screen.findByRole('tooltip')).toHaveTextContent('Negrita');

      // El tooltip no se come el clic: el botón sigue aplicando markdown.
      await user.click(negrita);
      expect(textarea.value).toContain('**');
    });

    it('el tooltip del botón de formato también sale con el teclado', async () => {
      const user = userEvent.setup();
      await renderEditor();
      const negrita = screen.getByRole('button', { name: 'Negrita' });

      negrita.focus();
      expect(await screen.findByRole('tooltip')).toHaveTextContent('Negrita');
      // Se cierra al tabular, sin comerse el foco.
      await user.tab();
      await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
    });

    it('el botón de respuestas rápidas es legible y se distingue de la barra', async () => {
      await renderEditor();
      const trigger = screen.getByRole('button', { name: /Respuestas rápidas/ });
      expect(expectContrast(trigger, { surface: TOOLBAR_SURFACE, label: 'botón de respuestas rápidas' })).toBeGreaterThanOrEqual(4.5);

      // Su fondo es un blanco translúcido sobre la barra: el color compuesto
      // tiene que seguir dejando el texto por encima de AA.
      const { text, bg } = readColors(trigger.className);
      expect(bg, 'el botón debe declarar su propio fondo').toBeTruthy();
      const own = resolveColor(bg, TOOLBAR_SURFACE);
      expect(contrastRatio(resolveColor(text, own), own)).toBeGreaterThanOrEqual(4.5);
    });
  });

  it('envía una nota interna marcada como interna', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
    await screen.findByText('PC no enciende');

    const editorCard = screen.getByPlaceholderText('Escriba una respuesta para el empleado…').closest('.card');
    await user.click(within(editorCard).getByRole('button', { name: /Nota interna/ }));

    const internalArea = await screen.findByPlaceholderText('Escriba una nota interna (no visible para el empleado)…');
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
    expect(screen.getByRole('link', { name: /log\.txt/ })).toBeInTheDocument();
    expect(screen.getByText('512 B')).toBeInTheDocument();
  });

  it('se conecta al stream SSE del ticket en vivo y recibe comentarios', async () => {
    renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
    await screen.findByText('PC no enciende');

    expect(es).toBeDefined();
    expect(es.url).toBe('/api/tickets/1/stream');
    expect(screen.getByText('Sin conexión')).toBeInTheDocument();

    es.emit('ready');
    await waitFor(() => expect(screen.getByText('En vivo')).toBeInTheDocument());

    es.emit('comment', {
      comment: { id: 99, user_id: 3, user_name: 'Carlos Ruiz', message: 'Comentario en vivo por SSE', is_internal: false, created_at: '2026-09-22T10:00:00Z' },
      attachments: [],
    });
    expect(await screen.findByText('Comentario en vivo por SSE')).toBeInTheDocument();
  });

  it('muestra al usuario que está escribiendo y refresca por SSE', async () => {
    renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
    await screen.findByText('PC no enciende');

    const detailCalls = () => api.get.mock.calls.filter(([u]) => u === '/api/tickets/1').length;
    const before = detailCalls();

    es.emit('typing', { user_id: 7, user_name: 'Lucía' });
    await waitFor(() => expect(screen.getByText('Lucía está escribiendo…')).toBeInTheDocument());

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

  it('oculta acciones y muestra solo lectura sin permisos de gestión', async () => {
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

  it('muestra y envía la encuesta CSAT al reporter', async () => {
    const user = userEvent.setup();
    authState.user = { id: 2, name: 'Ana Díaz' };
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

    expect(screen.getByText('¿Cómo fue la atención recibida?')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '4 estrellas' }));
    await user.type(screen.getByPlaceholderText('Comentario (opcional)…'), 'Muy satisfecho');
    await user.click(screen.getByRole('button', { name: 'Enviar calificación' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/tickets/1/csat', { rating: 4, comment: 'Muy satisfecho' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '¡Gracias!' })).toBeInTheDocument());
  });

  it('muestra la calificación CSAT ya respondida', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/api/tickets/1') return Promise.resolve(detailData({}, { status: 'CLOSED', csat_answered_at: '2026-09-25T08:00:00Z', csat_rating: 5, csat_comment: 'Excelente atención' }));
      if (url === '/api/tickets/options') return Promise.resolve(OPTIONS);
      if (url === '/api/users/assignable') return Promise.resolve({ data: USERS });
      if (url === '/api/teams/assignable') return Promise.resolve({ data: TEAMS });
      if (url === '/api/categories?active=1') return Promise.resolve({ data: CATEGORIES });
      return Promise.reject(new Error(`404 ${url}`));
    });

    renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
    await screen.findByText('PC no enciende');

    expect(screen.getByText('Satisfacción del usuario:')).toBeInTheDocument();
    expect(screen.getByText(/Excelente atención/)).toBeInTheDocument();
  });

  describe('legibilidad de la barra de acciones', () => {
    // .btn-secondary pinta su fondo con un 6 % de blanco sobre el navy de la
    // página (#061b2c). El botón de cancelar usaba `!text-red-600`, y como el
    // tema solo reescribe el token `text-red-600` SIN `!`, el texto se quedaba
    // en el rojo estándar (#dc2626): 2,7:1 sobre esa superficie, por debajo de AA.
    const CANCEL_SURFACE = composite('#ffffff', 6, '#061b2c');

    it('el botón de cancelar es legible sobre la barra de acciones', async () => {
      renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
      await screen.findByText('PC no enciende');

      const boton = screen.getByRole('button', { name: 'Cancelar ticket' });
      expect(expectContrast(boton, { surface: CANCEL_SURFACE, label: 'botón Cancelar ticket' })).toBeGreaterThanOrEqual(4.5);
    });
  });

  describe('cabecera y panel lateral', () => {
    function mockDetalle(ticketOverrides = {}, extra = {}) {
      api.get.mockImplementation((url) => {
        if (url === '/api/tickets/1') return Promise.resolve(detailData(extra, ticketOverrides));
        if (url === '/api/tickets/options') return Promise.resolve(OPTIONS);
        if (url === '/api/users/assignable') return Promise.resolve({ data: USERS });
        if (url === '/api/teams/assignable') return Promise.resolve({ data: TEAMS });
        if (url === '/api/categories?active=1') return Promise.resolve({ data: CATEGORIES });
        return Promise.reject(new Error(`404 ${url}`));
      });
    }

    it('muestra en la cabecera a quién está asignado el ticket', async () => {
      mockDetalle({ assigned_to_id: 5, assigned_name: 'Juan Pérez', assigned_team_id: 3, team_name: 'Soporte' });

      renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
      await screen.findByText('PC no enciende');

      // La asignación decide a qué cola responde el ticket: se lee sin
      // desplazar hasta el panel lateral.
      const cabecera = screen.getByText('Asignación').closest('.card');
      expect(within(cabecera).getByText('Juan Pérez')).toBeInTheDocument();
      expect(within(cabecera).getByText('Soporte')).toBeInTheDocument();
    });

    it('advierte cuando el ticket todavía no tiene responsable', async () => {
      renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
      await screen.findByText('PC no enciende');

      const cabecera = screen.getByText('Asignación').closest('.card');
      expect(within(cabecera).getByText('Sin asignar')).toBeInTheDocument();
    });

    it('no repite en el panel lateral los datos que ya muestra la cabecera', async () => {
      mockDetalle({ reporter_email: 'ana.diaz@uce.edu.ec' }, {
        can: { comment: false, note: false, manage: false, resolve: false, close: false, cancel: false, reopen: false, assign: false },
      });

      renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
      await screen.findByText('PC no enciende');

      // Sin permisos de gestión no hay nada que editar: la tarjeta entera sobra.
      expect(screen.queryByText('Gestión')).not.toBeInTheDocument();

      // Reportante, departamento y fechas ya están en la cabecera; el panel
      // conserva solo lo que allí no cabe.
      const detalles = screen.getByText('Detalles').closest('.card');
      expect(within(detalles).queryByText('Empleado')).not.toBeInTheDocument();
      expect(within(detalles).queryByText('Departamento')).not.toBeInTheDocument();
      expect(within(detalles).queryByText('Creado')).not.toBeInTheDocument();
      expect(within(detalles).getByText('ana.diaz@uce.edu.ec')).toBeInTheDocument();
    });

    it('desglosa los adjuntos entre la descripción y la conversación', async () => {
      mockDetalle({}, {
        attachments: [
          { id: 10, comment_id: null, original_name: 'foto.png', mime_type: 'image/png', size_bytes: 2048 },
          { id: 11, comment_id: 1, original_name: 'log.txt', mime_type: 'text/plain', size_bytes: 512 },
        ],
      });

      renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
      await screen.findByText('PC no enciende');

      // Un total único no correspondía con lo que hay a la vista en pantalla.
      expect(screen.getByText('1 en la descripción · 1 en la conversación')).toBeInTheDocument();
    });

    it('indica que no hay archivos adjuntos', async () => {
      renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
      await screen.findByText('PC no enciende');

      expect(screen.getByText('Sin archivos')).toBeInTheDocument();
    });

    it('cuenta los mensajes de la conversación', async () => {
      renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
      await screen.findByText('PC no enciende');

      expect(screen.getByText('1 mensaje')).toBeInTheDocument();
    });

    it('avisa cuando el ticket se creó sin descripción', async () => {
      mockDetalle({ description: '   ' });

      renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
      expect(await screen.findByText('El ticket se creó sin descripción.')).toBeInTheDocument();
    });

    it('muestra el motivo por el que se canceló el ticket', async () => {
      mockDetalle({ status: 'CANCELLED', cancel_reason: 'El equipo ya fue reemplazado', cancelled_at: '2026-09-22T12:00:00Z' });

      renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
      await screen.findByText('PC no enciende');

      // El motivo se exige al cancelar, pero no se mostraba en ninguna parte.
      expect(screen.getByText('Cancelación')).toBeInTheDocument();
      expect(screen.getByText('El equipo ya fue reemplazado')).toBeInTheDocument();
    });

    it('motivo de espera visible en su propia tarjeta', async () => {
      mockDetalle({ status: 'PENDING', pending_reason: 'Esperando repuesto del proveedor' });

      renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });
      await screen.findByText('PC no enciende');

      const motivo = screen.getByText('Motivo de espera').closest('.card');
      expect(within(motivo).getByText('Esperando repuesto del proveedor')).toBeInTheDocument();
    });
  });

  describe('artículos de conocimiento', () => {
    const KB_ARTICLE = {
      id: 5,
      title: 'Recrear el perfil de Outlook',
      category_name: 'Correo',
      view_count: 12,
      status: 'PUBLISHED',
    };

    function mockWithArticles(extra = {}) {
      api.get.mockImplementation((url) => {
        if (url === '/api/tickets/1') return Promise.resolve(detailData({}, extra));
        if (url === '/api/tickets/1/articles') {
          return Promise.resolve({ data: [KB_ARTICLE], total: 1 });
        }
        if (url === '/api/tickets/options') return Promise.resolve(OPTIONS);
        if (url === '/api/users/assignable') return Promise.resolve({ data: USERS });
        if (url === '/api/teams/assignable') return Promise.resolve({ data: TEAMS });
        if (url === '/api/categories?active=1') return Promise.resolve({ data: CATEGORIES });
        return Promise.reject(new Error(`404 ${url}`));
      });
    }

    it('muestra la sección y carga los artículos cuando tiene kb.view', async () => {
      authState.user = { ...USER_TECH, permissions: ['ticket.view.all', 'kb.view'] };
      mockWithArticles();

      renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });

      expect(await screen.findByText('Recrear el perfil de Outlook')).toBeInTheDocument();
      expect(screen.getByText('Base de conocimiento')).toBeInTheDocument();
      expect(api.get).toHaveBeenCalledWith('/api/tickets/1/articles');
    });

    it('no carga ni muestra nada de conocimientos sin kb.view', async () => {
      authState.user = { ...USER_TECH, permissions: ['ticket.view.all'] };
      mockWithArticles();

      renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });

      await screen.findByText('PC no enciende');
      expect(screen.queryByText('Base de conocimiento')).not.toBeInTheDocument();
      expect(api.get).not.toHaveBeenCalledWith('/api/tickets/1/articles');
    });

    it('con kb.create ofrece vincular y crear borrador en un ticket resuelto', async () => {
      authState.user = { ...USER_TECH, permissions: ['ticket.view.all', 'kb.view', 'kb.create'] };
      mockWithArticles({ status: 'RESOLVED' });

      renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });

      expect(await screen.findByRole('button', { name: 'Vincular artículo' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Crear borrador desde el ticket/ })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Desvincular' })).toBeInTheDocument();
    });

    it('no ofrece crear borrador si el ticket sigue abierto', async () => {
      authState.user = { ...USER_TECH, permissions: ['ticket.view.all', 'kb.view', 'kb.create'] };
      mockWithArticles();

      renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });

      expect(await screen.findByRole('button', { name: 'Vincular artículo' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Crear borrador desde el ticket/ })).not.toBeInTheDocument();
    });
  });
});

// Miga de pan de la ficha. Su destino se deduce de la ruta en la que ya está la
// pantalla (`/app/tickets/:id` o `/app/my-tickets/:id`) y del permiso
// `ticket.view.all` que protege el listado general en App.jsx; no depende del
// historial del navegador, así que el enlace es un `href` real.
describe('TicketDetail · miga de pan', () => {
  const TECNICO = { ...USER_TECH, permissions: ['ticket.view.all'] };
  // Rol Empleado del seed: ve sus tickets, no el listado general.
  const EMPLEADO = { id: 9, name: 'Empleado', permissions: ['ticket.create', 'ticket.view.own'] };

  async function renderDetail({ route, path, user }) {
    authState.user = user;
    renderWithHistory(<TicketDetail />, { route, path });
    return screen.findByText('PC no enciende');
  }

  function crumbNav() {
    return screen.getByRole('navigation', { name: 'Ruta de navegación' });
  }

  it('muestra el listado del que se viene y el ticket como paso actual', async () => {
    await renderDetail({ route: '/app/tickets/1', path: '/app/tickets/:id', user: TECNICO });

    const nav = crumbNav();
    // `Tickets` e `Inbox` llevan a `/app/tickets/:id`: la vuelta predecible es
    // el listado general.
    const root = within(nav).getByRole('link', { name: 'Tickets' });
    expect(root).toHaveAttribute('href', '/app/tickets');

    // El paso actual no es un enlace: un enlace a la propia página no lleva a
    // ninguna parte y añadiría un tabulador sin acción.
    const current = within(nav).getByText('TCK-000001');
    expect(current).toHaveAttribute('aria-current', 'page');
    expect(within(nav).queryByRole('link', { name: 'TCK-000001' })).not.toBeInTheDocument();
    expect(within(nav).getAllByRole('listitem')).toHaveLength(2);
  });

  it('desde Mis tickets vuelve a ese listado y no al general', async () => {
    await renderDetail({ route: '/app/my-tickets/1', path: '/app/my-tickets/:id', user: TECNICO });

    const nav = crumbNav();
    expect(within(nav).getByRole('link', { name: 'Mis tickets' })).toHaveAttribute('href', '/app/my-tickets');
    // Ni "Tickets" ni la bandeja: quien llegó desde "Mis tickets" no debe
    // aparecer de pronto en otro listado.
    expect(within(nav).queryByRole('link', { name: 'Tickets' })).not.toBeInTheDocument();
  });

  it('sin permiso para el listado general vuelve a Mis tickets, no a una ruta imposible', async () => {
    // `/app/tickets` está protegida por `ticket.view.all`: para un empleado,
    // enlazarla sería mandar a `/app`, que no es volver a ningún sitio.
    await renderDetail({ route: '/app/tickets/1', path: '/app/tickets/:id', user: EMPLEADO });

    const nav = crumbNav();
    expect(within(nav).getByRole('link', { name: 'Mis tickets' })).toHaveAttribute('href', '/app/my-tickets');
    expect(within(nav).queryByRole('link', { name: 'Tickets' })).not.toBeInTheDocument();
  });

  it('el salto es un enlace de verdad y navega al listado', async () => {
    // No es `history.back()`: el destino se puede abrir en pestaña nueva y es el
    // mismo aunque el usuario haya entrado desde otro sitio.
    authState.user = TECNICO;
    const { history } = renderWithHistory(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });

    await screen.findByText('PC no enciende');
    await userEvent.setup().click(screen.getByRole('link', { name: 'Tickets' }));

    expect(history.location.pathname).toBe('/app/tickets');
  });

  it('mantiene el botón "Volver" del historial junto a la miga', async () => {
    await renderDetail({ route: '/app/tickets/1', path: '/app/tickets/:id', user: TECNICO });

    // El botón de siempre no se sustituye: es la vuelta exacta, con los filtros
    // con los que se llegó (por eso la bandeja no se distingue en la miga).
    expect(screen.getByRole('button', { name: /Volver/ })).toBeInTheDocument();
  });

  it('no pinta la miga mientras el ticket no ha cargado', () => {
    api.get.mockImplementation((url) => {
      if (url === '/api/tickets/1') return new Promise(() => {});
      if (url === '/api/tickets/options') return Promise.resolve(OPTIONS);
      return Promise.reject(new Error(`404 ${url}`));
    });
    authState.user = TECNICO;

    renderWithProviders(<TicketDetail />, { route: '/app/tickets/1', path: '/app/tickets/:id' });

    // Sin el número del ticket el último paso no tendría qué poner, así que la
    // miga espera a los datos en vez de enseñarse a medias.
    expect(screen.queryByRole('navigation', { name: 'Ruta de navegación' })).not.toBeInTheDocument();
    expect(screen.getByText('Cargando ticket…')).toBeInTheDocument();
  });
});