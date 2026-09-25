import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Notifications from './Notifications';
import { api } from '../lib/api';
import { notifyTicketEvent } from '../lib/ticketEvents';
import { renderWithProviders } from '../test/utils';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual('../lib/api');
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  };
});

vi.mock('../lib/ticketEvents', () => ({
  notifyTicketEvent: vi.fn(),
}));

let es;

class MockEventSource {
  constructor(url) {
    this.url = url;
    this.onmessage = null;
    this.onopen = null;
    this.onerror = null;
    this.close = vi.fn();
    es = this;
  }
  addEventListener() {}
  removeEventListener() {}
}

function notif(overrides = {}) {
  return {
    id: 1,
    type: 'COMMENT',
    title: 'Nuevo comentario',
    body: 'Te invitaron a participar',
    link: '/app/tickets/1',
    created_at: '2026-09-20T10:00:00Z',
    read_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  es = undefined;
  vi.clearAllMocks();
  vi.stubGlobal('EventSource', MockEventSource);
  api.get.mockImplementation((url) => {
    if (url === '/api/notifications/unread-count') return Promise.resolve({ unread: 3 });
    if (url === '/api/notifications') return Promise.resolve({ data: [notif()] });
    return Promise.reject(new Error(`404 ${url}`));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Notifications', () => {
  it('muestra el contador de no leídas y no abre una conexión real', async () => {
    renderWithProviders(<Notifications />);

    expect(await screen.findByTitle('Notificaciones')).toHaveTextContent('3');
    expect(es).toBeDefined();
    expect(es.url).toBe('/api/notifications/stream');
  });

  it('abre el panel y lista las notificaciones', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Notifications />);
    await screen.findByTitle('Notificaciones');

    await user.click(screen.getByTitle('Notificaciones'));

    const dialog = await screen.findByRole('dialog', { name: 'Notificaciones' });
    expect(await within(dialog).findByText('Nuevo comentario')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/api/notifications');
  });

  it('marca una notificación como leída al hacer clic', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Notifications />);
    await screen.findByTitle('Notificaciones');

    await user.click(screen.getByTitle('Notificaciones'));
    const dialog = await screen.findByRole('dialog', { name: 'Notificaciones' });
    await user.click(await within(dialog).findByRole('button', { name: /Nuevo comentario/ }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/notifications/read', { ids: [1] }));
    await waitFor(() => expect(screen.getByTitle('Notificaciones')).toHaveTextContent('2'));
  });

  it('marca todas las notificaciones como leídas', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Notifications />);
    await screen.findByTitle('Notificaciones');

    await user.click(screen.getByTitle('Notificaciones'));
    const dialog = await screen.findByRole('dialog', { name: 'Notificaciones' });
    await user.click(await within(dialog).findByRole('button', { name: 'Marcar todas leídas' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/notifications/read', { all: true }));
    await waitFor(() => expect(screen.getByTitle('Notificaciones')).not.toHaveTextContent('3'));
  });

  it('incrementa el contador al recibir un evento SSE de notificaciones (determinista)', async () => {
    renderWithProviders(<Notifications />);
    await screen.findByTitle('Notificaciones');

    await act(async () => {
      es.onmessage({
        data: JSON.stringify({ id: 99, type: 'COMMENT', title: 'Nuevo', body: '', link: '/app/tickets/9', created_at: '2026-09-20T10:00:00Z' }),
      });
    });

    await waitFor(() => expect(screen.getByTitle('Notificaciones')).toHaveTextContent('4'));
  });

  it('reenvía los eventos SSE del canal de tickets al bus', async () => {
    const hasEventSource = renderWithProviders(<Notifications />);
    await screen.findByTitle('Notificaciones');

    await act(async () => {
      es.onmessage({ data: JSON.stringify({ type: 'connected' }) });
    });
    expect(notifyTicketEvent).toHaveBeenCalledWith({ channel: 'tickets', type: 'reconnected' });

    const ticketEvent = { channel: 'tickets', type: 'UPDATED', ticket_id: 1 };
    await act(async () => {
      es.onmessage({ data: JSON.stringify(ticketEvent) });
    });
    expect(notifyTicketEvent).toHaveBeenCalledWith(ticketEvent);

    hasEventSource.unmount();
    expect(es.close).toHaveBeenCalled();
  });
});