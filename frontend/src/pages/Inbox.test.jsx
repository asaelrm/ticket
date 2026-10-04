import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Inbox from './Inbox';
import { api } from '../lib/api';
import { BAR_HEIGHT } from '../components/BulkTicketBar';
import { renderWithProviders, renderWithHistory, pickOption } from '../test/utils';

const { authState } = vi.hoisted(() => ({
  authState: { user: null },
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
  };
});

const COUNTERS = {
  open: 1,
  pending: 1,
  attended: 2,
  in_progress: 1,
  overdue: 1,
  assigned_to_me: 2,
  assigned_to_my_teams: 4,
  unassigned: 1,
  closed: { month: 5 },
  mine_active: 2,
  critical: 0,
  on_hold: 1,
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

const ADMIN = { id: 7, name: 'Admin', department_id: 3, permissions: ['ticket.assign', 'ticket.update.any'] };
// Técnico del seed: tiene ticket.assign/update.any/resolve/close.
const FULL = {
  id: 7,
  name: 'Admin',
  department_id: 3,
  permissions: ['ticket.assign', 'ticket.update.any', 'ticket.resolve', 'ticket.close'],
};

beforeEach(() => {
  vi.clearAllMocks();
  // Cada test declara sus propias respuestas, así que la implementación del
  // mock se reinicia junto con las llamadas. Sin esto, una respuesta pendiente
  // de un test (por ejemplo un PATCH en vuelo) se filtra al test siguiente y la
  // suite falla según el orden de ejecución.
  api.get.mockReset();
  api.post.mockReset();
  api.put.mockReset();
  api.patch.mockReset();
  api.del.mockReset();
  authState.user = ADMIN;
  api.get.mockImplementation((url) => {
    if (url.startsWith('/api/tickets/counters')) return Promise.resolve(COUNTERS);
    if (url.startsWith('/api/tickets?')) return Promise.resolve(listResp());
    if (url.startsWith('/api/categories')) return Promise.resolve({ data: [{ id: 1, name: 'Hardware' }] });
    if (url.startsWith('/api/users/assignable')) return Promise.resolve({ data: [{ id: 9, name: 'Beto', last_name: 'Gómez', department_name: 'TI' }] });
    return Promise.reject(new Error(`404 ${url}`));
  });
});

describe('Inbox', () => {
it('renderiza las pestañas y el listado recibido', async () => {
    renderWithProviders(<Inbox />, { route: '/app/inbox' });

    expect(await screen.findByText('TCK-000001')).toBeInTheDocument();
    expect(screen.getByText('PC no enciende')).toBeInTheDocument();

    // Las pestañas y el resumen comparten textos ("Sin asignar"), así que las
    // pruebas los localizan por su grupo y no por el texto suelto.
    const tabs = within(screen.getByRole('group', { name: 'Vistas de la bandeja' }));
    expect(tabs.getByText('Asignados a mí')).toBeInTheDocument();
    expect(tabs.getByText('Mi equipo')).toBeInTheDocument();
    expect(tabs.getByText('Abiertos')).toBeInTheDocument();
    expect(tabs.getByText('Sin asignar')).toBeInTheDocument();

    const resumen = within(screen.getByRole('group', { name: 'Resumen de la bandeja' }));
    expect(resumen.getByText('Mis activos')).toBeInTheDocument();
    expect(resumen.getByText('Fuera de plazo')).toBeInTheDocument();
    expect(resumen.getByText('Críticos')).toBeInTheDocument();
    expect(resumen.getByText('En espera')).toBeInTheDocument();

    expect(api.get).toHaveBeenCalledWith(expect.stringContaining('view=mine'));
  });

  it('muestra estado de carga mientras la API responde', async () => {
    let resolveList;
    api.get.mockImplementation((url) => {
      if (url.startsWith('/api/tickets/counters')) return Promise.resolve(COUNTERS);
      if (url.startsWith('/api/tickets?')) return new Promise((r) => { resolveList = r; });
      if (url.startsWith('/api/categories')) return Promise.resolve({ data: [{ id: 1, name: 'Hardware' }] });
      return Promise.reject(new Error('404'));
    });

    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    expect(screen.getAllByText('Cargando…').length).toBeGreaterThan(0);

    await act(async () => {
      resolveList(listResp());
    });
    expect(await screen.findByText('TCK-000001')).toBeInTheDocument();
  });

  it('muestra contadores en las pestañas', async () => {
    renderWithProviders(<Inbox />, { route: '/app/inbox' });

    const mineTab = await screen.findByRole('button', { name: /Asignados a mí/ });
    expect(await within(mineTab).findByText('2')).toBeInTheDocument();
    expect(await within(screen.getByRole('button', { name: /Mi equipo/ })).findByText('4')).toBeInTheDocument();
  });

  it('cambia de pestaña y consulta la vista "open"', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByRole('button', { name: /^Abiertos/ }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('view=open')));
  });

  it('aplica el filtro de estado a la consulta', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByLabelText('Estado'));
    await user.click(screen.getByRole('option', { name: 'Abierto' }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('status=OPEN')));
  });

  it('aplica el filtro de prioridad a la consulta', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByLabelText('Prioridad'));
    await user.click(screen.getByRole('option', { name: 'Crítica' }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('priority=CRITICAL')));
  });

  it('envía el id de categoría como texto, igual que el select nativo', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByLabelText('Categoría'));
    await user.click(screen.getByRole('option', { name: 'Hardware' }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('category=1')));
  });

  it('cambia el orden y deja de enviar el valor por defecto', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    // El valor por defecto no viaja en la URL; al cambiarlo, sí.
    expect(api.get).toHaveBeenCalledWith(expect.not.stringContaining('sort='));

    await user.click(screen.getByLabelText('Ordenar por'));
    await user.click(screen.getByRole('option', { name: 'Última actualización' }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('sort=updated_at')));
  });

  it('mantiene la etiqueta asociada a cada filtro', async () => {
    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    expect(screen.getByLabelText('Estado')).toHaveAttribute('id', 'inbox-status');
    expect(screen.getByLabelText('Prioridad')).toHaveAttribute('id', 'inbox-priority');
    expect(screen.getByLabelText('Categoría')).toHaveAttribute('id', 'inbox-category');
    expect(screen.getByLabelText('Ordenar por')).toHaveAttribute('id', 'inbox-sort');
  });


  it('cambia el estado del ticket e invalida el listado', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    const ticketCalls = () => api.get.mock.calls.filter(([u]) => u.startsWith('/api/tickets?')).length;
    const before = ticketCalls();

    await user.click(screen.getByRole('button', { name: '⋯' }));
    await user.click(await screen.findByRole('menuitem', { name: /Marcar en proceso/ }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/tickets/1', { status: 'IN_PROGRESS' }));
    await waitFor(() => expect(ticketCalls()).toBeGreaterThan(before));
  });

it('toma un ticket sin asignar con la acción rápida de la fila', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByRole('button', { name: 'Tomar ticket TCK-000001' }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/tickets/1', { assigned_to_id: 7 }));
  });

  it('confirma con un aviso accesible que el ticket se tomó', async () => {
    const user = userEvent.setup();
    api.patch.mockResolvedValue({ data: row({ assigned_to_id: 7 }) });
    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByRole('button', { name: 'Tomar ticket TCK-000001' }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('TCK-000001');
  });

  it('no duplica el PATCH si se pulsa dos veces "Tomar ticket"', async () => {
    const user = userEvent.setup();
    let releasePatch;
    api.patch.mockImplementation(() => new Promise((r) => { releasePatch = () => r({ data: row() }); }));
    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    const take = screen.getByRole('button', { name: 'Tomar ticket TCK-000001' });
    await user.click(take);
    // La segunda pulsación llega con el estado ya deshabilitado, que es
    // justamente lo que el primer clic dejó puesto.
    await user.click(take);

    expect(api.patch).toHaveBeenCalledTimes(1);

    await act(async () => { releasePatch(); });
    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
  });

  it('oculta "Tomar ticket" si el usuario no puede asignar', async () => {
    authState.user = { id: 7, name: 'Empleado', permissions: [] };
    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    expect(screen.queryByRole('button', { name: 'Tomar ticket TCK-000001' })).not.toBeInTheDocument();
  });

  it('ofrece "Asignarme a mí" en el menú cuando el ticket ya tiene técnico', async () => {
    const user = userEvent.setup();
    api.get.mockImplementation((url) => {
      if (url.startsWith('/api/tickets/counters')) return Promise.resolve(COUNTERS);
      if (url.startsWith('/api/tickets?')) {
        return Promise.resolve(listResp([row({ assigned_to_id: 9, assigned_to_name: 'Beto Gómez' })]));
      }
      if (url.startsWith('/api/categories')) return Promise.resolve({ data: [{ id: 1, name: 'Hardware' }] });
      if (url.startsWith('/api/users/assignable')) return Promise.resolve({ data: [{ id: 9, name: 'Beto', last_name: 'Gómez', department_name: 'TI' }] });
      return Promise.reject(new Error(`404 ${url}`));
    });

    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByRole('button', { name: '⋯' }));
    await user.click(await screen.findByRole('menuitem', { name: /Asignarme a mí/ }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/tickets/1', { assigned_to_id: 7 }));
  });

  it('asigna en lote los tickets seleccionados', async () => {
    const user = userEvent.setup();
    api.get.mockImplementation((url) => {
      if (url.startsWith('/api/tickets/counters')) return Promise.resolve(COUNTERS);
      if (url.startsWith('/api/tickets?')) {
        return Promise.resolve(
          listResp([row(), row({ id: 2, ticket_number: 'TCK-000002', title: 'Impresora atascada' })])
        );
      }
      if (url.startsWith('/api/categories')) return Promise.resolve({ data: [{ id: 1, name: 'Hardware' }] });
      return Promise.reject(new Error('404'));
    });

    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByLabelText('Seleccionar todos los de la página'));
    await user.click(await screen.findByRole('button', { name: /^Asignarme$/ }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/tickets/1', { assigned_to_id: 7 }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/tickets/2', { assigned_to_id: 7 }));
    expect(screen.queryByText(/2 seleccionado\(s\)/)).not.toBeInTheDocument();
  });
});

// El backend rechaza PATCH con RESOLVED/CLOSED (tickets.js:861) y exige los
// endpoints dedicados. Estos tests fijan ese contrato para las acciones masivas
// y para el menú de fila, que comparten la misma mutación.
describe('Inbox · acciones de estado con los endpoints dedicados', () => {
  function twoRows() {
    api.get.mockImplementation((url) => {
      if (url.startsWith('/api/tickets/counters')) return Promise.resolve(COUNTERS);
      if (url.startsWith('/api/tickets?')) {
        return Promise.resolve(
          listResp([row(), row({ id: 2, ticket_number: 'TCK-000002', title: 'Impresora atascada' })])
        );
      }
      if (url.startsWith('/api/categories')) return Promise.resolve({ data: [{ id: 1, name: 'Hardware' }] });
      return Promise.reject(new Error('404'));
    });
  }

  it('resuelve en lote con POST /resolve y el campo solución obligatorio', async () => {
    const user = userEvent.setup();
    authState.user = FULL;
    twoRows();

    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByLabelText('Seleccionar todos los de la página'));
    await user.click(await screen.findByRole('button', { name: /^Resuelto$/ }));

    // La caja pide la solución antes de tocar el backend.
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText(/Solución \/ trabajo realizado/)).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText(/Solución \/ trabajo realizado/), 'Se cambió la fuente de poder');
    await user.click(within(dialog).getByRole('button', { name: 'Resolver 2 ticket(s)' }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/api/tickets/1/resolve', { resolution: 'Se cambió la fuente de poder' })
    );
    expect(api.post).toHaveBeenCalledWith('/api/tickets/2/resolve', { resolution: 'Se cambió la fuente de poder' });
    // Nunca debe caer en el PATCH genérico que el backend rechaza.
    expect(api.patch).not.toHaveBeenCalledWith('/api/tickets/1', { status: 'RESOLVED' });
    expect(api.patch).not.toHaveBeenCalledWith('/api/tickets/2', { status: 'RESOLVED' });
  });

  it('no envía nada si la solución está vacía', async () => {
    const user = userEvent.setup();
    authState.user = FULL;
    twoRows();

    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');
    await user.click(screen.getByLabelText('Seleccionar todos los de la página'));
    await user.click(await screen.findByRole('button', { name: /^Resuelto$/ }));

    expect(await screen.findByRole('button', { name: 'Resolver 2 ticket(s)' })).toBeDisabled();
    expect(api.post).not.toHaveBeenCalled();
  });
  it('cierra en lote con POST /close y no con PATCH', async () => {
    const user = userEvent.setup();
    authState.user = FULL;
    twoRows();

    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');
    await user.click(screen.getByLabelText('Seleccionar todos los de la página'));
    await user.click(await screen.findByRole('button', { name: /^Cerrar$/ }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/tickets/1/close', {}));
    expect(api.post).toHaveBeenCalledWith('/api/tickets/2/close', {});
    expect(api.patch).not.toHaveBeenCalledWith('/api/tickets/1', { status: 'CLOSED' });
  });

  it('sólo modifica los tickets seleccionados', async () => {
    const user = userEvent.setup();
    authState.user = FULL;
    api.get.mockImplementation((url) => {
      if (url.startsWith('/api/tickets/counters')) return Promise.resolve(COUNTERS);
      if (url.startsWith('/api/tickets?')) {
        return Promise.resolve(
          listResp([
            row(),
            row({ id: 2, ticket_number: 'TCK-000002', title: 'Impresora atascada' }),
            row({ id: 3, ticket_number: 'TCK-000003', title: 'WiFi intermitente' }),
          ])
        );
      }
      if (url.startsWith('/api/categories')) return Promise.resolve({ data: [{ id: 1, name: 'Hardware' }] });
      return Promise.reject(new Error('404'));
    });

    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByLabelText('Seleccionar TCK-000001'));
    await user.click(screen.getByLabelText('Seleccionar TCK-000002'));
    expect(screen.getByText('2 seleccionado(s)')).toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: /^Cerrar$/ }));

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(api.post).toHaveBeenCalledWith('/api/tickets/1/close', {});
    expect(api.post).toHaveBeenCalledWith('/api/tickets/2/close', {});
    expect(api.post).not.toHaveBeenCalledWith('/api/tickets/3/close', {});
  });

  it('refresca el listado y los contadores tras el lote', async () => {
    const user = userEvent.setup();
    authState.user = FULL;
    twoRows();

    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    const listCalls = () => api.get.mock.calls.filter(([u]) => u.startsWith('/api/tickets?')).length;
    const counterCalls = () => api.get.mock.calls.filter(([u]) => u.startsWith('/api/tickets/counters')).length;
    const beforeList = listCalls();
    const beforeCounters = counterCalls();

    await user.click(screen.getByLabelText('Seleccionar todos los de la página'));
    await user.click(await screen.findByRole('button', { name: /^Cerrar$/ }));

    await waitFor(() => expect(listCalls()).toBeGreaterThan(beforeList));
    await waitFor(() => expect(counterCalls()).toBeGreaterThan(beforeCounters));
    await waitFor(() => expect(screen.queryByText(/seleccionado\(s\)/)).not.toBeInTheDocument());
  });

  it('informa el motivo real cuando parte del lote falla', async () => {
    const user = userEvent.setup();
    authState.user = FULL;
    twoRows();
    api.post.mockImplementation((url) => {
      if (url === '/api/tickets/1/close') {
        return Promise.reject(new Error('Debe registrar una resolución antes de cerrar el ticket.'));
      }
      return Promise.resolve({});
    });

    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');
    await user.click(screen.getByLabelText('Seleccionar todos los de la página'));
    await user.click(await screen.findByRole('button', { name: /^Cerrar$/ }));

    const alert = await screen.findByText(/1 de 2 ticket\(s\) no se pudieron actualizar/);
    expect(alert).toBeInTheDocument();
    expect(screen.getByText(/Debe registrar una resolución antes de cerrar el ticket/)).toBeInTheDocument();
    // El ticket que sí pudo cerrarse no se revierte por el fallo del otro.
    expect(api.post).toHaveBeenCalledWith('/api/tickets/2/close', {});
  });

  it('omite Resuelto y Cerrar sin ticket.resolve / ticket.close', async () => {
    const user = userEvent.setup();
    authState.user = ADMIN; // solo ticket.assign + ticket.update.any
    twoRows();

    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');
    await user.click(screen.getByLabelText('Seleccionar todos los de la página'));

    expect(await screen.findByRole('button', { name: /^En proceso$/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Resuelto$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Cerrar$/ })).not.toBeInTheDocument();
  });

  it('el menú de fila resuelve por /resolve en lugar de PATCH', async () => {
    const user = userEvent.setup();
    authState.user = FULL;
    twoRows();

    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getAllByRole('button', { name: '⋯' })[0]);
    await user.click(await screen.findByRole('menuitem', { name: /Marcar resuelto/ }));

    // El diálogo propio de un ticket titula con su número, no con un contador
    // de lote: es la acción de una fila, no de una selección.
    expect(await screen.findByRole('dialog', { name: 'Resolver TCK-000001' })).toBeInTheDocument();
    await user.type(await screen.findByLabelText(/Solución \/ trabajo realizado/), 'Se reinició el equipo');
    await user.click(screen.getByRole('button', { name: 'Resolver ticket' }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/api/tickets/1/resolve', { resolution: 'Se reinició el equipo' })
    );
    expect(api.patch).not.toHaveBeenCalledWith('/api/tickets/1', { status: 'RESOLVED' });
  });

  it('el menú de fila cierra por /close y mantiene PATCH para "en proceso"', async () => {
    const user = userEvent.setup();
    authState.user = FULL;
    twoRows();

    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getAllByRole('button', { name: '⋯' })[0]);
    await user.click(await screen.findByRole('menuitem', { name: /Marcar en proceso/ }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/tickets/1', { status: 'IN_PROGRESS' }));

    await user.click(screen.getAllByRole('button', { name: '⋯' })[0]);
    await user.click(await screen.findByRole('menuitem', { name: /Cerrar ticket/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/tickets/1/close', {}));
  });
});

// El backend exige ticket.assign para /api/users/assignable. La pantalla no
// debe pedir ese directorio a quien no puede asignar.
describe('Inbox · directorio de técnicos asignables', () => {
  it('lo carga para un usuario con ticket.assign y permite asignar en lote', async () => {
    const user = userEvent.setup();
    authState.user = FULL;
    api.get.mockImplementation((url) => {
      if (url.startsWith('/api/tickets/counters')) return Promise.resolve(COUNTERS);
      if (url.startsWith('/api/tickets?')) {
        return Promise.resolve(
          listResp([row(), row({ id: 2, ticket_number: 'TCK-000002', title: 'Impresora atascada' })])
        );
      }
      if (url.startsWith('/api/categories')) return Promise.resolve({ data: [{ id: 1, name: 'Hardware' }] });
      if (url.startsWith('/api/users/assignable')) {
        return Promise.resolve({ data: [{ id: 9, name: 'Beto', last_name: 'Gómez', department_name: 'TI' }] });
      }
      return Promise.reject(new Error('404'));
    });

    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');
    await user.click(screen.getByLabelText('Seleccionar todos los de la página'));

    expect(api.get).not.toHaveBeenCalledWith('/api/users/assignable');
    await user.click(await screen.findByRole('button', { name: 'Asignar a…' }));

    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/users/assignable'));
    // El menú del selector se portaliza a `document.body`, así que la opción se
    // busca en el documento, no dentro del diálogo.
    await user.click(within(dialog).getByLabelText('Técnico asignado'));
    await waitFor(() => expect(screen.getByRole('option', { name: /Beto Gómez/ })).toBeInTheDocument());
    await user.click(screen.getByRole('option', { name: /Beto Gómez/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Asignar' }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/tickets/1', { assigned_to_id: 9 }));
    expect(api.patch).toHaveBeenCalledWith('/api/tickets/2', { assigned_to_id: 9 });
  });

  it('no pide el directorio si el usuario no tiene ticket.assign', async () => {
    const user = userEvent.setup();
    authState.user = { id: 7, name: 'Sin asignar', permissions: ['ticket.update.any', 'ticket.resolve'] };

    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');
    await user.click(screen.getByLabelText('Seleccionar todos los de la página'));

    expect(screen.queryByRole('button', { name: 'Asignar a…' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Asignarme$/ })).not.toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalledWith('/api/users/assignable');
  });
});
// A2/P2: la prioridad en lote reutiliza el PATCH existente (el servidor
// recalcula el SLA) y un fallo parcial se reporta ticket a ticket.
describe('Inbox · prioridad en lote y detalle de fallos', () => {
  function threeRows() {
    api.get.mockImplementation((url) => {
      if (url.startsWith('/api/tickets/counters')) return Promise.resolve(COUNTERS);
      if (url.startsWith('/api/tickets?')) {
        return Promise.resolve(
          listResp([
            row(),
            row({ id: 2, ticket_number: 'TCK-000002', title: 'Impresora atascada' }),
            row({ id: 3, ticket_number: 'TCK-000003', title: 'WiFi intermitente' }),
          ])
        );
      }
      if (url.startsWith('/api/categories')) return Promise.resolve({ data: [{ id: 1, name: 'Hardware' }] });
      if (url.startsWith('/api/users/assignable')) return Promise.resolve({ data: [] });
      if (url.startsWith('/api/teams/assignable')) return Promise.resolve({ data: [] });
      return Promise.reject(new Error('404'));
    });
  }

  it('cambia la prioridad solo de los seleccionados', async () => {
    const user = userEvent.setup();
    authState.user = FULL;
    threeRows();

    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByLabelText('Seleccionar TCK-000001'));
    await user.click(screen.getByLabelText('Seleccionar TCK-000003'));
    await user.click(await screen.findByRole('button', { name: 'Prioridad…' }));

    const dialog = await screen.findByRole('dialog');
    await pickOption(user, within(dialog).getByLabelText('Prioridad'), 'Baja');
    await user.click(within(dialog).getByRole('button', { name: 'Aplicar prioridad' }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/tickets/1', { priority: 'LOW' }));
    expect(api.patch).toHaveBeenCalledWith('/api/tickets/3', { priority: 'LOW' });
    expect(api.patch).not.toHaveBeenCalledWith('/api/tickets/2', { priority: 'LOW' });
  });

  it('refresca el listado tras cambiar la prioridad en lote', async () => {
    const user = userEvent.setup();
    authState.user = FULL;
    threeRows();

    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    const listCalls = () => api.get.mock.calls.filter(([u]) => u.startsWith('/api/tickets?')).length;
    const before = listCalls();

    await user.click(screen.getByLabelText('Seleccionar todos los de la página'));
    await user.click(await screen.findByRole('button', { name: 'Prioridad…' }));
    const dialog = await screen.findByRole('dialog');
    await pickOption(user, within(dialog).getByLabelText('Prioridad'), 'Crítica');
    await user.click(within(dialog).getByRole('button', { name: 'Aplicar prioridad' }));

    await waitFor(() => expect(listCalls()).toBeGreaterThan(before));
  });

  it('omite la prioridad en lote sin ticket.update.any', async () => {
    const user = userEvent.setup();
    authState.user = { id: 7, name: 'Sin update', permissions: ['ticket.assign', 'ticket.resolve'] };
    threeRows();

    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByLabelText('Seleccionar todos los de la página'));

    expect(await screen.findByRole('button', { name: /^Resuelto$/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Prioridad…' })).not.toBeInTheDocument();
  });

  it('identifica cada ticket que falló con su motivo', async () => {
    const user = userEvent.setup();
    authState.user = FULL;
    threeRows();
    api.post.mockImplementation((url) => {
      if (url === '/api/tickets/1/close') return Promise.reject(new Error('Debe registrar una resolución antes de cerrar el ticket.'));
      if (url === '/api/tickets/2/close') return Promise.reject(new Error('No tiene permiso para cambiar el estado'));
      return Promise.resolve({});
    });

    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByLabelText('Seleccionar todos los de la página'));
    await user.click(await screen.findByRole('button', { name: /^Cerrar$/ }));

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('2 de 3 ticket(s) no se pudieron actualizar.')).toBeInTheDocument();
    expect(within(alert).getByText(/TCK-000001 — Debe registrar una resolución antes de cerrar el ticket/)).toBeInTheDocument();
    expect(within(alert).getByText(/TCK-000002 — No tiene permiso para cambiar el estado/)).toBeInTheDocument();
    // El ticket que sí se cerró no se reporta como fallo.
    expect(within(alert).queryByText(/TCK-000003/)).not.toBeInTheDocument();
  });

  it('mantiene seleccionados solo los tickets que fallaron', async () => {
    const user = userEvent.setup();
    authState.user = FULL;
    threeRows();
    api.post.mockImplementation((url) => {
      if (url === '/api/tickets/1/close') return Promise.reject(new Error('El ticket ya está cerrado'));
      return Promise.resolve({});
    });

    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByLabelText('Seleccionar todos los de la página'));
    await user.click(await screen.findByRole('button', { name: /^Cerrar$/ }));

    // Solo el que falló sigue seleccionado, para poder reintentarlo sin volver a
    // marcar los que ya quedaron bien.
    expect(await screen.findByText('1 seleccionado(s)')).toBeInTheDocument();
    expect(screen.getByLabelText('Seleccionar TCK-000001')).toBeChecked();
    expect(screen.getByLabelText('Seleccionar TCK-000002')).not.toBeChecked();
    expect(screen.getByLabelText('Seleccionar TCK-000003')).not.toBeChecked();
  });

  it('no filtra los tickets ya actualizados del lote', async () => {
    const user = userEvent.setup();
    authState.user = FULL;
    threeRows();
    api.post.mockImplementation((url) => {
      if (url === '/api/tickets/1/close') return Promise.reject(new Error('El ticket ya está cerrado'));
      return Promise.resolve({});
    });

    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    const listCalls = () => api.get.mock.calls.filter(([u]) => u.startsWith('/api/tickets?')).length;
    const before = listCalls();

    await user.click(screen.getByLabelText('Seleccionar todos los de la página'));
    await user.click(await screen.findByRole('button', { name: /^Cerrar$/ }));

await waitFor(() => expect(listCalls()).toBeGreaterThan(before));
  });
});

describe('Inbox · la pestaña "Mi equipo" depende de la pertenencia a equipos', () => {
  function tabs() {
    return within(screen.getByRole('group', { name: 'Vistas de la bandeja' }));
  }

  // `CON_TEAMS` simula la respuesta de GET /api/teams/mine. La pestaña depende de
  // la pertenencia del usuario, no de que existan equipos en el sistema.
  function mockMembership(teams) {
    api.get.mockImplementation((url) => {
      if (url === '/api/teams/mine') return Promise.resolve({ data: teams });
      if (url.startsWith('/api/tickets/counters')) return Promise.resolve(COUNTERS);
      if (url.startsWith('/api/tickets?')) return Promise.resolve(listResp());
      if (url.startsWith('/api/categories')) return Promise.resolve({ data: [{ id: 1, name: 'Hardware' }] });
      if (url.startsWith('/api/users/assignable')) return Promise.resolve({ data: [] });
      return Promise.reject(new Error(`404 ${url}`));
    });
  }

  it('oculta "Mi equipo" cuando el usuario no pertenece a ningún equipo', async () => {
    mockMembership([]);
    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    expect(await screen.findByRole('button', { name: /^Abiertos/ })).toBeInTheDocument();
    await waitFor(() => expect(tabs().queryByText('Mi equipo')).not.toBeInTheDocument());
    // Las demás pestañas siguen intactas.
    expect(tabs().getByText('Asignados a mí')).toBeInTheDocument();
    expect(tabs().getByText('Abiertos')).toBeInTheDocument();
    expect(tabs().getByText('Sin asignar')).toBeInTheDocument();
  });

  it('muestra "Mi equipo" cuando el usuario pertenece a al menos un equipo', async () => {
    mockMembership([{ id: 4, name: 'Soporte Nivel 1' }]);
    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    expect(await tabs().findByText('Mi equipo')).toBeInTheDocument();
    // Con equipo, la pestaña conserva su contador.
    expect(await within(tabs().getByRole('button', { name: /Mi equipo/ })).findByText('4')).toBeInTheDocument();
  });

  it('con equipo, "Mi equipo" navega y filtra exactamente igual que antes', async () => {
    const user = userEvent.setup();
    mockMembership([{ id: 4, name: 'Soporte Nivel 1' }]);

    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');
    const myTeamsTab = await tabs().findByRole('button', { name: /^Mi equipo/ });

    await user.click(myTeamsTab);

    // La consulta no cambia: sigue siendo view=my-teams con su active=1.
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('view=my-teams')));
    const [url] = api.get.mock.calls.filter(([u]) => u.startsWith('/api/tickets?')).pop();
    expect(url).toContain('active=1');
    expect(myTeamsTab).toHaveAttribute('aria-pressed', 'true');

    // Y al combinar con un filtro, ambos conviven en la URL.
    await user.click(screen.getByLabelText('Prioridad'));
    await user.click(screen.getByRole('option', { name: 'Crítica' }));

    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('priority=CRITICAL')));
    expect(tabs().getByRole('button', { name: /^Mi equipo/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('muestra "Mi equipo" mientras se consulta y si la consulta falla', async () => {
    // Ante la duda se enseña: un fallo de red no significa que no tenga equipos,
    // y esconder la pestaña por un fallo sería el error caro.
    api.get.mockImplementation((url) => {
      if (url === '/api/teams/mine') return new Promise(() => {});
      if (url.startsWith('/api/tickets/counters')) return Promise.resolve(COUNTERS);
      if (url.startsWith('/api/tickets?')) return Promise.resolve(listResp());
      if (url.startsWith('/api/categories')) return Promise.resolve({ data: [] });
      return Promise.reject(new Error(`404 ${url}`));
    });
    const { unmount } = renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');
    expect(tabs().getByText('Mi equipo')).toBeInTheDocument();
    unmount();

    api.get.mockImplementation((url) => {
      if (url === '/api/teams/mine') return Promise.reject(new Error('500'));
      if (url.startsWith('/api/tickets/counters')) return Promise.resolve(COUNTERS);
      if (url.startsWith('/api/tickets?')) return Promise.resolve(listResp());
      if (url.startsWith('/api/categories')) return Promise.resolve({ data: [] });
      return Promise.reject(new Error(`404 ${url}`));
    });
    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');
    expect(tabs().getByText('Mi equipo')).toBeInTheDocument();
  });

  it('no consulta la pertenencia a equipos más de una vez', async () => {
    mockMembership([{ id: 4, name: 'Soporte Nivel 1' }]);
    const { rerender } = renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');
    await tabs().findByText('Mi equipo');

    const mineCalls = () => api.get.mock.calls.filter(([u]) => u === '/api/teams/mine').length;
    const before = mineCalls();
    rerender(<Inbox />);
    rerender(<Inbox />);

    expect(mineCalls()).toBe(before);
  });
});

describe('Inbox · un ?tab=my-teams sin equipos se corrige solo', () => {
  function tabs() {
    return within(screen.getByRole('group', { name: 'Vistas de la bandeja' }));
  }

  // El history de pruebas es el único sitio donde se distingue un replace de un
  // push: `length` no crece con replace y sí con push.
  const searchOf = (history) => new URLSearchParams(history.location.search);

  function mockMembership(teams) {
    api.get.mockImplementation((url) => {
      if (url === '/api/teams/mine') return Promise.resolve({ data: teams });
      if (url.startsWith('/api/tickets/counters')) return Promise.resolve(COUNTERS);
      if (url.startsWith('/api/tickets?')) return Promise.resolve(listResp());
      if (url.startsWith('/api/categories')) return Promise.resolve({ data: [] });
      if (url.startsWith('/api/users/assignable')) return Promise.resolve({ data: [] });
      return Promise.reject(new Error(`404 ${url}`));
    });
  }

  function render(route) {
    return renderWithHistory(<Inbox />, { route });
  }

  it('redirige a la vista predeterminada y lo hace con replace', async () => {
    mockMembership([]);
    const { history } = render('/app/inbox?tab=my-teams');
    await screen.findByText('TCK-000001');

    // Espera a la corrección: la pestaña de destino queda activa.
    await waitFor(() => expect(tabs().getByRole('button', { name: /^Asignados a mí/ })).toHaveAttribute('aria-pressed', 'true'));
    expect(searchOf(history).get('tab')).toBe('mine');
    // Un replace no añade entrada al historial: el `?tab=my-teams` queda
    // sobrescrito en el sitio que ya ocupaba, no encima.
    expect(history.length).toBe(1);
    expect(history.index).toBe(0);
    // Y ya no queda ninguna pestaña de equipo a la vista.
    expect(tabs().queryByText('Mi equipo')).not.toBeInTheDocument();
  });

  it('el botón atrás no devuelve al tab inválido', async () => {
    mockMembership([]);
    const { history } = render('/app/inbox?tab=my-teams');
    await screen.findByText('TCK-000001');
    await waitFor(() => expect(searchOf(history).get('tab')).toBe('mine'));

    await act(async () => {
      history.go(-1);
    });

    // Con una sola entrada, el atrás no tiene a dónde ir: la URL válida se
    // mantiene y la pantalla no vuelve a quedarse sin pestaña.
    expect(history.index).toBe(0);
    expect(searchOf(history).get('tab')).toBe('mine');
    expect(tabs().getByRole('button', { name: /^Asignados a mí/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('no corrige la URL mientras la consulta sigue en vuelo', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/api/teams/mine') return new Promise(() => {});
      if (url.startsWith('/api/tickets/counters')) return Promise.resolve(COUNTERS);
      if (url.startsWith('/api/tickets?')) return Promise.resolve(listResp());
      if (url.startsWith('/api/categories')) return Promise.resolve({ data: [] });
      return Promise.reject(new Error(`404 ${url}`));
    });
    const { history } = render('/app/inbox?tab=my-teams');
    await screen.findByText('TCK-000001');

    // Sin respuesta no hay nada que confirmar: la URL se respeta tal cual.
    expect(searchOf(history).get('tab')).toBe('my-teams');
  });

  it('no corrige la URL si /api/teams/mine falla', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/api/teams/mine') return Promise.reject(new Error('500'));
      if (url.startsWith('/api/tickets/counters')) return Promise.resolve(COUNTERS);
      if (url.startsWith('/api/tickets?')) return Promise.resolve(listResp());
      if (url.startsWith('/api/categories')) return Promise.resolve({ data: [] });
      return Promise.reject(new Error(`404 ${url}`));
    });
    const { history } = render('/app/inbox?tab=my-teams');
    await screen.findByText('TCK-000001');

    // Un fallo de red no significa "no tengo equipos": si se corrigiera, el
    // usuario perdería una vista a la que sí tiene derecho.
    expect(searchOf(history).get('tab')).toBe('my-teams');
  });

  it('con equipo conserva el ?tab=my-teams y no toca el historial', async () => {
    mockMembership([{ id: 4, name: 'Soporte Nivel 1' }]);
    const { history } = render('/app/inbox?tab=my-teams');
    await screen.findByText('TCK-000001');

    await waitFor(() => expect(tabs().getByRole('button', { name: /^Mi equipo/ })).toHaveAttribute('aria-pressed', 'true'));
    expect(searchOf(history).get('tab')).toBe('my-teams');
    expect(history.length).toBe(1);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('view=my-teams')));
  });

  it('no altera el PUSH normal al elegir otra pestaña a mano', async () => {
    const user = userEvent.setup();
    mockMembership([]);
    const { history } = render('/app/inbox');
    await screen.findByText('TCK-000001');
    await waitFor(() => expect(tabs().queryByText('Mi equipo')).not.toBeInTheDocument());

    await user.click(await tabs().findByRole('button', { name: /^Abiertos/ }));
    await waitFor(() => expect(searchOf(history).get('tab')).toBe('open'));

    // Elegir una pestaña sigue siendo una entrada más del historial.
    expect(history.length).toBe(2);
    await act(async () => {
      history.go(-1);
    });
    // Al atrás se vuelve a la entrada original, que no lleva `tab`: la vista
    // predeterminada. La corrección automática no se ha colado en medio.
    expect(searchOf(history).get('tab')).toBeNull();
    expect(tabs().getByRole('button', { name: /^Asignados a mí/ })).toHaveAttribute('aria-pressed', 'true');
    expect(history.length).toBe(2);
  });
});

describe('Inbox · resumen, SLA y filtros activos', () => {
  function indicator(name) {
    return within(screen.getByRole('group', { name: 'Resumen de la bandeja' })).getByRole('button', { name: new RegExp(`^${name}`) });
  }

  it('el contador de cada indicador coincide con su etiqueta', async () => {
    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    expect(await within(indicator('Mis activos')).findByText('2')).toBeInTheDocument();
    expect(await within(indicator('Sin asignar')).findByText('1')).toBeInTheDocument();
    expect(await within(indicator('Fuera de plazo')).findByText('1')).toBeInTheDocument();
    expect(await within(indicator('Críticos')).findByText('0')).toBeInTheDocument();
    expect(await within(indicator('En espera')).findByText('1')).toBeInTheDocument();
    // El indicador ya no se llama "Pendientes": ese nombre es el de la vista
    // histórica OPEN+PENDING, que es otra cifra.
    expect(within(screen.getByRole('group', { name: 'Resumen de la bandeja' })).queryByText('Pendientes')).not.toBeInTheDocument();
  });

  it('"En espera" consulta el estado pendiente exacto sobre los abiertos', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    await user.click(indicator('En espera'));

    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('status=PENDING')));
    expect(api.get).toHaveBeenCalledWith(expect.stringContaining('view=open'));
    const [url] = api.get.mock.calls.filter(([u]) => u.startsWith('/api/tickets?')).pop();
    // El filtro sigue siendo el estado exacto: no se cuela `view=pending`, que
    // incluiría también los OPEN.
    expect(url).not.toContain('view=pending');
    expect(indicator('En espera')).toHaveAttribute('aria-pressed', 'true');
  });

  it('"En espera" vuelve atrás con el botón del navegador', async () => {
    const user = userEvent.setup();
    const { history } = renderWithHistory(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    await user.click(indicator('En espera'));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('status=PENDING')));
    expect(screen.getByText('Estado: Pendiente')).toBeInTheDocument();

    await act(async () => { history.go(-1); });

    await waitFor(() => expect(screen.queryByText('Estado: Pendiente')).not.toBeInTheDocument());
    expect(indicator('En espera')).toHaveAttribute('aria-pressed', 'false');
    const [url] = api.get.mock.calls.filter(([u]) => u.startsWith('/api/tickets?')).pop();
    expect(url).not.toContain('status=');
  });

  it('"Fuera de plazo" lleva a la consulta de SLA, no a un filtro aparte', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    await user.click(indicator('Fuera de plazo'));

    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('sla=overdue')));
    expect(api.get).toHaveBeenCalledWith(expect.stringContaining('view=open'));
  });

  it('"Críticos" consulta la prioridad crítica sobre los abiertos', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    await user.click(indicator('Críticos'));

    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('priority=CRITICAL')));
    expect(api.get).toHaveBeenCalledWith(expect.stringContaining('view=open'));
  });

  it('"Sin asignar" quita los filtros que chocarían con su contador', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Inbox />, { route: '/app/inbox?tab=open&priority=LOW&sla=due_soon&category=1' });
    await screen.findByText('TCK-000001');

    await user.click(indicator('Sin asignar'));

    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('assigned=none')));
    const [url] = api.get.mock.calls.filter(([u]) => u.startsWith('/api/tickets?')).pop();
    expect(url).toContain('view=open');
    expect(url).not.toContain('priority=');
    expect(url).not.toContain('sla=');
    // La categoría era un filtro válido y no se pierde al cambiar de vista.
    expect(url).toContain('category=1');
  });

  it('marca como activo sólo el indicador que describe el listado', async () => {
    renderWithProviders(<Inbox />, { route: '/app/inbox?tab=open&sla=overdue' });
    await screen.findByText('TCK-000001');

    expect(indicator('Fuera de plazo')).toHaveAttribute('aria-pressed', 'true');
    expect(indicator('Críticos')).toHaveAttribute('aria-pressed', 'false');
    expect(indicator('Mis activos')).toHaveAttribute('aria-pressed', 'false');
  });

  it('deja de marcar el indicador cuando se añade un filtro que lo contradice', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Inbox />, { route: '/app/inbox?tab=open&sla=overdue' });
    await screen.findByText('TCK-000001');
    expect(indicator('Fuera de plazo')).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByLabelText('Prioridad'));
    await user.click(screen.getByRole('option', { name: 'Baja' }));

    await waitFor(() => expect(indicator('Fuera de plazo')).toHaveAttribute('aria-pressed', 'false'));
  });

  it('filtra por plazo de atención con el control propio', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    expect(screen.getByLabelText('Tiempo de atención')).toHaveAttribute('id', 'inbox-sla');
    await user.click(screen.getByLabelText('Tiempo de atención'));
    await user.click(screen.getByRole('option', { name: 'Vencen en 24 h' }));

    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('sla=due_soon')));
  });

  it('muestra un chip por filtro activo y quita sólo el que se pulse', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Inbox />, { route: '/app/inbox?status=OPEN&category=1&sla=overdue' });
    await screen.findByText('TCK-000001');

    expect(screen.getByText('Estado: Abierto')).toBeInTheDocument();
    expect(screen.getByText('Categoría: Hardware')).toBeInTheDocument();
    expect(screen.getByText('Tiempo: Fuera de plazo')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Quitar filtro Categoría: Hardware' }));

    expect(screen.queryByText('Categoría: Hardware')).not.toBeInTheDocument();
    // Los otros filtros siguen intactos.
    expect(screen.getByText('Estado: Abierto')).toBeInTheDocument();
    expect(screen.getByText('Tiempo: Fuera de plazo')).toBeInTheDocument();
  });

  it('el chip de solicitante usa el directorio, no el id crudo', async () => {
    api.get.mockImplementation((url) => {
      if (url.startsWith('/api/tickets/counters')) return Promise.resolve(COUNTERS);
      if (url.startsWith('/api/tickets?')) return Promise.resolve(listResp());
      if (url.startsWith('/api/categories')) return Promise.resolve({ data: [{ id: 1, name: 'Hardware' }] });
      if (url.startsWith('/api/users/assignable')) return Promise.resolve({ data: [{ id: 9, name: 'Beto', last_name: 'Gómez', department_name: 'TI' }] });
      return Promise.reject(new Error(`404 ${url}`));
    });

    renderWithProviders(<Inbox />, { route: '/app/inbox?assigned=9' });
    await screen.findByText('TCK-000001');

    expect(await screen.findByText('Asignado: Beto Gómez')).toBeInTheDocument();
  });

  it('el chip "Sin asignar" no intenta resolver un id vacío', async () => {
    renderWithProviders(<Inbox />, { route: '/app/inbox?tab=unassigned&assigned=none' });
    await screen.findByText('TCK-000001');

    expect(await screen.findByText('Asignado: Sin asignar')).toBeInTheDocument();
  });

  it('"Limpiar filtros" vacía la búsqueda y los filtros avanzados a la vez', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Inbox />, { route: '/app/inbox?status=OPEN&sla=overdue&category=1&user=9&from=2026-01-01' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByRole('button', { name: 'Limpiar filtros' }));

    await waitFor(() => expect(screen.queryByText('Estado: Abierto')).not.toBeInTheDocument());
    expect(screen.queryByText('Tiempo: Fuera de plazo')).not.toBeInTheDocument();
    expect(screen.queryByText('Creado desde: 2026-01-01')).not.toBeInTheDocument();
    const [url] = api.get.mock.calls.filter(([u]) => u.startsWith('/api/tickets?')).pop();
    expect(url).not.toContain('status=');
    expect(url).not.toContain('sla=');
    expect(url).not.toContain('category=');
  });

  it('no muestra la fila de filtros cuando no hay nada activo', async () => {
    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    expect(screen.queryByText('Filtros')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Limpiar filtros' })).not.toBeInTheDocument();
  });

  it('explica el filtro vacío y ofrece la salida, en vez de una tabla en blanco', async () => {
    const user = userEvent.setup();
    api.get.mockImplementation((url) => {
      if (url.startsWith('/api/tickets/counters')) return Promise.resolve(COUNTERS);
      if (url.startsWith('/api/tickets?')) return Promise.resolve(listResp([]));
      if (url.startsWith('/api/categories')) return Promise.resolve({ data: [{ id: 1, name: 'Hardware' }] });
      return Promise.reject(new Error(`404 ${url}`));
    });

    renderWithProviders(<Inbox />, { route: '/app/inbox?status=OPEN' });

    expect(await screen.findByText('No encontramos tickets con estos filtros')).toBeInTheDocument();
    // Hay dos salidas al mismo sitio: el chip de la cabecera y la del propio
    // estado vacío. Las dos sirven, por eso el test usa la que está en pantalla
    // cuando la tabla no ha devuelto nada.
    await user.click(screen.getAllByRole('button', { name: 'Limpiar filtros' }).pop());

    await waitFor(() => expect(screen.queryByText('No encontramos tickets con estos filtros')).not.toBeInTheDocument());
  });

  it('cada pestaña vacía dice qué hacer en lugar de "sin datos"', async () => {
    api.get.mockImplementation((url) => {
      if (url.startsWith('/api/tickets/counters')) return Promise.resolve(COUNTERS);
      if (url.startsWith('/api/tickets?')) return Promise.resolve(listResp([]));
      if (url.startsWith('/api/categories')) return Promise.resolve({ data: [] });
      return Promise.reject(new Error(`404 ${url}`));
    });

    renderWithProviders(<Inbox />, { route: '/app/inbox?tab=mine' });
    expect(await screen.findByText('No tienes tickets asignados')).toBeInTheDocument();
    // El mensaje dice a dónde ir, no sólo que no hay datos.
    expect(screen.getByText(/Revise la pestañ/)).toBeInTheDocument();
  });

  it('el botón atrás del navegador restituye la vista anterior', async () => {
    const user = userEvent.setup();
    const { history } = renderWithHistory(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    await user.click(indicator('Críticos'));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('priority=CRITICAL')));
    expect(indicator('Críticos')).toHaveAttribute('aria-pressed', 'true');

    await act(async () => { history.go(-1); });

    // Al volver no queda ningún filtro colgado: ni el listado ni los chips.
    await waitFor(() => expect(screen.queryByText('Prioridad: Crítica')).not.toBeInTheDocument());
    expect(indicator('Críticos')).toHaveAttribute('aria-pressed', 'false');
    const [url] = api.get.mock.calls.filter(([u]) => u.startsWith('/api/tickets?')).pop();
    expect(url).not.toContain('priority=');
  });
});

// El bloqueo por doble clic y el aviso de éxito ya están cubiertos arriba; aquí
// se cierra la cobertura de los estados, el SLA y la actividad en la fila.
describe('Inbox · acciones de fila por estado', () => {
  const HOUR = 3600000;

  function withRows(rows) {
    api.get.mockImplementation((url) => {
      if (url === '/api/tickets/counters') return Promise.resolve(COUNTERS);
      if (url.startsWith('/api/tickets?')) return Promise.resolve(listResp(rows));
      if (url === '/api/categories') return Promise.resolve({ data: [] });
      if (url === '/api/departments') return Promise.resolve({ data: [] });
      if (url === '/api/users/assignable') return Promise.resolve({ data: [] });
      if (url === '/api/teams/assignable') return Promise.resolve({ data: [] });
      return Promise.reject(new Error(`404 ${url}`));
    });
  }

  it.each([
    ['Iniciar atención', 'OPEN', 'IN_PROGRESS'],
    ['Poner en espera', 'IN_PROGRESS', 'PENDING'],
    ['Reanudar', 'PENDING', 'IN_PROGRESS'],
  ])('la acción rápida "%s" hace el PATCH %s → %s', async (label, status, esperado) => {
    const user = userEvent.setup();
    authState.user = FULL;
    withRows([row({ status, assigned_to_id: 7 })]);
    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByRole('button', { name: `${label} TCK-000001` }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/tickets/1', { status: esperado }));
  });

  it.each(['RESOLVED', 'CLOSED', 'CANCELLED'])('no ofrece acciones sobre un ticket %s', async (status) => {
    const user = userEvent.setup();
    authState.user = FULL;
    withRows([row({ status, assigned_to_id: 7 })]);
    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    expect(screen.queryByRole('button', { name: /Tomar ticket|Iniciar atención|Resolver|Reanudar|Poner en espera/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '⋯' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(1);
    expect(api.patch).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('no ofrece resolver sin ticket.resolve', async () => {
    authState.user = { id: 7, name: 'Admin', department_id: 3, permissions: ['ticket.assign', 'ticket.update.any'] };
    withRows([row({ status: 'IN_PROGRESS', assigned_to_id: 7 })]);
    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    expect(screen.queryByRole('button', { name: /Resolver TCK/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Poner en espera TCK-000001' })).toBeInTheDocument();
  });

  it('muestra el error del servidor cuando la resolución falla y conserva el diálogo', async () => {
    const user = userEvent.setup();
    authState.user = FULL;
    api.post.mockRejectedValue(new Error('El ticket ya está en un estado terminal'));
    withRows([row({ status: 'IN_PROGRESS', assigned_to_id: 7 })]);
    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByRole('button', { name: 'Resolver TCK-000001' }));
    const dialog = await screen.findByRole('dialog', { name: 'Resolver TCK-000001' });
    await user.type(within(dialog).getByLabelText(/Solución \/ trabajo realizado/), 'Se cambió la fuente');
    await user.click(within(dialog).getByRole('button', { name: 'Resolver ticket' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('El ticket ya está en un estado terminal');
    expect(within(dialog).getByLabelText(/Solución \/ trabajo realizado/)).toHaveValue('Se cambió la fuente');
  });

  it('distingue SLA vencido, próximo y ausente sin teñir la fila', async () => {
    authState.user = FULL;
    withRows([
      row({ id: 1, status: 'IN_PROGRESS', assigned_to_id: 7, sla_due_at: new Date(Date.now() - 2 * HOUR).toISOString(), is_overdue: true }),
      row({ id: 2, ticket_number: 'TCK-000002', status: 'IN_PROGRESS', assigned_to_id: 7, sla_due_at: new Date(Date.now() + 3 * HOUR).toISOString() }),
      row({ id: 3, ticket_number: 'TCK-000003', status: 'OPEN', sla_due_at: null }),
    ]);
    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    const vencida = screen.getByText('TCK-000001').closest('tr');
    const proxima = screen.getByText('TCK-000002').closest('tr');
    const sinPlazo = screen.getByText('TCK-000003').closest('tr');

    expect(within(vencida).getByText(/Vencido hace/)).toBeInTheDocument();
    expect(within(proxima).getByText(/Vence en/)).toBeInTheDocument();
    expect(within(sinPlazo).getByText('Sin SLA')).toBeInTheDocument();
    expect(vencida.className).not.toMatch(/bg-red/);
  });

  it('muestra la última actividad desde el listado, sin peticiones por fila', async () => {
    authState.user = FULL;
    withRows([row({ assigned_to_id: 7, updated_at: new Date(Date.now() - 5 * HOUR).toISOString() })]);
    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    expect(screen.getByText('hace 5 h')).toBeInTheDocument();
    const porFila = api.get.mock.calls.filter(([url]) => /^\/api\/tickets\/\d+/.test(url));
    expect(porFila).toHaveLength(0);
  });

  // Caso reportado en la prueba visual: un IN_PROGRESS de "Mis activos", ya
  // asignado al técnico que lo mira. El menú tiene que ofrecer "Poner en
  // espera" y no puede ofrecer "Asignarme a mí" sobre un ticket que ya es suyo.
  describe('el menú de un ticket en proceso que ya es mío', () => {
    async function abrirMenu() {
      const user = userEvent.setup();
      authState.user = FULL;
      withRows([row({ status: 'IN_PROGRESS', assigned_to_id: 7 })]);
      renderWithProviders(<Inbox />, { route: '/app/inbox?tab=mine' });
      await screen.findByText('TCK-000001');
      await user.click(screen.getByRole('button', { name: '⋯' }));
      const menu = await screen.findByRole('menu');
      return within(menu).getAllByRole('menuitem').map((m) => m.textContent.trim());
    }

    it('ofrece exactamente Ver detalle, Poner en espera, Marcar resuelto, Cerrar y Cancelar', async () => {
      expect(await abrirMenu()).toEqual([
        '🔎Ver detalle',
        '⏸️Poner en espera',
        '✅Marcar resuelto',
        '📁Cerrar ticket',
        '🚫Cancelar ticket',
      ]);
    });

    it('no ofrece "Asignarme a mí" sobre un ticket que ya tengo', async () => {
      expect(await abrirMenu()).not.toContain('🙋Asignarme a mí');
    });

    it('no ofrece "Marcar en proceso" sobre un ticket que ya lo está', async () => {
      expect(await abrirMenu()).not.toContain('⏳Marcar en proceso');
    });
  });
});


describe('Inbox · el botón de refrescar se explica y sigue recargando', () => {
  it('sustituye el title nativo por un tooltip accesible', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    const refrescar = screen.getByRole('button', { name: 'Actualizar' });
    expect(refrescar).not.toHaveAttribute('title');

    await user.hover(refrescar);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Actualizar');
  });

  it('pide el listado otra vez al pulsarlo', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');
    const antes = api.get.mock.calls.filter(([u]) => u.startsWith('/api/tickets?')).length;

    await user.click(screen.getByRole('button', { name: 'Actualizar' }));

await waitFor(() => {
      const despues = api.get.mock.calls.filter(([u]) => u.startsWith('/api/tickets?')).length;
      expect(despues).toBeGreaterThan(antes);
    });
  });
});

// La banda comparte barra con la pantalla de tickets: está anclada abajo con
// `position: fixed` y lo único que la impedía tapar la última fila y la
// paginación era el hueco que deja en el flujo normal, que tiene que medir lo
// mismo que ella. jsdom no calcula geometría, así que se comprueba el contrato
// —barra fija, acciones en una sola línea y hueco del flujo con el mismo alto
// declarado— y no un solapamiento que el entorno no puede medir.
describe('Inbox · la barra en lote deja hueco y no tapa el final del contenido', () => {
  // 30 tickets en dos páginas: la paginación trae botones y es el último control
  // del contenido, justo lo que la barra no puede cubrir.
  function dosPaginas() {
    api.get.mockImplementation((url) => {
      if (url.startsWith('/api/tickets/counters')) return Promise.resolve(COUNTERS);
      if (url.startsWith('/api/tickets?')) {
        return Promise.resolve(
          listResp([row(), row({ id: 2, ticket_number: 'TCK-000002', title: 'Impresora atascada' })], 1, 2, 30)
        );
      }
      if (url.startsWith('/api/categories')) return Promise.resolve({ data: [{ id: 1, name: 'Hardware' }] });
      if (url.startsWith('/api/users/assignable')) return Promise.resolve({ data: [] });
      return Promise.reject(new Error('404'));
    });
  }

  it('sin selección no hay barra ni hueco reservado', async () => {
    authState.user = FULL;
    dosPaginas();
    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    expect(screen.queryByTestId('bulk-bar')).toBeNull();
    expect(screen.queryByTestId('bulk-bar-gap')).toBeNull();
    // La reserva anterior era un `pb-28` en la raíz de la página: si volviera a
    // aparecer junto al hueco, la pantalla reservaría el doble.
    expect(document.querySelector('.pb-28')).toBeNull();
  });

  it('con selección aparecen la barra y un hueco de su mismo alto', async () => {
    const user = userEvent.setup();
    authState.user = FULL;
    dosPaginas();
    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByLabelText('Seleccionar TCK-000001'));

    const barra = screen.getByTestId('bulk-bar');
    expect(barra).toHaveClass('fixed', 'inset-x-0', 'bottom-0', BAR_HEIGHT);
    const hueco = screen.getByTestId('bulk-bar-gap');
    expect(hueco).toHaveClass(BAR_HEIGHT);

    // La línea no se reparte en filas, se desplaza: así el alto no depende del
    // ancho y el hueco le sirve igual en móvil y en escritorio.
    const fila = barra.firstElementChild;
    expect(fila).not.toHaveClass('flex-wrap');
    expect(fila).toHaveClass('overflow-x-auto', 'h-full');

    // La paginación sigue en su sitio y el hueco va después de ella.
    const paginacion = screen.getByText(/de 30/);
    expect(paginacion).toHaveTextContent('Página 1 de 2');
    expect(screen.getByRole('button', { name: 'Siguiente →' })).toBeEnabled();
    expect(paginacion.compareDocumentPosition(hueco) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('al limpiar la selección desaparecen la barra y el hueco', async () => {
    const user = userEvent.setup();
    authState.user = FULL;
    dosPaginas();
    renderWithProviders(<Inbox />, { route: '/app/inbox' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByLabelText('Seleccionar todos los de la página'));
    expect(screen.getByTestId('bulk-bar-gap')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Quitar selección' }));

    expect(screen.queryByTestId('bulk-bar')).toBeNull();
    expect(screen.queryByTestId('bulk-bar-gap')).toBeNull();
  });
});