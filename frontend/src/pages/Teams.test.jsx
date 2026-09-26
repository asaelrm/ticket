import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Teams from './Teams';
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

const MANAGER = { id: 7, name: 'Admin', permissions: ['team.manage'] };

function team(overrides = {}) {
  return { id: 1, name: 'Soporte', description: 'Atención de incidencias', member_count: 2, open_tickets: 3, ...overrides };
}

function userRow(overrides = {}) {
  return {
    id: 2,
    name: 'Ada',
    last_name: 'Lovelace',
    position: 'Analista',
    department_name: 'TI',
    ...overrides,
  };
}

const TEAMS = [team(), team({ id: 2, name: 'Redes', description: '', member_count: 0, open_tickets: 0 })];
const USERS = [userRow(), userRow({ id: 3, name: 'Grace', last_name: 'Hopper', position: null, department_name: 'TI' })];

function setup(teams = TEAMS) {
  api.get.mockImplementation((url) => {
    if (url === '/api/teams') return Promise.resolve({ data: teams });
    if (url === '/api/users/assignable') return Promise.resolve({ data: USERS });
    if (url === '/api/teams/1') {
      return Promise.resolve({ team: TEAMS[0], members: [userRow()] });
    }
    return Promise.reject(new Error(`404 ${url}`));
  });
}

function teamCalls() {
  return api.get.mock.calls.filter(([u]) => u === '/api/teams').length;
}

function fieldFor(labelText, tag, scope) {
  const label = scope.getByText(labelText, { selector: 'label' });
  return label.closest('div').querySelector(tag);
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.user = MANAGER;
  api.post.mockResolvedValue({ team: team({ id: 9 }) });
  api.patch.mockResolvedValue({ team: team() });
  api.put.mockResolvedValue({ team: team(), members: [userRow(), userRow({ id: 3, name: 'Grace', last_name: 'Hopper' })] });
  api.del.mockResolvedValue({ ok: true });
  setup();
});

describe('Teams', () => {
  it('muestra la pantalla de carga mientras la API responde', () => {
    api.get.mockImplementation((url) => (url === '/api/teams' ? new Promise(() => {}) : Promise.reject(new Error('404'))));

    renderWithProviders(<Teams />, { route: '/app/teams' });
    expect(screen.getByText('Cargando equipos…')).toBeInTheDocument();
  });

  it('lista los equipos con su número de miembros y tickets abiertos', async () => {
    renderWithProviders(<Teams />, { route: '/app/teams' });

    expect(await screen.findByText('Soporte')).toBeInTheDocument();
    expect(screen.getByText('Redes')).toBeInTheDocument();
    expect(screen.getByText('Atención de incidencias')).toBeInTheDocument();
    expect(screen.getByText('Sin descripción')).toBeInTheDocument();
    expect(screen.getByText('2 equipo(s). Agrupe usuarios para asignar tickets a un equipo completo.')).toBeInTheDocument();
    expect(screen.getAllByText('miembro(s)').length).toBe(2);
    expect(screen.getAllByText('abiertos').length).toBe(2);
    expect(api.get).toHaveBeenCalledWith('/api/teams');
  });

  it('muestra el estado vacío cuando no hay equipos', async () => {
    setup([]);

    renderWithProviders(<Teams />, { route: '/app/teams' });
    expect(await screen.findByText('Sin equipos')).toBeInTheDocument();
    expect(screen.getByText('Cree el primer equipo de trabajo para organizar la atención.')).toBeInTheDocument();
  });

  it('crea un equipo y refresca el listado', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Teams />, { route: '/app/teams' });
    await screen.findByText('Soporte');

    const before = teamCalls();
    await user.click(screen.getByRole('button', { name: '+ Nuevo equipo' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nuevo equipo' });

    await user.type(fieldFor('Nombre *', 'input', within(dialog)), 'Mesa de ayuda');
    await user.type(fieldFor('Descripción', 'textarea', within(dialog)), 'Segunda línea');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/api/teams', { name: 'Mesa de ayuda', description: 'Segunda línea' })
    );
    await waitFor(() => expect(teamCalls()).toBeGreaterThan(before));
    expect(await screen.findByText('Equipo guardado')).toBeInTheDocument();
  });

  it('mantiene deshabilitado el guardado mientras el nombre está vacío', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Teams />, { route: '/app/teams' });
    await screen.findByText('Soporte');

    await user.click(screen.getByRole('button', { name: '+ Nuevo equipo' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nuevo equipo' });

    expect(within(dialog).getByRole('button', { name: 'Guardar' })).toBeDisabled();
    await user.type(fieldFor('Nombre *', 'input', within(dialog)), '   ');
    expect(within(dialog).getByRole('button', { name: 'Guardar' })).toBeDisabled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('edita un equipo existente', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Teams />, { route: '/app/teams' });
    await screen.findByText('Soporte');

    await user.click(screen.getAllByRole('button', { name: 'Editar' })[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Editar equipo' });

    const name = fieldFor('Nombre *', 'input', within(dialog));
    expect(name).toHaveValue('Soporte');
    await user.clear(name);
    await user.type(name, 'Soporte Nivel 1');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/teams/1', { name: 'Soporte Nivel 1', description: 'Atención de incidencias' }));
    expect(api.post).not.toHaveBeenCalled();
  });

  it('muestra el error al no poder guardar el equipo', async () => {
    api.post.mockRejectedValueOnce(new Error('Ya existe un equipo con ese nombre'));

    const user = userEvent.setup();
    renderWithProviders(<Teams />, { route: '/app/teams' });
    await screen.findByText('Soporte');

    await user.click(screen.getByRole('button', { name: '+ Nuevo equipo' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nuevo equipo' });
    await user.type(fieldFor('Nombre *', 'input', within(dialog)), 'Soporte');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Ya existe un equipo con ese nombre');
  });

  it('carga los miembros del equipo al abrir el modal', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Teams />, { route: '/app/teams' });
    await screen.findByText('Soporte');

    await user.click(screen.getAllByRole('button', { name: 'Miembros' })[0]);

    const dialog = await screen.findByRole('dialog', { name: 'Miembros de Soporte' });
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/teams/1'));
    expect(within(dialog).getByText('Ada Lovelace')).toBeInTheDocument();
    expect(within(dialog).getByText('Grace Hopper')).toBeInTheDocument();
    expect(within(dialog).getByRole('checkbox', { name: /Ada Lovelace/ })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: /Grace Hopper/ })).not.toBeChecked();
  });

  it('muestra el error si falla la carga de miembros', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/api/teams') return Promise.resolve({ data: TEAMS });
      if (url === '/api/users/assignable') return Promise.resolve({ data: USERS });
      if (url === '/api/teams/1') return Promise.reject(new Error('No se pudieron cargar los miembros'));
      return Promise.reject(new Error(`404 ${url}`));
    });

    const user = userEvent.setup();
    const { queryClient } = renderWithProviders(<Teams />, { route: '/app/teams' });
    await screen.findByText('Soporte');

    await user.click(screen.getAllByRole('button', { name: 'Miembros' })[0]);
    await screen.findByRole('dialog', { name: 'Miembros de Soporte' });
    await waitFor(() => expect(queryClient.getQueryState(['team-members', 1])?.status).toBe('error'));

    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudieron cargar los miembros');
  });

  it('usa un mensaje propio cuando el fallo de miembros no trae mensaje', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/api/teams') return Promise.resolve({ data: TEAMS });
      if (url === '/api/users/assignable') return Promise.resolve({ data: USERS });
      if (url === '/api/teams/1') return Promise.reject(new Error(''));
      return Promise.reject(new Error(`404 ${url}`));
    });

    const user = userEvent.setup();
    renderWithProviders(<Teams />, { route: '/app/teams' });
    await screen.findByText('Soporte');

    await user.click(screen.getAllByRole('button', { name: 'Miembros' })[0]);
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudieron cargar los miembros');
  });

  it('no deja seleccionados miembros de un equipo cuyo detalle falló', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/api/teams') return Promise.resolve({ data: TEAMS });
      if (url === '/api/users/assignable') return Promise.resolve({ data: USERS });
      if (url === '/api/teams/1') return Promise.reject(new Error('No se pudieron cargar los miembros'));
      return Promise.reject(new Error(`404 ${url}`));
    });

    const user = userEvent.setup();
    renderWithProviders(<Teams />, { route: '/app/teams' });
    await screen.findByText('Soporte');

    await user.click(screen.getAllByRole('button', { name: 'Miembros' })[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Miembros de Soporte' });
    await screen.findByRole('alert');

    expect(within(dialog).getByRole('checkbox', { name: /Ada Lovelace/ })).not.toBeChecked();
  });

  it('agrega y quita miembros del equipo', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Teams />, { route: '/app/teams' });
    await screen.findByText('Soporte');

    await user.click(screen.getAllByRole('button', { name: 'Miembros' })[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Miembros de Soporte' });
    await waitFor(() => expect(within(dialog).getByRole('checkbox', { name: /Ada Lovelace/ })).toBeChecked());

    await user.click(within(dialog).getByRole('checkbox', { name: /Ada Lovelace/ }));
    await user.click(within(dialog).getByRole('checkbox', { name: /Grace Hopper/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Guardar miembros' }));

    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/api/teams/1/members', { user_ids: [3] }));
    expect(await screen.findByText('Miembros actualizados')).toBeInTheDocument();
  });

  it('envía la lista completa de miembros al guardar', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Teams />, { route: '/app/teams' });
    await screen.findByText('Soporte');

    await user.click(screen.getAllByRole('button', { name: 'Miembros' })[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Miembros de Soporte' });
    await waitFor(() => expect(within(dialog).getByRole('checkbox', { name: /Ada Lovelace/ })).toBeChecked());

    await user.click(within(dialog).getByRole('checkbox', { name: /Grace Hopper/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Guardar miembros' }));

    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/api/teams/1/members', { user_ids: [2, 3] }));
  });

  it('muestra el error al no poder guardar los miembros', async () => {
    api.put.mockRejectedValueOnce(new Error('No se pudieron guardar los miembros'));

    const user = userEvent.setup();
    renderWithProviders(<Teams />, { route: '/app/teams' });
    await screen.findByText('Soporte');

    await user.click(screen.getAllByRole('button', { name: 'Miembros' })[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Miembros de Soporte' });
    await waitFor(() => expect(within(dialog).getByRole('checkbox', { name: /Ada Lovelace/ })).toBeChecked());
    await user.click(within(dialog).getByRole('button', { name: 'Guardar miembros' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudieron guardar los miembros');
  });

  it('elimina un equipo con la confirmación', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Teams />, { route: '/app/teams' });
    await screen.findByText('Soporte');

    const before = teamCalls();
    await user.click(screen.getAllByRole('button', { name: 'Eliminar' })[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Eliminar equipo' });
    expect(within(dialog).getByText(/Los tickets asignados quedarán sin equipo/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Eliminar' }));

    await waitFor(() => expect(api.del).toHaveBeenCalledWith('/api/teams/1'));
    await waitFor(() => expect(teamCalls()).toBeGreaterThan(before));
    expect(await screen.findByText('Equipo eliminado')).toBeInTheDocument();
  });

  it('cancela la eliminación sin llamar a la API', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Teams />, { route: '/app/teams' });
    await screen.findByText('Soporte');

    await user.click(screen.getAllByRole('button', { name: 'Eliminar' })[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Eliminar equipo' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Eliminar equipo' })).not.toBeInTheDocument());
    expect(api.del).not.toHaveBeenCalled();
  });

  it('muestra el error al no poder eliminar el equipo', async () => {
    api.del.mockRejectedValueOnce(new Error('No se pudo eliminar el equipo'));

    const user = userEvent.setup();
    renderWithProviders(<Teams />, { route: '/app/teams' });
    await screen.findByText('Soporte');

    await user.click(screen.getAllByRole('button', { name: 'Eliminar' })[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Eliminar equipo' });
    await user.click(within(dialog).getByRole('button', { name: 'Eliminar' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo eliminar el equipo');
  });

  it('oculta las acciones de gestión sin el permiso team.manage', async () => {
    authState.user = { id: 9, name: 'Empleado', permissions: ['ticket.view.all'] };

    renderWithProviders(<Teams />, { route: '/app/teams' });
    await screen.findByText('Soporte');

    expect(screen.queryByRole('button', { name: '+ Nuevo equipo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Editar' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Eliminar' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Miembros' }).length).toBe(2);
  });

  it('permite consultar miembros pero no guardarlos sin el permiso team.manage', async () => {
    authState.user = { id: 9, name: 'Empleado', permissions: ['ticket.view.all'] };

    const user = userEvent.setup();
    renderWithProviders(<Teams />, { route: '/app/teams' });
    await screen.findByText('Soporte');

    await user.click(screen.getAllByRole('button', { name: 'Miembros' })[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Miembros de Soporte' });
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/teams/1'));

    expect(within(dialog).queryByRole('button', { name: 'Guardar miembros' })).not.toBeInTheDocument();
    expect(within(dialog).getByText('Cerrar', { selector: 'button' })).toBeInTheDocument();
  });
});
