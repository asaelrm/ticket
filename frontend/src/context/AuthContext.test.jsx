import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { waitFor, renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './AuthContext';
import { api } from '../lib/api';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual('../lib/api');
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

const ADMIN = { id: 1, name: 'Admin', permissions: ['ticket.view.all', 'user.manage', 'audit.view'] };
const EMPLEADO = { id: 2, name: 'Ana', permissions: ['ticket.create', 'ticket.view.own'] };

function wrapperFor(client) {
  return function Wrapper({ children }) {
    return (
      <QueryClientProvider client={client}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
  };
}

function renderAuth(client) {
  return renderHook(() => useAuth(), { wrapper: wrapperFor(client) });
}

let client;

beforeEach(() => {
  vi.clearAllMocks();
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, refetchOnWindowFocus: false } },
  });
  api.get.mockImplementation((path) => {
    if (path === '/api/auth/me') return Promise.resolve({ user: null });
    if (path === '/api/settings') return Promise.resolve({ data: { app_name: 'Ticket' } });
    return Promise.reject(new Error(`404 ${path}`));
  });
  api.post.mockResolvedValue({ ok: true });
});

describe('Aislamiento de caché entre sesiones', () => {
  it('la carga inicial no deja datos de una sesión anterior', async () => {
    const { result } = renderAuth(client);
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Sesión de un administrador: sus consultas quedan cacheadas.
    client.setQueryData(['users', {}], [{ id: 1, name: 'Admin', email: 'admin@empresa.com' }]);
    client.setQueryData(['audit', {}], [{ id: 1, action: 'LOGIN' }]);
    expect(client.getQueryData(['users', {}])).toHaveLength(1);

    await act(async () => {
      await result.current.logout();
    });

    // Sin purgar la caché, el siguiente usuario de la misma pestaña los vería.
    expect(client.getQueryData(['users', {}])).toBeUndefined();
    expect(client.getQueryData(['audit', {}])).toBeUndefined();
    expect(result.current.user).toBeNull();
  });

  it('iniciar sesión como otro usuario descarta lo cacheado del anterior', async () => {
    api.get.mockImplementation((path) => {
      if (path === '/api/auth/me') return Promise.resolve({ user: EMPLEADO });
      if (path === '/api/settings') return Promise.resolve({ data: {} });
      return Promise.reject(new Error(`404 ${path}`));
    });
    const { result } = renderAuth(client);
    await waitFor(() => expect(result.current.loading).toBe(false));

    client.setQueryData(['users', {}], [{ id: 1, name: 'Admin', email: 'admin@empresa.com' }]);

    await act(async () => {
      await result.current.login('empleado', 'Empleado1234!', false);
    });

    expect(client.getQueryData(['users', {}])).toBeUndefined();
    expect(result.current.user).toEqual(EMPLEADO);
  });

  it('cerrar sesión funciona aunque la llamada al servidor falle', async () => {
    const { result } = renderAuth(client);
    await waitFor(() => expect(result.current.loading).toBe(false));
    api.post.mockRejectedValue(new Error('Sesión ya expirada'));

    client.setQueryData(['dashboard'], { total: 99 });
    await act(async () => {
      await result.current.logout();
    });

    expect(result.current.user).toBeNull();
    expect(client.getQueryData(['dashboard'])).toBeUndefined();
  });

  it('expone el usuario con sus permisos', async () => {
    api.get.mockImplementation((path) => {
      if (path === '/api/auth/me') return Promise.resolve({ user: ADMIN });
      if (path === '/api/settings') return Promise.resolve({ data: { app_name: 'Soporte' } });
      return Promise.reject(new Error(`404 ${path}`));
    });
    const { result } = renderAuth(client);

    await waitFor(() => expect(result.current.user).toEqual(ADMIN));
    expect(result.current.appName).toBe('Soporte');
  });
});
