import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Tickets from './Tickets';
import { api, VIEWS } from '../lib/api';
import { renderWithProviders, renderWithHistory, pickOption } from '../test/utils';

const { authState, download } = vi.hoisted(() => ({
  authState: { user: null },
  download: vi.fn(),
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
    download,
  };
});

const COUNTERS = {
  open: 3,
  pending: 1,
  attended: 2,
  in_progress: 1,
  overdue: 1,
  assigned_to_me: 2,
  assigned_to_my_teams: 4,
  unassigned: 1,
  closed: { month: 5 },
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

const ADMIN = { id: 7, name: 'Admin', department_id: 3, permissions: ['ticket.export', 'ticket.assign', 'ticket.update.any'] };
// Técnico del seed: además de update.any/resolve/close puede ver toda la lista,
// así que la búsqueda avanzada sí puede cargarle los directorios.
const FULL = {
  id: 7,
  name: 'Admin',
  department_id: 3,
  permissions: ['ticket.assign', 'ticket.update.any', 'ticket.resolve', 'ticket.close', 'ticket.view.all'],
};

// Respuestas por defecto de la pantalla. Vive fuera del `beforeEach` para que
// un test que necesite otra lista pueda reutilizarla en vez de reescribirla.
function defaultGet(url) {
  if (url.startsWith('/api/tickets/counters')) return Promise.resolve(COUNTERS);
  if (url.startsWith('/api/tickets?')) return Promise.resolve(listResp());
  if (url === '/api/categories') return Promise.resolve({ data: [] });
  if (url === '/api/departments') return Promise.resolve({ data: [] });
  if (url === '/api/users/assignable') return Promise.resolve({ data: [] });
  if (url === '/api/teams/assignable') return Promise.resolve({ data: [] });
  return Promise.reject(new Error(`404 ${url}`));
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.user = ADMIN;
  api.get.mockReset();
  api.patch.mockReset();
  api.get.mockImplementation(defaultGet);
});

describe('Tickets', () => {
  it('renderiza el listado recibido de la API', async () => {
    renderWithProviders(<Tickets />, { route: '/app/tickets' });

    expect(await screen.findByText('TCK-000001')).toBeInTheDocument();
    expect(screen.getByText('PC no enciende')).toBeInTheDocument();
    expect(screen.getByText('Exportar')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/tickets\?/));
    expect(api.get).toHaveBeenCalledWith('/api/tickets/counters');
  });

  it('muestra estado de carga mientras la API responde', async () => {
    let resolveList;
    api.get.mockImplementation((url) => {
      if (url.startsWith('/api/tickets/counters')) return Promise.resolve(COUNTERS);
      if (url.startsWith('/api/tickets?')) return new Promise((r) => { resolveList = r; });
      return Promise.reject(new Error('404'));
    });

    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    expect(screen.getAllByText('Cargando…').length).toBeGreaterThan(0);

    await act(async () => {
      resolveList(listResp());
    });
    expect(await screen.findByText('TCK-000001')).toBeInTheDocument();
  });

  it('muestra el error devuelto por la API', async () => {
    api.get.mockImplementation((url) => {
      if (url.startsWith('/api/tickets/counters')) return Promise.resolve(COUNTERS);
      return Promise.reject(new Error('Error 500'));
    });

    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    expect(await screen.findByRole('alert')).toHaveTextContent('Error 500');
  });

  it('aplica el filtro rápido "Abiertos" a la consulta', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByRole('button', { name: /Abiertos/ }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('view=open')));
  });

  it('cambia el orden y lo refleja en la consulta', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    await screen.findByText('TCK-000001');

    const sort = screen.getByTitle('Ordenar por');
    expect(sort).toHaveAttribute('aria-expanded', 'false');
    // El rótulo visible mantiene el prefijo "Ordenar: " que tenía el <option>.
    expect(sort).toHaveTextContent('Ordenar: Fecha de creación');

    await user.click(sort);
    await user.click(screen.getByRole('option', { name: 'Ordenar: Prioridad' }));

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('sort=priority')));
    expect(sort).toHaveTextContent('Ordenar: Prioridad');
  });

  it('el orden travels junto a dir y no toca el resto de la URL', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Tickets />, { route: '/app/tickets?view=open&status=OPEN' });
    await screen.findByText('TCK-000001');

    const urls = () => api.get.mock.calls.map(([u]) => u).filter((u) => u.startsWith('/api/tickets?'));
    expect(urls().some((u) => u.includes('view=open') && u.includes('status=OPEN'))).toBe(true);

    await user.click(screen.getByTitle('Ordenar por'));
    await user.click(screen.getByRole('option', { name: 'Ordenar: Número de ticket' }));

    await waitFor(() => expect(urls().some((u) => u.includes('sort=ticket_number'))).toBe(true));
    // dir y los filtros de la URL siguen intactos, y la vista se resetea a la 1.
    const last = urls().at(-1);
    expect(last).toContain('view=open');
    expect(last).toContain('status=OPEN');
    expect(last).toContain('dir=desc');
    expect(last).toContain('page=1');
  });


  it('el orden depende de la URL: al limpiar vuelve al valor por defecto', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Tickets />, { route: '/app/tickets?sort=priority' });
    await screen.findByText('TCK-000001');

    const sort = screen.getByTitle('Ordenar por');
    expect(sort).toHaveTextContent('Ordenar: Prioridad');

    await user.click(screen.getByRole('button', { name: 'Limpiar' }));

    // El control no guarda estado propio: refleja siempre lo que hay en la URL.
    await waitFor(() => expect(sort).toHaveTextContent('Ordenar: Fecha de creación'));
  });

  it('pagina a la siguiente página', async () => {
    const user = userEvent.setup();
    api.get.mockImplementation((url) => {
      if (url.startsWith('/api/tickets/counters')) return Promise.resolve(COUNTERS);
      if (url.startsWith('/api/tickets?')) return Promise.resolve(listResp([row()], 1, 2, 20));
      return Promise.reject(new Error('404'));
    });

    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    await screen.findByText('TCK-000001');

    const next = screen.getByRole('button', { name: /Siguiente/ });
    expect(next).toBeEnabled();
    await user.click(next);

    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('page=2')));
  });

  it('cambia el estado del ticket e invalida el listado', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    await screen.findByText('TCK-000001');

    const ticketCalls = () => api.get.mock.calls.filter(([u]) => u.startsWith('/api/tickets?')).length;
    const before = ticketCalls();

    await user.click(screen.getByRole('button', { name: '⋯' }));
    await user.click(await screen.findByRole('menuitem', { name: /Marcar en proceso/ }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/tickets/1', { status: 'IN_PROGRESS' }));
    await waitFor(() => expect(ticketCalls()).toBeGreaterThan(before));
  });

it('asigna el ticket al usuario actual', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    await screen.findByText('TCK-000001');

    // El ticket del fixture no tiene técnico, así que la acción directa es
    // "Tomar ticket"; "Asignarme a mí" queda para los que ya tienen dueño.
    await user.click(screen.getByRole('button', { name: 'Tomar ticket TCK-000001' }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/tickets/1', { assigned_to_id: 7 }));
  });

  it('asigna desde el menú un ticket que ya tiene técnico', async () => {
    const user = userEvent.setup();
    api.get.mockImplementation((url) => {
      if (url.startsWith('/api/tickets/counters')) return Promise.resolve(COUNTERS);
      if (url.startsWith('/api/tickets?')) {
        return Promise.resolve(
          listResp([row({ assigned_to_id: 9, assigned_to_name: 'Beto Gómez' })])
        );
      }
      if (url === '/api/categories') return Promise.resolve({ data: [] });
      if (url === '/api/departments') return Promise.resolve({ data: [] });
      if (url === '/api/users/assignable') return Promise.resolve({ data: [] });
      if (url === '/api/teams/assignable') return Promise.resolve({ data: [] });
      return Promise.reject(new Error(`404 ${url}`));
    });

    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByRole('button', { name: '⋯' }));
    await user.click(await screen.findByRole('menuitem', { name: /Asignarme a mí/ }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/tickets/1', { assigned_to_id: 7 }));
  });

  it('oculta acciones y exportación cuando el usuario no tiene permisos', async () => {
    authState.user = { id: 7, name: 'Usuario', permissions: [] };

    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    await screen.findByText('TCK-000001');

    expect(screen.queryByRole('button', { name: '⋯' })).not.toBeInTheDocument();
    expect(screen.queryByText('Exportar')).not.toBeInTheDocument();
  });

  it('abre y cierra el modal de búsqueda avanzada', async () => {
    const user = userEvent.setup();
    authState.user = FULL;
    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByRole('button', { name: /Búsqueda avanzada/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Búsqueda avanzada' });
    expect(dialog).toBeInTheDocument();
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/categories'));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/departments'));
    // Con ticket.view.all los filtros por solicitante/técnico/equipo son
    // utilizables, así que se cargan sus directorios.
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/users/assignable'));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/teams/assignable'));

    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('dialog', { name: 'Búsqueda avanzada' })).not.toBeInTheDocument();
  });

  it('no pide los directorios de búsqueda avanzada sin ticket.view.all', async () => {
    const user = userEvent.setup();
    authState.user = ADMIN; // sin ticket.view.all
    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByRole('button', { name: /Búsqueda avanzada/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Búsqueda avanzada' });
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/categories'));
    expect(api.get).not.toHaveBeenCalledWith('/api/users/assignable');
    expect(api.get).not.toHaveBeenCalledWith('/api/teams/assignable');
    // Los filtros que dependen de esos directorios no se ofrecen.
    expect(within(dialog).queryByLabelText('Solicitante')).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Técnico asignado')).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Equipo asignado')).not.toBeInTheDocument();
  });

  it('aplica filtros avanzados a la consulta', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByRole('button', { name: /Búsqueda avanzada/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Búsqueda avanzada' });

    await pickOption(user, within(dialog).getAllByRole('combobox')[0], 'En proceso');
    await user.click(within(dialog).getByRole('button', { name: 'Aplicar filtros' }));

    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('status=IN_PROGRESS')));

    const searchBtn = screen.getByRole('button', { name: /Búsqueda avanzada/ });
    expect(within(searchBtn).getByText('1')).toBeInTheDocument();
  });

  it('preselecciona los filtros avanzados desde la URL', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Tickets />, { route: '/app/tickets?status=PENDING&priority=HIGH' });
    await screen.findByText('TCK-000001');

    const searchBtn = screen.getByRole('button', { name: /Búsqueda avanzada/ });
    expect(within(searchBtn).getByText('2')).toBeInTheDocument();

    await user.click(searchBtn);
    const dialog = await screen.findByRole('dialog', { name: 'Búsqueda avanzada' });

    const combos = within(dialog).getAllByRole('combobox');
    // El control refleja la URL en su rótulo, no en un atributo `value`.
    expect(combos[0]).toHaveTextContent('Pendiente');
    expect(combos[1]).toHaveTextContent('Alta');
  });

  it('limpia los filtros avanzados aplicados', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Tickets />, { route: '/app/tickets?status=PENDING' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByRole('button', { name: /Búsqueda avanzada/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Búsqueda avanzada' });

    await user.click(within(dialog).getByRole('button', { name: 'Limpiar todo' }));

    await waitFor(() => {
      const calls = api.get.mock.calls.filter(([u]) => u.startsWith('/api/tickets?'));
      expect(calls.length).toBeGreaterThan(0);
      expect(calls[calls.length - 1][0]).not.toContain('status=');
    });
  });

  // `active=1` es el filtro que /api/tickets ya soporta para acotar a los
  // estados no terminales (buildConditions) y el que usa el acceso directo
  // "Críticos" del dashboard. Si parseFilters lo ignorara, la URL llegaría sin
  // efecto y la pantalla mostraría críticos ya resueltos o cerrados.
  it('reenvía el filtro active de la URL para acotar a los tickets activos', async () => {
    renderWithProviders(<Tickets />, { route: '/app/tickets?priority=CRITICAL&active=1' });
    await screen.findByText('TCK-000001');

    await waitFor(() => {
      const calls = api.get.mock.calls.filter(([u]) => u.startsWith('/api/tickets?'));
      expect(calls.length).toBeGreaterThan(0);
      const last = calls[calls.length - 1][0];
      expect(last).toContain('active=1');
      expect(last).toContain('priority=CRITICAL');
    });
  });

  it('no manda active cuando la URL no lo trae', async () => {
    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    await screen.findByText('TCK-000001');

    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.not.stringContaining('active')));
  });

  // Los paneles por categoría, por departamento y la fila de cada técnico del
  // dashboard apuntan aquí con estos mismos parámetros. Si parseFilters dejara
  // de leer alguno, el listado llegaría sin filtrar y su total no cuadraría con
  // la cifra del panel de origen.
  it.each([
    ['category', '/app/tickets?category=11&active=1'],
    ['department', '/app/tickets?department=4&active=1'],
    ['assigned', '/app/tickets?assigned=21&active=1'],
  ])('reenvía a la API el filtro %s que llega de la URL del dashboard', async (key, route) => {
    renderWithProviders(<Tickets />, { route });
    await screen.findByText('TCK-000001');

    await waitFor(() => {
      const calls = api.get.mock.calls.filter(([u]) => u.startsWith('/api/tickets?'));
      expect(calls.length).toBeGreaterThan(0);
      const last = calls[calls.length - 1][0];
      expect(last).toContain(`${key}=`);
      // El companion `active=1` debe viajar también: es lo que hace que el
      // listado cuadre con la cifra de "abiertos" que anuncia la fila.
      expect(last).toContain('active=1');
    });
  });

  it('acepta listas de valores en los filtros por id, como ya hacía la búsqueda avanzada', async () => {
    renderWithProviders(<Tickets />, { route: '/app/tickets?category=11,12&department=4&assigned=21,22' });
    await screen.findByText('TCK-000001');

    await waitFor(() => {
      const calls = api.get.mock.calls.filter(([u]) => u.startsWith('/api/tickets?'));
      const last = calls[calls.length - 1][0];
      expect(last).toContain('category=11%2C12');
      expect(last).toContain('department=4');
      expect(last).toContain('assigned=21%2C22');
    });
  });

  it('el botón Limpiar borra los filtros que llegaron de la URL', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Tickets />, { route: '/app/tickets?category=11&department=4&assigned=21&active=1' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByRole('button', { name: 'Limpiar' }));

    await waitFor(() => {
      const calls = api.get.mock.calls.filter(([u]) => u.startsWith('/api/tickets?'));
      const last = calls[calls.length - 1][0];
      expect(last).not.toContain('category=');
      expect(last).not.toContain('department=');
      expect(last).not.toContain('assigned=');
      expect(last).not.toContain('active=');
    });
  });

  // El botón atrás del navegador tiene que devolver al listado con SUS filtros,
  // no a una lista completa: los parámetros viajan en la URL, que es lo único
  // que sobrevive a un POP. Se comprueba la URL del enrutador y el chip que
  // queda marcado —no la llamada a la API— porque el listado ya cacheado puede
  // no volver a pedir los datos y eso no significaría que se perdió el filtro.
  it('el botón atrás y adelante del navegador conservan los filtros', async () => {
    const user = userEvent.setup();
    // Se usa un enrutador gobernable: el MemoryRouter de renderWithProviders
    // ignora window.history.back(), así que con él no se puede reproducir un
    // POP. `router.navigate(-1)` sí lo hace.
    const { history } = renderWithHistory(<Tickets />, { route: '/app/tickets', path: '/app/tickets' });
    await screen.findByText('TCK-000001');

    const search = () => new URLSearchParams(history.location.search);
    // queryByRole: algunos chips no se pintan según permisos, y getByRole
    // lanzaría dentro del .find() en vez de devolver false.
    const activeChip = () =>
      VIEWS.find((v) =>
        screen.queryByRole('button', { name: new RegExp(`^${v.label}`) })?.className.includes('bg-brand-600')
      )?.key;
    const go = async (delta) => {
      await act(async () => {
        history.go(delta);
      });
    };

    await user.click(screen.getByRole('button', { name: /^Abiertos/ }));
    await waitFor(() => expect(search().get('view')).toBe('open'));
    expect(activeChip()).toBe('open');

    await user.click(screen.getByRole('button', { name: /^Retrasados/ }));
    await waitFor(() => expect(search().get('view')).toBe('overdue'));
    expect(activeChip()).toBe('overdue');

    await user.click(screen.getByRole('button', { name: 'Limpiar' }));
    await waitFor(() => expect(history.location.search).toBe(''));
    expect(activeChip()).toBe('all');

    // Cada paso atrás devuelve a la consulta anterior, con sus filtros.
    await go(-1);
    expect(search().get('view')).toBe('overdue');
    expect(activeChip()).toBe('overdue');

    await go(-1);
    expect(search().get('view')).toBe('open');
    expect(activeChip()).toBe('open');

    await go(-1);
    expect(history.location.search).toBe('');
    expect(activeChip()).toBe('all');

    // Y adelante se deshace.
    await go(1);
    expect(search().get('view')).toBe('open');
    expect(activeChip()).toBe('open');
  });

  it('preserva los filtros de la URL al cambiar el orden y la página', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Tickets />, { route: '/app/tickets?category=11&assigned=21&active=1&sort=priority' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByTitle('Ordenar por'));
    await user.click(screen.getByRole('option', { name: 'Ordenar: Título' }));

    await waitFor(() => {
      const calls = api.get.mock.calls.filter(([u]) => u.startsWith('/api/tickets?'));
      const last = calls[calls.length - 1][0];
      expect(last).toContain('sort=title');
      // Los filtros de origen siguen ahí: reordenar no puede perderlos.
      expect(last).toContain('category=11');
      expect(last).toContain('assigned=21');
      expect(last).toContain('active=1');
    });
  });

  it('cancela un ticket con motivo y refresca el listado', async () => {

    const user = userEvent.setup();
    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    await screen.findByText('TCK-000001');

    const ticketCalls = () => api.get.mock.calls.filter(([u]) => u.startsWith('/api/tickets?')).length;
    const before = ticketCalls();

    await user.click(screen.getByRole('button', { name: '⋯' }));
    await user.click(await screen.findByRole('menuitem', { name: /Cancelar ticket/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Cancelar TCK-000001' });
    const submit = within(dialog).getByRole('button', { name: 'Cancelar ticket' });
    expect(submit).toBeDisabled();

    await user.type(within(dialog).getByLabelText(/Motivo de cancelación/), 'El usuario ya no lo necesita');
    await user.click(submit);

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/tickets/1/cancel', { reason: 'El usuario ya no lo necesita' }));
    await waitFor(() => expect(ticketCalls()).toBeGreaterThan(before));
    expect(screen.queryByRole('dialog', { name: 'Cancelar TCK-000001' })).not.toBeInTheDocument();
  });

  it('muestra el error global cuando la cancelación falla', async () => {
    api.post.mockRejectedValueOnce(new Error('Motivo rechazado'));

    const user = userEvent.setup();
    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByRole('button', { name: '⋯' }));
    await user.click(await screen.findByRole('menuitem', { name: /Cancelar ticket/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Cancelar TCK-000001' });
    await user.type(within(dialog).getByLabelText(/Motivo de cancelación/), 'Intento fallido');
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar ticket' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Motivo rechazado');
  });

  it('exporta en CSV con los filtros actuales', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByRole('button', { name: 'Exportar' }));
    await user.click(await screen.findByRole('menuitem', { name: 'CSV' }));

    expect(download).toHaveBeenCalledWith('/api/tickets/export?');
  });

  it('incluye los filtros y excluye la paginación en la exportación', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByRole('button', { name: /Abiertos/ }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('view=open')));

    await user.click(screen.getByRole('button', { name: 'Exportar' }));
    await user.click(await screen.findByRole('menuitem', { name: 'CSV' }));

    expect(download).toHaveBeenLastCalledWith(expect.stringContaining('view=open'));
    expect(download.mock.lastCall[0]).not.toContain('sort=');
    expect(download.mock.lastCall[0]).not.toContain('page=');
  });

  it('exporta en XLSX y PDF con el parámetro de formato', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByRole('button', { name: 'Exportar' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Excel (XLSX)' }));
    expect(download).toHaveBeenCalledWith(expect.stringContaining('format=xlsx'));

    await user.click(screen.getByRole('button', { name: 'Exportar' }));
    await user.click(await screen.findByRole('menuitem', { name: 'PDF' }));
    expect(download).toHaveBeenCalledWith(expect.stringContaining('format=pdf'));
  });

  it('muestra exportación sin acciones cuando solo hay permiso de exportar', async () => {
    authState.user = { id: 7, name: 'Usuario', permissions: ['ticket.export'] };

    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    await screen.findByText('TCK-000001');

    expect(screen.getByText('Exportar')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '⋯' })).not.toBeInTheDocument();
  });
});

// El backend rechaza PATCH con RESOLVED/CLOSED: el menú de fila debe usar los
// endpoints dedicados igual que la bandeja.
describe('Tickets · acciones de estado con los endpoints dedicados', () => {
  it('resuelve por /resolve indicando la solución', async () => {
    const user = userEvent.setup();
    authState.user = FULL;
    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByRole('button', { name: '⋯' }));
    await user.click(await screen.findByRole('menuitem', { name: /Marcar resuelto/ }));

    // No se llama al backend hasta recoger la solución obligatoria.
    expect(api.post).not.toHaveBeenCalled();
    await user.type(await screen.findByLabelText(/Solución \/ trabajo realizado/), 'Se reinició el router');
    await user.click(screen.getByRole('button', { name: 'Resolver 1 ticket(s)' }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/api/tickets/1/resolve', { resolution: 'Se reinició el router' })
    );
    expect(api.patch).not.toHaveBeenCalledWith('/api/tickets/1', { status: 'RESOLVED' });
  });

  it('cierra por /close y mantiene PATCH para "en proceso"', async () => {
    const user = userEvent.setup();
    authState.user = FULL;
    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByRole('button', { name: '⋯' }));
    await user.click(await screen.findByRole('menuitem', { name: /Marcar en proceso/ }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/tickets/1', { status: 'IN_PROGRESS' }));

    await user.click(screen.getByRole('button', { name: '⋯' }));
    await user.click(await screen.findByRole('menuitem', { name: /Cerrar ticket/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/tickets/1/close', {}));
  });

  it('sigue cancelando por /cancel con el motivo obligatorio', async () => {
    const user = userEvent.setup();
    authState.user = FULL;
    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByRole('button', { name: '⋯' }));
    await user.click(await screen.findByRole('menuitem', { name: /Cancelar ticket/ }));

    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Motivo de cancelación/), 'Duplicado');
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar ticket' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/tickets/1/cancel', { reason: 'Duplicado' }));
  });
});
// A1: la pantalla general comparte con la Bandeja la seleccion y las acciones
// masivas. La barra se monta sobre `useTicketBulk`, igual que alli, y respeta los
// mismos permisos reales que exige el backend.
describe('Tickets · acciones masivas', () => {
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
      if (url === '/api/categories') return Promise.resolve({ data: [] });
      if (url === '/api/departments') return Promise.resolve({ data: [] });
      if (url === '/api/users/assignable') {
        return Promise.resolve({ data: [{ id: 9, name: 'Beto', last_name: 'Gómez', department_name: 'TI' }] });
      }
      if (url === '/api/teams/assignable') return Promise.resolve({ data: [] });
      return Promise.reject(new Error('404'));
    });
  }

  it('selecciona y deselecciona tickets individuales', async () => {
    const user = userEvent.setup();
    authState.user = FULL;
    threeRows();
    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByLabelText('Seleccionar TCK-000001'));
    expect(screen.getByText('1 seleccionado(s)')).toBeInTheDocument();

    await user.click(screen.getByLabelText('Seleccionar TCK-000002'));
    expect(screen.getByText('2 seleccionado(s)')).toBeInTheDocument();

    await user.click(screen.getByLabelText('Seleccionar TCK-000001'));
    expect(screen.getByText('1 seleccionado(s)')).toBeInTheDocument();
  });

  it('selecciona y deselecciona todos los de la página', async () => {
    const user = userEvent.setup();
    authState.user = FULL;
    threeRows();
    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    await screen.findByText('TCK-000001');

    const master = screen.getByLabelText('Seleccionar todos los de la página');
    await user.click(master);
    expect(screen.getByText('3 seleccionado(s)')).toBeInTheDocument();

    await user.click(master);
    expect(screen.queryByText(/seleccionado\(s\)/)).not.toBeInTheDocument();
  });

  it('asigna en lote solo a los tickets seleccionados', async () => {
    const user = userEvent.setup();
    authState.user = FULL;
    threeRows();
    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByLabelText('Seleccionar TCK-000001'));
    await user.click(screen.getByLabelText('Seleccionar TCK-000002'));
    await user.click(await screen.findByRole('button', { name: /^Asignarme$/ }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/tickets/1', { assigned_to_id: 7 }));
    expect(api.patch).toHaveBeenCalledWith('/api/tickets/2', { assigned_to_id: 7 });
    expect(api.patch).not.toHaveBeenCalledWith('/api/tickets/3', { assigned_to_id: 7 });
  });

  it('cambia la prioridad en lote con el endpoint existente', async () => {
    const user = userEvent.setup();
    authState.user = FULL;
    threeRows();
    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByLabelText('Seleccionar TCK-000001'));
    await user.click(screen.getByLabelText('Seleccionar TCK-000003'));
    await user.click(await screen.findByRole('button', { name: 'Prioridad…' }));

    const dialog = await screen.findByRole('dialog');
    await pickOption(user, within(dialog).getByLabelText('Prioridad'), 'Crítica');
    await user.click(within(dialog).getByRole('button', { name: 'Aplicar prioridad' }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/tickets/1', { priority: 'CRITICAL' }));
    expect(api.patch).toHaveBeenCalledWith('/api/tickets/3', { priority: 'CRITICAL' });
    expect(api.patch).not.toHaveBeenCalledWith('/api/tickets/2', { priority: 'CRITICAL' });
  });

  it('resuelve en lote por /resolve con la solución obligatoria', async () => {
    const user = userEvent.setup();
    authState.user = FULL;
    threeRows();
    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByLabelText('Seleccionar todos los de la página'));
    await user.click(await screen.findByRole('button', { name: /^Resuelto$/ }));

    // Nada se envía hasta recoger la solución.
    expect(api.post).not.toHaveBeenCalled();
    await user.type(await screen.findByLabelText(/Solución \/ trabajo realizado/), 'Se cambió la fuente');
    await user.click(screen.getByRole('button', { name: 'Resolver 3 ticket(s)' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/tickets/1/resolve', { resolution: 'Se cambió la fuente' }));
    expect(api.post).toHaveBeenCalledWith('/api/tickets/2/resolve', { resolution: 'Se cambió la fuente' });
    expect(api.post).toHaveBeenCalledWith('/api/tickets/3/resolve', { resolution: 'Se cambió la fuente' });
  });

  it('cierra en lote por /close y no por PATCH', async () => {
    const user = userEvent.setup();
    authState.user = FULL;
    threeRows();
    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByLabelText('Seleccionar todos los de la página'));
    await user.click(await screen.findByRole('button', { name: /^Cerrar$/ }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/tickets/1/close', {}));
    expect(api.post).toHaveBeenCalledWith('/api/tickets/2/close', {});
    expect(api.patch).not.toHaveBeenCalledWith('/api/tickets/1', { status: 'CLOSED' });
  });

  it('omite las acciones que el usuario no puede ejecutar', async () => {
    const user = userEvent.setup();
    // Solo asignar: no hay update.any, ni resolve, ni close.
    authState.user = { id: 7, name: 'Asignador', permissions: ['ticket.assign'] };
    threeRows();
    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByLabelText('Seleccionar todos los de la página'));

    expect(await screen.findByRole('button', { name: /^Asignarme$/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^En proceso$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Resuelto$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Cerrar$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Prioridad…' })).not.toBeInTheDocument();
  });

  it('limpia la selección tras un lote correcto', async () => {
    const user = userEvent.setup();
    authState.user = FULL;
    threeRows();
    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByLabelText('Seleccionar todos los de la página'));
    await user.click(await screen.findByRole('button', { name: /^Cerrar$/ }));

    await waitFor(() => expect(screen.queryByText(/seleccionado\(s\)/)).not.toBeInTheDocument());
  });

  it('descarta la selección al cambiar de página', async () => {
    const user = userEvent.setup();
    authState.user = FULL;
    api.get.mockImplementation((url) => {
      if (url.startsWith('/api/tickets/counters')) return Promise.resolve(COUNTERS);
      if (url.startsWith('/api/tickets?')) return Promise.resolve(listResp([row()], 1, 2, 30));
      if (url === '/api/categories') return Promise.resolve({ data: [] });
      if (url === '/api/departments') return Promise.resolve({ data: [] });
      if (url === '/api/users/assignable') return Promise.resolve({ data: [] });
      if (url === '/api/teams/assignable') return Promise.resolve({ data: [] });
      return Promise.reject(new Error('404'));
    });

    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByLabelText('Seleccionar TCK-000001'));
    expect(screen.getByText('1 seleccionado(s)')).toBeInTheDocument();

    // Cambiar la paginación es la forma más segura de no arrastrar la selección
    // sobre tickets que el usuario ya no está viendo.
    await user.click(screen.getByRole('button', { name: /Siguiente/ }));

    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('page=2')));
    await waitFor(() => expect(screen.queryByText(/seleccionado\(s\)/)).not.toBeInTheDocument());
  });

  it('detalla qué ticket falló en un lote parcial', async () => {
    const user = userEvent.setup();
    authState.user = FULL;
    threeRows();
    api.post.mockImplementation((url) => {
      if (url === '/api/tickets/1/close') return Promise.reject(new Error('El ticket ya está cerrado'));
      if (url === '/api/tickets/2/close') return Promise.reject(new Error('No tiene permiso para cambiar el estado'));
      return Promise.resolve({});
    });

    renderWithProviders(<Tickets />, { route: '/app/tickets' });
    await screen.findByText('TCK-000001');

    await user.click(screen.getByLabelText('Seleccionar todos los de la página'));
    await user.click(await screen.findByRole('button', { name: /^Cerrar$/ }));

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('2 de 3 ticket(s) no se pudieron actualizar.')).toBeInTheDocument();
    expect(within(alert).getByText(/TCK-000001 — El ticket ya está cerrado/)).toBeInTheDocument();
    expect(within(alert).getByText(/TCK-000002 — No tiene permiso para cambiar el estado/)).toBeInTheDocument();
// El que sí se pudo cerrar no aparece entre los fallos.
    expect(within(alert).queryByText(/TCK-000003/)).not.toBeInTheDocument();
  });
});

describe('Tickets · el chip "Mi equipo" depende de la pertenencia a equipos', () => {
  // El history de pruebas es el único sitio donde se distingue un replace de un
  // push: `length` no crece con replace y sí con push.
  const searchOf = (history) => new URLSearchParams(history.location.search);

  function mockMembership(teams) {
    api.get.mockImplementation((url) => {
      if (url === '/api/teams/mine') return Promise.resolve({ data: teams });
      return defaultGet(url);
    });
  }

  function render(route) {
    return renderWithHistory(<Tickets />, { route, path: '/app/tickets' });
  }

  it('oculta "Mi equipo" cuando el usuario no pertenece a ningún equipo', async () => {
    mockMembership([]);
    render('/app/tickets');
    await screen.findByText('TCK-000001');

    await waitFor(() => expect(screen.queryByRole('button', { name: /^Mi equipo/ })).not.toBeInTheDocument());
    // Los demás chips siguen intactos.
    expect(screen.getByRole('button', { name: /^Asignados a mí/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Abiertos/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Retrasados/ })).toBeInTheDocument();
  });

  it('muestra "Mi equipo" cuando el usuario pertenece a al menos un equipo', async () => {
    mockMembership([{ id: 4, name: 'Soporte Nivel 1' }]);
    render('/app/tickets');
    await screen.findByText('TCK-000001');

    // Con equipo, el chip conserva su contador.
    const chip = await screen.findByRole('button', { name: /^Mi equipo/ });
    expect(await within(chip).findByText('4')).toBeInTheDocument();
  });

  it('muestra "Mi equipo" mientras se consulta y si la consulta falla', async () => {
    // Ante la duda se enseña: un fallo de red no significa que no tenga equipos.
    api.get.mockImplementation((url) => {
      if (url === '/api/teams/mine') return new Promise(() => {});
      return defaultGet(url);
    });
    const { unmount } = render('/app/tickets');
    await screen.findByText('TCK-000001');
    expect(screen.getByRole('button', { name: /^Mi equipo/ })).toBeInTheDocument();
    unmount();

    api.get.mockImplementation((url) => {
      if (url === '/api/teams/mine') return Promise.reject(new Error('500'));
      return defaultGet(url);
    });
    render('/app/tickets');
    await screen.findByText('TCK-000001');
    expect(screen.getByRole('button', { name: /^Mi equipo/ })).toBeInTheDocument();
  });

  it('con equipo, "Mi equipo" navega y filtra exactamente igual que antes', async () => {
    const user = userEvent.setup();
    mockMembership([{ id: 4, name: 'Soporte Nivel 1' }]);
    const { history } = render('/app/tickets');
    await screen.findByText('TCK-000001');

    await user.click(await screen.findByRole('button', { name: /^Mi equipo/ }));

    await waitFor(() => expect(searchOf(history).get('view')).toBe('my-teams'));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('view=my-teams')));
  });

  it('un ?view=my-teams sin equipos se corrige a "Todos" con replace', async () => {
    // Aquí la vista viaja en `view`, no en `tab` como en la Bandeja: por eso el
    // deep link inválido de esta pantalla es `?view=my-teams`.
    mockMembership([]);
    const { history } = render('/app/tickets?view=my-teams');
    await screen.findByText('TCK-000001');

    // Sin `view` en la URL queda "Todos", que es la vista predeterminada: la
    // pantalla nunca se queda sin chip marcado.
    await waitFor(() => expect(searchOf(history).get('view')).toBeNull());
    await waitFor(() => expect(screen.getByRole('button', { name: /^Todos/ }).className).toContain('bg-brand-600'));
    // Un replace no añade entrada al historial.
    expect(history.length).toBe(1);
    expect(screen.queryByRole('button', { name: /^Mi equipo/ })).not.toBeInTheDocument();
  });

  it('el botón atrás no devuelve a la vista inválida', async () => {
    mockMembership([]);
    const { history } = render('/app/tickets?view=my-teams');
    await screen.findByText('TCK-000001');
    await waitFor(() => expect(searchOf(history).get('view')).toBeNull());

    await act(async () => {
      history.go(-1);
    });

    // Con una sola entrada, el atrás no tiene a dónde ir: la URL válida se
    // mantiene en lugar de devolver el `view=my-teams` sin sentido.
    expect(history.index).toBe(0);
    expect(searchOf(history).get('view')).toBeNull();
    expect(screen.getByRole('button', { name: /^Todos/ }).className).toContain('bg-brand-600');
  });

  it('no corrige la URL mientras la consulta sigue en vuelo', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/api/teams/mine') return new Promise(() => {});
      return defaultGet(url);
    });
    const { history } = render('/app/tickets?view=my-teams');
    await screen.findByText('TCK-000001');

    expect(searchOf(history).get('view')).toBe('my-teams');
  });

  it('no corrige la URL si /api/teams/mine falla', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/api/teams/mine') return Promise.reject(new Error('500'));
      return defaultGet(url);
    });
    const { history } = render('/app/tickets?view=my-teams');
    await screen.findByText('TCK-000001');

    // Un fallo de red no significa "no tengo equipos": si se corrigiera, el
    // usuario perdería una vista a la que sí tiene derecho.
    expect(searchOf(history).get('view')).toBe('my-teams');
  });

  it('con equipo conserva el ?view=my-teams y no toca el historial', async () => {
    mockMembership([{ id: 4, name: 'Soporte Nivel 1' }]);
    const { history } = render('/app/tickets?view=my-teams');
    await screen.findByText('TCK-000001');

    expect(searchOf(history).get('view')).toBe('my-teams');
    expect(history.length).toBe(1);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('view=my-teams')));
  });

  it('no altera el PUSH normal al elegir otro chip a mano', async () => {
    const user = userEvent.setup();
    mockMembership([]);
    const { history } = render('/app/tickets');
    await screen.findByText('TCK-000001');
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Mi equipo/ })).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /^Retrasados/ }));
    await waitFor(() => expect(searchOf(history).get('view')).toBe('overdue'));

    // Elegir un chip sigue siendo una entrada más del historial.
    expect(history.length).toBe(2);
    await act(async () => {
      history.go(-1);
    });
    expect(searchOf(history).get('view')).toBeNull();
    expect(history.length).toBe(2);
  });
});
