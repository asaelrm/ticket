import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ResetPassword from './ResetPassword';
import { api, ApiError } from '../lib/api';
import { renderWithProviders } from '../test/utils';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual('../lib/api');
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  };
});

const TOKEN = 'tok-recuperacion-123';
const CLAVE = 'NuevaClave1';

const campoToken = () => screen.getByLabelText('Token de recuperación');
const campoClave = () => screen.getByLabelText('Nueva contraseña');
const campoConfirmar = () => screen.getByLabelText('Confirmar contraseña');

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
});

// El token llegaba por la query string y se conservaba solo en memoria. Al
// recargar, la página lo perdía y el formulario quedaba inservible sin forma
// de reintroducirlo: el enlace parecía roto.
describe('ResetPassword', () => {
  it('conserva el token al recargar la página', async () => {
    const user = userEvent.setup();
    const primera = renderWithProviders(<ResetPassword />, {
      route: `/reset-password?token=${TOKEN}`,
    });

    await waitFor(() => expect(campoToken()).toHaveValue(TOKEN));
    expect(sessionStorage.getItem('tf.resetToken')).toBe(TOKEN);

    // Recargar: se desmonta el componente y se vuelve a montar con la URL ya
    // limpia, que es exactamente lo que pasa al pulsar F5.
    primera.unmount();
    renderWithProviders(<ResetPassword />, { route: '/reset-password' });

    expect(campoToken()).toHaveValue(TOKEN);
  });

  it('quita el token de la URL al recogerlo', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ResetPassword />, { route: `/reset-password?token=${TOKEN}` });
    await waitFor(() => expect(campoToken()).toHaveValue(TOKEN));
    // Tras el efecto, la query string se limpia: el token no queda en el
    // historial del navegador ni se envía en la cabecera Referer.
    expect(sessionStorage.getItem('tf.resetToken')).toBe(TOKEN);
  });

  it('permite introducir el token a mano cuando no viene de la URL', async () => {
    api.post.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    renderWithProviders(<ResetPassword />, { route: '/reset-password' });

    expect(campoToken()).toHaveValue('');

    await user.type(campoToken(), 'pegado-a-mano');
    await user.type(campoClave(), CLAVE);
    await user.type(campoConfirmar(), CLAVE);
    await user.click(screen.getByRole('button', { name: /Restablecer contraseña/ }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/api/auth/reset-password', {
        token: 'pegado-a-mano',
        password: CLAVE,
      })
    );
  });

  it('exige un token antes de enviar nada', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ResetPassword />, { route: '/reset-password' });

    await user.type(campoClave(), CLAVE);
    await user.type(campoConfirmar(), CLAVE);
    await user.click(screen.getByRole('button', { name: /Restablecer contraseña/ }));

    expect(await screen.findByText('Falta el token de recuperación')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('descarta un token inválido o expirado y deja el campo listo', async () => {
    api.post.mockRejectedValue(new ApiError(400, 'Token inválido o expirado'));
    const user = userEvent.setup();
    renderWithProviders(<ResetPassword />, { route: `/reset-password?token=${TOKEN}` });
    await waitFor(() => expect(campoToken()).toHaveValue(TOKEN));

    await user.type(campoClave(), CLAVE);
    await user.type(campoConfirmar(), CLAVE);
    await user.click(screen.getByRole('button', { name: /Restablecer contraseña/ }));

    expect(await screen.findByText('Token inválido o expirado')).toBeInTheDocument();
    await waitFor(() => expect(campoToken()).toHaveValue(''));
    expect(sessionStorage.getItem('tf.resetToken')).toBeNull();
  });

  it('no descarta el token si el fallo es de validación de la contraseña', async () => {
    api.post.mockRejectedValue(
      new ApiError(400, 'Datos inválidos', { password: 'Demasiado corta' })
    );
    const user = userEvent.setup();
    renderWithProviders(<ResetPassword />, { route: `/reset-password?token=${TOKEN}` });
    await waitFor(() => expect(campoToken()).toHaveValue(TOKEN));

    await user.type(campoClave(), 'corta');
    await user.type(campoConfirmar(), 'corta');
    await user.click(screen.getByRole('button', { name: /Restablecer contraseña/ }));

    expect(await screen.findByText('Datos inválidos')).toBeInTheDocument();
    // El token sigue siendo válido: un error de la contraseña no lo invalida.
    expect(campoToken()).toHaveValue(TOKEN);
    expect(sessionStorage.getItem('tf.resetToken')).toBe(TOKEN);
  });

  it('restablece la contraseña y borra el token almacenado', async () => {
    api.post.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    renderWithProviders(<ResetPassword />, { route: `/reset-password?token=${TOKEN}` });
    await waitFor(() => expect(campoToken()).toHaveValue(TOKEN));

    await user.type(campoClave(), CLAVE);
    await user.type(campoConfirmar(), CLAVE);
    await user.click(screen.getByRole('button', { name: /Restablecer contraseña/ }));

    expect(
      await screen.findByText(/Su contraseña fue restablecida correctamente/)
    ).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith('/api/auth/reset-password', {
      token: TOKEN,
      password: CLAVE,
    });
    expect(sessionStorage.getItem('tf.resetToken')).toBeNull();
    expect(screen.getByRole('link', { name: /Ir al inicio de sesión/ })).toBeInTheDocument();
  });

  it('no deja el token en la URL tras un restablecimiento correcto', async () => {
    api.post.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    renderWithProviders(<ResetPassword />, { route: `/reset-password?token=${TOKEN}` });
    await waitFor(() => expect(campoToken()).toHaveValue(TOKEN));

    await user.type(campoClave(), CLAVE);
    await user.type(campoConfirmar(), CLAVE);
    await user.click(screen.getByRole('button', { name: /Restablecer contraseña/ }));

    await screen.findByText(/Su contraseña fue restablecida correctamente/);
    expect(sessionStorage.getItem('tf.resetToken')).toBeNull();
  });

  it('exige que las dos contraseñas coincidan', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ResetPassword />, { route: `/reset-password?token=${TOKEN}` });
    await waitFor(() => expect(campoToken()).toHaveValue(TOKEN));

    await user.type(campoClave(), CLAVE);
    await user.type(campoConfirmar(), 'OtraClave2');
    await user.click(screen.getByRole('button', { name: /Restablecer contraseña/ }));

    expect(await screen.findByText('Las contraseñas no coinciden')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('acepta que se pegue el enlace entero y no solo el token', async () => {
    const user = userEvent.setup();
    api.post.mockResolvedValue({ ok: true });
    renderWithProviders(<ResetPassword />, { route: '/reset-password' });
    await waitFor(() => expect(campoToken()).toHaveValue(''));

    // Es lo que hace la gente al leer "pegue aquí el enlace": si se enviara la
    // URL entera, el backend la rechazaría como token inválido.
    await user.type(campoToken(), 'http://localhost:5173/reset-password?token=tok-abc-123');
    await user.type(campoClave(), CLAVE);
    await user.type(campoConfirmar(), CLAVE);
    await user.click(screen.getByRole('button', { name: /Restablecer contraseña/ }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/api/auth/reset-password', {
        token: 'tok-abc-123',
        password: CLAVE,
      })
    );
  });

  it('no toca un token tecleado que lleva signos de más, barra y igual', async () => {
    const user = userEvent.setup();
    api.post.mockResolvedValue({ ok: true });
    renderWithProviders(<ResetPassword />, { route: '/reset-password' });
    await waitFor(() => expect(campoToken()).toHaveValue(''));

    await user.type(campoToken(), 'a+b/c=d');
    await user.type(campoClave(), CLAVE);
    await user.type(campoConfirmar(), CLAVE);
    await user.click(screen.getByRole('button', { name: /Restablecer contraseña/ }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/api/auth/reset-password', {
        token: 'a+b/c=d',
        password: CLAVE,
      })
    );
  });
});
