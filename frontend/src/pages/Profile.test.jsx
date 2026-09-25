import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Profile from './Profile';
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

const ME = {
  id: 7,
  name: 'Ada',
  last_name: 'Lovelace',
  username: 'alovelace',
  email: 'ada@acme.com',
  role_name: 'Administrador',
  department_name: 'TI',
  position: 'Jefa de soporte',
  last_login_at: '2026-09-20T08:30:00Z',
  permissions: ['ticket.create'],
};

const HISTORY = {
  data: [{ id: 11, ticket_number: 'TCK-000011', title: 'PC no enciende', status: 'OPEN', priority: 'HIGH', category_name: 'Hardware', category_color: '#64748b', created_at: '2026-09-20T10:00:00Z', sla_due_at: '2099-01-01T00:00:00Z', is_overdue: false }],
  total: 1,
  page: 1,
  pages: 1,
  by_status: { OPEN: 1 },
};

const HISTORY_URL = '/api/users/7/tickets?scope=reported&page=1&perPage=8';

beforeEach(() => {
  vi.resetAllMocks();
  authState.user = ME;
  api.get.mockImplementation((url) => {
    if (url === HISTORY_URL) return Promise.resolve(HISTORY);
    return Promise.reject(new Error(`404 ${url}`));
  });
  api.post.mockResolvedValue({ ok: true });
});

function passwordField(label) {
  return screen.getByLabelText(label);
}

describe('Profile', () => {
  it('muestra los datos del usuario del contexto', async () => {
    renderWithProviders(<Profile />, { route: '/app/profile' });

    expect(await screen.findByRole('heading', { name: 'Ada Lovelace' })).toBeInTheDocument();
    expect(screen.getByText('AL')).toBeInTheDocument();
    expect(screen.getByText(/alovelace/)).toBeInTheDocument();
    expect(screen.getByText(/ada@acme\.com/)).toBeInTheDocument();
    expect(screen.getByText(/Administrador · TI · Jefa de soporte/)).toBeInTheDocument();
    expect(screen.getByText(/Último acceso:/)).toBeInTheDocument();
  });

  it('omite el departamento y el cargo cuando el usuario no los tiene', async () => {
    authState.user = { ...ME, department_name: null, position: null };

    renderWithProviders(<Profile />, { route: '/app/profile' });
    expect(await screen.findByRole('heading', { name: 'Ada Lovelace' })).toBeInTheDocument();
    expect(screen.getByText('Administrador')).toBeInTheDocument();
  });

  it('muestra un guion cuando el usuario nunca ha iniciado sesión', async () => {
    authState.user = { ...ME, last_login_at: null };

    renderWithProviders(<Profile />, { route: '/app/profile' });
    expect(await screen.findByText(/Último acceso:/)).toHaveTextContent('Último acceso: —');
  });

  it('embebe el historial de tickets del propio usuario', async () => {
    renderWithProviders(<Profile />, { route: '/app/profile' });

    expect(await screen.findByText('Historial de tickets')).toBeInTheDocument();
    expect(screen.getByText('Sus tickets reportados y los asignados a usted.')).toBeInTheDocument();
    expect(await screen.findByText('TCK-000011')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith(HISTORY_URL);
    expect(screen.getByRole('button', { name: 'Reportados por mí' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Asignados a mí' })).toBeInTheDocument();
  });

  it('cambia a los tickets asignados del propio usuario', async () => {
    const user = userEvent.setup();
    api.get.mockImplementation((url) => {
      if (url === '/api/users/7/tickets?scope=assigned&page=1&perPage=8') {
        return Promise.resolve({ ...HISTORY, data: [{ ...HISTORY.data[0], id: 12, title: 'Ticket asignado' }] });
      }
      if (url === HISTORY_URL) return Promise.resolve(HISTORY);
      return Promise.reject(new Error(`404 ${url}`));
    });

    renderWithProviders(<Profile />, { route: '/app/profile' });
    await screen.findByText('TCK-000011');

    await user.click(screen.getByRole('button', { name: 'Asignados a mí' }));

    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/users/7/tickets?scope=assigned&page=1&perPage=8'));
    expect(await screen.findByText('Ticket asignado')).toBeInTheDocument();
  });

  it('cambia la contraseña y limpia los campos', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Profile />, { route: '/app/profile' });
    await screen.findByText('Cambiar contraseña');

    await user.type(passwordField('Contraseña actual'), 'vieja123');
    await user.type(passwordField('Nueva contraseña'), 'nueva123');
    await user.type(passwordField('Confirmar nueva'), 'nueva123');
    await user.click(screen.getByRole('button', { name: 'Actualizar contraseña' }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/api/auth/change-password', {
        current_password: 'vieja123',
        new_password: 'nueva123',
      })
    );
    expect(await screen.findByText('Contraseña actualizada correctamente.')).toBeInTheDocument();
    expect(passwordField('Contraseña actual')).toHaveValue('');
    expect(passwordField('Nueva contraseña')).toHaveValue('');
    expect(passwordField('Confirmar nueva')).toHaveValue('');
  });

  it('rechaza el envío si las contraseñas nuevas no coinciden', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Profile />, { route: '/app/profile' });
    await screen.findByText('Cambiar contraseña');

    await user.type(passwordField('Contraseña actual'), 'vieja123');
    await user.type(passwordField('Nueva contraseña'), 'nueva123');
    await user.type(passwordField('Confirmar nueva'), 'otra123');
    await user.click(screen.getByRole('button', { name: 'Actualizar contraseña' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Las contraseñas no coinciden');
    expect(api.post).not.toHaveBeenCalled();
  });

  it('el aviso de longitud mínima acompaña al formulario', async () => {
    renderWithProviders(<Profile />, { route: '/app/profile' });
    expect(await screen.findByText('Mínimo 6 caracteres.')).toBeInTheDocument();
  });

  it('muestra el error de la API al cambiar la contraseña y conserva lo escrito', async () => {
    api.post.mockRejectedValueOnce(new Error('La contraseña actual no es correcta'));

    const user = userEvent.setup();
    renderWithProviders(<Profile />, { route: '/app/profile' });
    await screen.findByText('Cambiar contraseña');

    await user.type(passwordField('Contraseña actual'), 'vieja123');
    await user.type(passwordField('Nueva contraseña'), 'nueva123');
    await user.type(passwordField('Confirmar nueva'), 'nueva123');
    await user.click(screen.getByRole('button', { name: 'Actualizar contraseña' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('La contraseña actual no es correcta');
    expect(passwordField('Nueva contraseña')).toHaveValue('nueva123');
    expect(screen.getByRole('button', { name: 'Actualizar contraseña' })).toBeEnabled();
  });

  it('descarta el mensaje de éxito al reenviar con datos distintos', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Profile />, { route: '/app/profile' });
    await screen.findByText('Cambiar contraseña');

    await user.type(passwordField('Contraseña actual'), 'vieja123');
    await user.type(passwordField('Nueva contraseña'), 'nueva123');
    await user.type(passwordField('Confirmar nueva'), 'nueva123');
    await user.click(screen.getByRole('button', { name: 'Actualizar contraseña' }));
    expect(await screen.findByText('Contraseña actualizada correctamente.')).toBeInTheDocument();

    api.post.mockRejectedValueOnce(new Error('La contraseña actual no es correcta'));
    await user.type(passwordField('Contraseña actual'), 'otra123');
    await user.click(screen.getByRole('button', { name: 'Actualizar contraseña' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('La contraseña actual no es correcta');
    expect(screen.queryByText('Contraseña actualizada correctamente.')).not.toBeInTheDocument();
  });

  it('muestra el error si falla la carga del historial', async () => {
    api.get.mockImplementation((url) => (url === HISTORY_URL ? Promise.reject(new Error('No se pudo cargar el historial')) : Promise.reject(new Error('404'))));

    renderWithProviders(<Profile />, { route: '/app/profile' });
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo cargar el historial');
  });

  it('no ofrece campos editables para el nombre, el usuario ni el correo', async () => {
    renderWithProviders(<Profile />, { route: '/app/profile' });
    await screen.findByText('Cambiar contraseña');

    const form = screen.getByRole('button', { name: 'Actualizar contraseña' }).closest('form');
    expect(within(form).getByLabelText('Contraseña actual')).toBeInTheDocument();
    expect(within(form).getByLabelText('Nueva contraseña')).toBeInTheDocument();
    expect(within(form).getByLabelText('Confirmar nueva')).toBeInTheDocument();
    expect(within(form).getAllByRole('textbox').length).toBe(0);
    expect(within(form).getAllByRole('button').length).toBe(1);
  });
});
