import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Roles from './Roles';
import { api } from '../lib/api';
import { AuthProvider } from '../context/AuthContext';
import { renderWithProviders } from '../test/utils';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual('../lib/api');
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  };
});

const PERMS = [
  { code: 'ticket.create', description: 'Crear tickets' },
  { code: 'ticket.view.own', description: 'Ver sus tickets' },
  { code: 'ticket.view.all', description: 'Ver todos los tickets' },
  { code: 'ticket.comment', description: 'Comentar tickets' },
  { code: 'ticket.assign', description: 'Asignar tickets' },
  { code: 'ticket.update.any', description: 'Actualizar cualquier ticket' },
  { code: 'ticket.reopen', description: 'Reabrir tickets' },
  { code: 'ticket.export', description: 'Exportar tickets' },
  { code: 'ticket.resolve', description: 'Resolver tickets' },
  { code: 'ticket.close', description: 'Cerrar tickets' },
  { code: 'ticket.note', description: 'Notas internas' },
  { code: 'user.view', description: 'Ver usuarios' },
  { code: 'user.manage', description: 'Gestionar usuarios' },
  { code: 'role.manage', description: 'Gestionar roles' },
  { code: 'category.manage', description: 'Gestionar categorías' },
  { code: 'department.manage', description: 'Gestionar departamentos' },
  { code: 'team.manage', description: 'Administrar equipos de trabajo' },
  { code: 'dashboard.view', description: 'Ver dashboard' },
  { code: 'report.view', description: 'Ver reportes' },
  { code: 'settings.manage', description: 'Gestionar ajustes' },
  { code: 'kb.view', description: 'Consultar artículos publicados de la base de conocimiento' },
  { code: 'kb.create', description: 'Crear y editar artículos propios' },
  { code: 'kb.publish', description: 'Publicar y archivar artículos propios' },
  { code: 'kb.manage', description: 'Administrar artículos y categorías de la base de conocimiento' },
];

const ALL_CODES = PERMS.map((p) => p.code);

const ROLES = [
  { id: 1, code: 'ADMIN', name: 'Administrador', description: 'Acceso total', users: 2, permissions: ALL_CODES },
  { id: 2, code: 'EMPLOYEE', name: 'Empleado', description: 'Acceso básico', users: 5, permissions: ['ticket.create', 'ticket.view.own', 'ticket.comment'] },
];

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockImplementation((url) => {
    if (url === '/api/roles') return Promise.resolve({ roles: ROLES });
    if (url === '/api/roles/permissions') return Promise.resolve({ permissions: PERMS });
    return Promise.reject(new Error(`404 ${url}`));
  });
});

function cardFor(name) {
  return screen.getByText(name).closest('.card');
}

describe('Roles', () => {
  it('muestra la pantalla de carga mientras la API responde', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/api/roles') return new Promise(() => {});
      if (url === '/api/roles/permissions') return Promise.resolve({ permissions: PERMS });
      return Promise.reject(new Error(`404 ${url}`));
    });

    renderWithProviders(<Roles />, { route: '/app/roles' });
    expect(screen.getByText('Cargando roles…')).toBeInTheDocument();
  });

  // `data` sólo se rellena si el Promise.all resuelve: un 500 en cualquiera de
  // las dos peticiones dejaba el `LoadingScreen` girando para siempre.
  describe('si falla la carga de los roles', () => {
    function fallaPorUrl(roto) {
      api.get.mockImplementation((url) => {
        if (url === roto) return Promise.reject(new Error('Error 500'));
        if (url === '/api/roles') return Promise.resolve({ roles: ROLES });
        if (url === '/api/roles/permissions') return Promise.resolve({ permissions: PERMS });
        return Promise.reject(new Error(`404 ${url}`));
      });
    }

    it.each(['/api/roles', '/api/roles/permissions'])(
      'muestra un ErrorBox y no el loading infinito cuando falla %s',
      async (roto) => {
        fallaPorUrl(roto);

        renderWithProviders(<Roles />, { route: '/app/roles' });

        expect(await screen.findByRole('alert')).toHaveTextContent('Error 500');
        expect(screen.queryByText('Cargando roles…')).not.toBeInTheDocument();
        // Sin datos no se pintan tarjetas de roles ni controles de permisos.
        expect(screen.queryByText('Administrador')).not.toBeInTheDocument();
        expect(screen.queryByText('Empleado')).not.toBeInTheDocument();
        expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
      }
    );

    it('vuelve a pedir los roles al pulsar Reintentar', async () => {
      const user = userEvent.setup();
      fallaPorUrl('/api/roles');

      renderWithProviders(<Roles />, { route: '/app/roles' });
      await screen.findByRole('alert');

      api.get.mockImplementation((url) => {
        if (url === '/api/roles') return Promise.resolve({ roles: ROLES });
        if (url === '/api/roles/permissions') return Promise.resolve({ permissions: PERMS });
        return Promise.reject(new Error(`404 ${url}`));
      });
      await user.click(screen.getByRole('button', { name: 'Reintentar' }));

      expect(await screen.findByText('Empleado')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('sigue permitiendo cambiar permisos una vez recuperada la carga', async () => {
      const user = userEvent.setup();
      let caido = true;
      api.get.mockImplementation((url) => {
        if (url === '/api/roles' && caido) return Promise.reject(new Error('Error 500'));
        if (url === '/api/roles') return Promise.resolve({ roles: ROLES });
        if (url === '/api/roles/permissions') return Promise.resolve({ permissions: PERMS });
        return Promise.reject(new Error(`404 ${url}`));
      });

      renderWithProviders(<Roles />, { route: '/app/roles' });
      await screen.findByRole('alert');

      caido = false;
      await user.click(screen.getByRole('button', { name: 'Reintentar' }));
      await screen.findByText('Empleado');

      // El manejo de mutaciones no se ha tocado: el toggle sigue funcionando.
      await user.click(within(cardFor('Empleado')).getByRole('checkbox', { name: 'Asignar tickets' }));

      await waitFor(() =>
        expect(api.patch).toHaveBeenCalledWith(
          '/api/roles/2/permissions',
          expect.objectContaining({ permissions: expect.arrayContaining(['ticket.assign']) })
        )
      );
    });
  });

  it('muestra los roles y la agrupación de permisos', async () => {
    renderWithProviders(<Roles />, { route: '/app/roles' });

    expect(await screen.findByText('Administrador')).toBeInTheDocument();
    expect(screen.getByText('Acceso total')).toBeInTheDocument();
    expect(screen.getByText('Empleado')).toBeInTheDocument();
    expect(screen.getByText('2 usuario(s)')).toBeInTheDocument();
    expect(screen.getByText('5 usuario(s)')).toBeInTheDocument();
    expect(screen.getAllByText('Tickets').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Crear tickets').length).toBe(2);
    expect(api.get).toHaveBeenCalledWith('/api/roles');
    expect(api.get).toHaveBeenCalledWith('/api/roles/permissions');
  });

  it('agrega un permiso individual a un rol', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Roles />, { route: '/app/roles' });
    await screen.findByText('Empleado');

    const employeeCard = cardFor('Empleado');
    await user.click(within(employeeCard).getByRole('checkbox', { name: 'Asignar tickets' }));

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(
        '/api/roles/2/permissions',
        expect.objectContaining({ permissions: expect.arrayContaining(['ticket.assign']) })
      )
    );
  });

  it('quita un permiso individual de un rol', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Roles />, { route: '/app/roles' });
    await screen.findByText('Empleado');

    const employeeCard = cardFor('Empleado');
    await user.click(within(employeeCard).getByRole('checkbox', { name: 'Comentar tickets' }));

    await waitFor(() => {
      const args = api.patch.mock.calls.find(([u]) => u === '/api/roles/2/permissions');
      expect(args).toBeDefined();
      expect(args[1].permissions).not.toContain('ticket.comment');
    });
  });

  it('marca todos los permisos de un grupo', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Roles />, { route: '/app/roles' });
    await screen.findByText('Empleado');

    const employeeCard = cardFor('Empleado');
    await user.click(within(employeeCard).getByRole('checkbox', { name: 'Tickets (todo)' }));

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(
        '/api/roles/2/permissions',
        expect.objectContaining({ permissions: expect.arrayContaining(['ticket.assign', 'ticket.export', 'ticket.update.any']) })
      )
    );
  });

  it('mantiene deshabilitados los permisos del rol Administrador', async () => {
    renderWithProviders(<Roles />, { route: '/app/roles' });
    await screen.findByText('Administrador');

    const adminCard = cardFor('Administrador');
    const code = within(adminCard).getByRole('checkbox', { name: 'Crear tickets' });
    const group = within(adminCard).getByRole('checkbox', { name: 'Tickets (todo)' });
    expect(code).toBeDisabled();
    expect(code).toBeChecked();
    expect(group).toBeDisabled();
    expect(group).toBeChecked();
  });

  it('refresca los roles tras actualizar un permiso', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Roles />, { route: '/app/roles' });
    await screen.findByText('Empleado');

    const rolesCalls = () => api.get.mock.calls.filter(([u]) => u === '/api/roles').length;
    const before = rolesCalls();

    const employeeCard = cardFor('Empleado');
    await user.click(within(employeeCard).getByRole('checkbox', { name: 'Asignar tickets' }));

    await waitFor(() => expect(rolesCalls()).toBeGreaterThan(before));
  });

  it('muestra el error al fallar la actualización de un permiso', async () => {
    api.patch.mockRejectedValueOnce(new Error('No se pudo actualizar el permiso'));

    const user = userEvent.setup();
    renderWithProviders(<Roles />, { route: '/app/roles' });
    await screen.findByText('Empleado');

    const employeeCard = cardFor('Empleado');
    await user.click(within(employeeCard).getByRole('checkbox', { name: 'Asignar tickets' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo actualizar el permiso');
  });

  it('expone la base de conocimiento y la gestión de equipos', async () => {
    renderWithProviders(<Roles />, { route: '/app/roles' });
    await screen.findByText('Empleado');

    expect(screen.getAllByText('Base de conocimiento').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Consultar artículos publicados de la base de conocimiento').length).toBe(2);
    expect(screen.getAllByText('Crear y editar artículos propios').length).toBe(2);
    expect(screen.getAllByText('Publicar y archivar artículos propios').length).toBe(2);
    expect(screen.getAllByText('Administrar artículos y categorías de la base de conocimiento').length).toBe(2);
    expect(screen.getAllByText('Administrar equipos de trabajo').length).toBe(2);
  });

  // La lista de permisos del backend y PERM_GROUPS están en archivos distintos:
  // si el seed añade un permiso y nadie lo agrupa, la casilla deja de existir y
  // ese permiso se vuelve inaccesible desde la UI sin avisar.
  it('agrupa en algún grupo todos los permisos que devuelve el backend', async () => {
    renderWithProviders(<Roles />, { route: '/app/roles' });
    await screen.findByText('Administrador');

    for (const perm of PERMS) {
      expect(screen.getAllByText(perm.description).length, `falta ${perm.code}`).toBe(2);
      // Si no estuviera en ningún grupo se pintaría el código en crudo.
      expect(screen.queryByText(perm.code)).not.toBeInTheDocument();
    }
  });

  it('activa y desactiva un permiso de conocimiento desde la interfaz', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Roles />, { route: '/app/roles' });
    await screen.findByText('Empleado');

    const employeeCard = cardFor('Empleado');
    await user.click(
      within(employeeCard).getByRole('checkbox', { name: 'Consultar artículos publicados de la base de conocimiento' })
    );

    await waitFor(() => {
      const args = api.patch.mock.calls.find(([u]) => u === '/api/roles/2/permissions');
      expect(args).toBeDefined();
      expect(args[1].permissions).toContain('kb.view');
    });
  });
});

// V2: la matriz de permisos (roles / role_permissions) no pertenece a ninguna
// organización, así que modificarla alcanza a todas las empresas. El backend ya
// devuelve 403 a los administradores de organización; aquí se comprueba que la
// interfaz no les ofrezca los controles y que sí los ofrezca al SUPERADMIN.
const ORG_ADMIN = {
  id: 10,
  username: 'admin_org_a',
  is_superadmin: false,
  organization_id: 7,
  permissions: ['role.manage', 'user.view'],
};
const SUPERADMIN = {
  id: 1,
  username: 'root',
  is_superadmin: true,
  organization_id: null,
  permissions: ['role.manage', 'organization.manage'],
};

function mockApiWith(user) {
  api.get.mockImplementation((url) => {
    if (url === '/api/auth/me') return Promise.resolve({ user });
    if (url === '/api/settings') return Promise.resolve({ data: {} });
    if (url === '/api/roles') return Promise.resolve({ roles: ROLES });
    if (url === '/api/roles/permissions') return Promise.resolve({ permissions: PERMS });
    return Promise.reject(new Error(`404 ${url}`));
  });
}

function renderWithAuth() {
  return renderWithProviders(<AuthProvider><Roles /></AuthProvider>, { route: '/app/roles' });
}

describe('Roles: la edición de la matriz global', () => {
  it('un administrador de organización la consulta en modo solo lectura', async () => {
    mockApiWith(ORG_ADMIN);
    renderWithAuth();

    expect(await screen.findByText('Empleado')).toBeInTheDocument();
    expect(screen.getByText(/Vista de solo lectura/i)).toBeInTheDocument();

    const boxes = screen.getAllByRole('checkbox');
    expect(boxes.length).toBeGreaterThan(0);
    for (const box of boxes) expect(box).toBeDisabled();

    fireEvent.click(within(cardFor('Empleado')).getByRole('checkbox', { name: 'Asignar tickets' }));
    await waitFor(() => expect(api.patch).not.toHaveBeenCalled());
  });

  it('sin sesión identificada la interfaz también queda en solo lectura', async () => {
    mockApiWith(null);
    renderWithAuth();

    expect(await screen.findByText('Empleado')).toBeInTheDocument();
    expect(screen.getByText(/Vista de solo lectura/i)).toBeInTheDocument();
    for (const box of screen.getAllByRole('checkbox')) expect(box).toBeDisabled();
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('el superadministrador sí ve los controles activos y edita', async () => {
    const user = userEvent.setup();
    mockApiWith(SUPERADMIN);
    renderWithAuth();

    expect(await screen.findByText('Empleado')).toBeInTheDocument();
    expect(screen.queryByText(/Vista de solo lectura/i)).not.toBeInTheDocument();

    const box = within(cardFor('Empleado')).getByRole('checkbox', { name: 'Asignar tickets' });
    expect(box).toBeEnabled();
    await user.click(box);

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(
        '/api/roles/2/permissions',
        expect.objectContaining({ permissions: expect.arrayContaining(['ticket.assign']) })
      )
    );
  });

  it('la lectura de roles y permisos sigue funcionando para el administrador de org', async () => {
    mockApiWith(ORG_ADMIN);
    renderWithAuth();

    expect(await screen.findByText('Administrador')).toBeInTheDocument();
    expect(screen.getByText('Acceso total')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/api/roles');
    expect(api.get).toHaveBeenCalledWith('/api/roles/permissions');
    // Los permisos se muestran completos, no recortados por el modo lectura.
    expect(screen.getAllByText('Crear tickets')).toHaveLength(2);
    expect(screen.getAllByText('Gestionar roles')).toHaveLength(2);
  });

  it('muestra el 403 del backend si de todas formas se intenta guardar', async () => {
    const user = userEvent.setup();
    api.patch.mockRejectedValueOnce(new Error('Solo un superadministrador puede realizar esta acción'));
    mockApiWith(SUPERADMIN);
    renderWithAuth();

    expect(await screen.findByText('Empleado')).toBeInTheDocument();
    await user.click(within(cardFor('Empleado')).getByRole('checkbox', { name: 'Asignar tickets' }));

    // La interfaz es sólo una cortesía: si el servidor rechaza, el motivo real
    // es el que se muestra, no un genérico.
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Solo un superadministrador puede realizar esta acción'
    );
  });
});