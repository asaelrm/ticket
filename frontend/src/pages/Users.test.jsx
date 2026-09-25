import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Users from './Users';
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

const ROLES = [
  { id: 1, code: 'ADMIN', name: 'Administrador' },
  { id: 3, code: 'EMPLOYEE', name: 'Empleado' },
];

const DEPARTMENTS = { data: [{ id: 1, name: 'TI' }] };

function userRow(overrides = {}) {
  return {
    id: 2,
    name: 'Ada',
    last_name: 'Lovelace',
    username: 'alovelace',
    email: 'ada@example.com',
    position: 'Analista',
    department_id: 1,
    department_name: 'TI',
    role_id: 3,
    role_name: 'Empleado',
    last_login_at: '2026-09-01T10:00:00Z',
    active: true,
    ...overrides,
  };
}

function listResp(rows = [userRow()], page = 1, pages = 1, total = rows.length) {
  return { data: rows, total, page, pages, perPage: 15 };
}

const ADMIN = { id: 7, name: 'Admin', permissions: ['user.manage', 'user.view'] };

const HISTORY = {
  data: [{ id: 9, ticket_number: 'TCK-000009', title: 'Impresora no imprime', status: 'OPEN', priority: 'HIGH', category_name: 'Hardware', category_color: '#64748b', created_at: '2026-09-10T08:00:00Z', is_overdue: false }],
  total: 1,
  page: 1,
  pages: 1,
  by_status: { OPEN: 1, CLOSED: 0 },
};

beforeEach(() => {
  vi.clearAllMocks();
  authState.user = ADMIN;
  api.get.mockImplementation((url) => {
    if (url.startsWith('/api/users?page=')) return Promise.resolve(listResp());
    if (url === '/api/users/roles') return Promise.resolve({ roles: ROLES });
    if (url === '/api/departments?active=1') return Promise.resolve(DEPARTMENTS);
    if (url.startsWith('/api/users/2/tickets?')) return Promise.resolve(HISTORY);
    return Promise.reject(new Error(`404 ${url}`));
  });
});

function inputFor(labelText, scope = screen) {
  const label = scope.getByText(labelText, { selector: 'label' });
  return label.closest('div').querySelector('input');
}

function selectFor(labelText, scope = screen) {
  const label = scope.getByText(labelText, { selector: 'label' });
  return label.closest('div').querySelector('select');
}

describe('Users', () => {
  it('muestra la pantalla de carga mientras la API responde', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/api/users/roles') return Promise.resolve({ roles: ROLES });
      if (url === '/api/departments?active=1') return Promise.resolve(DEPARTMENTS);
      if (url.startsWith('/api/users?page=')) return new Promise(() => {});
      return Promise.reject(new Error(`404 ${url}`));
    });

    renderWithProviders(<Users />, { route: '/app/users' });
    expect(screen.getByText('Cargando…')).toBeInTheDocument();
  });

  it('muestra el error de carga del listado', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/api/users/roles') return Promise.resolve({ roles: ROLES });
      if (url === '/api/departments?active=1') return Promise.resolve(DEPARTMENTS);
      if (url.startsWith('/api/users?page=')) return Promise.reject(new Error('Error al cargar usuarios'));
      return Promise.reject(new Error(`404 ${url}`));
    });

    renderWithProviders(<Users />, { route: '/app/users' });
    expect(await screen.findByRole('alert')).toHaveTextContent('Error al cargar usuarios');
  });

  it('muestra los usuarios del listado', async () => {
    renderWithProviders(<Users />, { route: '/app/users' });

    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('alovelace')).toBeInTheDocument();
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
    expect(screen.getByText('TI')).toBeInTheDocument();
    expect(screen.getByText('Empleado')).toBeInTheDocument();
    expect(screen.getByText('Analista')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/api/users?page=1&perPage=15');
    expect(api.get).toHaveBeenCalledWith('/api/users/roles');
  });

  it('busca usuarios por texto', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Users />, { route: '/app/users' });
    await screen.findByText('Ada Lovelace');

    await user.type(screen.getByPlaceholderText('Buscar por nombre, usuario o correo…'), 'lovelace');

    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('search=lovelace')));
  });

  it('filtra por departamento', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Users />, { route: '/app/users' });
    await screen.findByText('Ada Lovelace');

    await user.selectOptions(screen.getAllByRole('combobox')[0], '1');

    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('department=1')));
  });

  it('pagina a la siguiente página', async () => {
    api.get.mockImplementation((url) => {
      if (url.startsWith('/api/users?page=')) return Promise.resolve(listResp([userRow()], 1, 2, 20));
      if (url === '/api/users/roles') return Promise.resolve({ roles: ROLES });
      if (url === '/api/departments?active=1') return Promise.resolve(DEPARTMENTS);
      return Promise.reject(new Error(`404 ${url}`));
    });

    const user = userEvent.setup();
    renderWithProviders(<Users />, { route: '/app/users' });
    await screen.findByText('Ada Lovelace');

    await user.click(screen.getByRole('button', { name: /Siguiente/ }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('page=2')));
  });

  it('crea un usuario nuevo y refresca el listado', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Users />, { route: '/app/users' });
    await screen.findByText('Ada Lovelace');

    await user.click(screen.getByRole('button', { name: '+ Nuevo usuario' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nuevo usuario' });

    await user.type(inputFor('Nombre *', within(dialog)), 'Grace');
    await user.type(inputFor('Apellidos *', within(dialog)), 'Hopper');
    await user.type(inputFor('Usuario *', within(dialog)), 'ghopper');
    await user.type(inputFor('Correo *', within(dialog)), 'grace@example.com');
    await user.type(inputFor('Cargo', within(dialog)), 'Ingeniera');
    await user.selectOptions(selectFor('Departamento', within(dialog)), '1');
    await user.type(inputFor('Contraseña inicial *', within(dialog)), 'secret1');
    await user.click(within(dialog).getByRole('button', { name: 'Crear usuario' }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/api/users', expect.objectContaining({
        username: 'ghopper',
        password: 'secret1',
        name: 'Grace',
        role_id: 3,
        department_id: '1',
      }))
    );
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Nuevo usuario' })).not.toBeInTheDocument());
  });

  it('requiere contraseña al crear un usuario', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Users />, { route: '/app/users' });
    await screen.findByText('Ada Lovelace');

    await user.click(screen.getByRole('button', { name: '+ Nuevo usuario' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nuevo usuario' });

    await user.type(inputFor('Nombre *', within(dialog)), 'Grace');
    await user.type(inputFor('Usuario *', within(dialog)), 'ghopper');
    await user.click(within(dialog).getByRole('button', { name: 'Crear usuario' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('La contraseña es obligatoria');
    expect(api.post).not.toHaveBeenCalled();
  });

  it('edita un usuario existente', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Users />, { route: '/app/users' });
    await screen.findByText('Ada Lovelace');

    await user.click(screen.getByRole('button', { name: 'Editar' }));
    const dialog = await screen.findByRole('dialog', { name: 'Editar usuario' });

    const nameInput = inputFor('Nombre *', within(dialog));
    expect(nameInput).toHaveValue('Ada');
    await user.clear(nameInput);
    await user.type(nameInput, 'Ada María');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar cambios' }));

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/api/users/2', expect.objectContaining({ name: 'Ada María', role_id: '3' }))
    );
  });

  it('desactiva un usuario con el interruptor', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Users />, { route: '/app/users' });
    await screen.findByText('Ada Lovelace');

    await user.click(screen.getByRole('switch', { name: 'estado de alovelace' }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/users/2/status', { active: false }));
  });

  it('bloquea desactivar la propia cuenta', async () => {
    api.get.mockImplementation((url) => {
      if (url.startsWith('/api/users?page=')) return Promise.resolve(listResp([userRow({ id: 7, username: 'yo', name: 'Admin', last_name: 'Sistema', email: 'admin@example.com' })]));
      if (url === '/api/users/roles') return Promise.resolve({ roles: ROLES });
      if (url === '/api/departments?active=1') return Promise.resolve(DEPARTMENTS);
      return Promise.reject(new Error(`404 ${url}`));
    });

    const user = userEvent.setup();
    renderWithProviders(<Users />, { route: '/app/users' });
    await screen.findByText('Admin Sistema');

    await user.click(screen.getByRole('switch', { name: 'estado de yo' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('No puede desactivar su propia cuenta');
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('genera un token de restablecimiento de contraseña', async () => {
    api.post.mockResolvedValue({ token: 'tok-abc-123', expires: '2026-10-01T00:00:00Z' });

    const user = userEvent.setup();
    renderWithProviders(<Users />, { route: '/app/users' });
    await screen.findByText('Ada Lovelace');

    await user.click(screen.getByTitle('Restablecer contraseña'));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/users/2/reset-password', {}));
    expect(await screen.findByRole('dialog', { name: 'Restablecer contraseña' })).toBeInTheDocument();
    expect(await screen.findByText('tok-abc-123')).toBeInTheDocument();
  });

  it('abre el historial de tickets del usuario', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Users />, { route: '/app/users' });
    await screen.findByText('Ada Lovelace');

    await user.click(screen.getByRole('button', { name: 'Historial' }));

    expect(await screen.findByRole('dialog', { name: 'Historial de Ada Lovelace' })).toBeInTheDocument();
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/users/2/tickets?scope=reported&page=1&perPage=8'));
    expect(await screen.findByText('TCK-000009')).toBeInTheDocument();
    expect(screen.getByText('Impresora no imprime')).toBeInTheDocument();
  });

  it('oculta acciones de gestión sin el permiso user.manage', async () => {
    authState.user = { id: 7, name: 'Usuario', permissions: [] };

    renderWithProviders(<Users />, { route: '/app/users' });
    await screen.findByText('Ada Lovelace');

    expect(screen.queryByRole('button', { name: '+ Nuevo usuario' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Editar' })).not.toBeInTheDocument();
    expect(screen.queryByTitle('Restablecer contraseña')).not.toBeInTheDocument();
  });

  it('muestra el estado vacío cuando no hay usuarios', async () => {
    api.get.mockImplementation((url) => {
      if (url.startsWith('/api/users?page=')) return Promise.resolve(listResp([]));
      if (url === '/api/users/roles') return Promise.resolve({ roles: ROLES });
      if (url === '/api/departments?active=1') return Promise.resolve(DEPARTMENTS);
      return Promise.reject(new Error(`404 ${url}`));
    });

    renderWithProviders(<Users />, { route: '/app/users' });
    expect(await screen.findByText('Sin usuarios')).toBeInTheDocument();
  });
});