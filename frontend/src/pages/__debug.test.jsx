import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Teams from './Teams';
import { api } from '../lib/api';
import { renderWithProviders } from '../test/utils';

const { authState } = vi.hoisted(() => ({ authState: { user: null } }));

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

const TEAMS = [{ id: 1, name: 'Soporte', description: 'd', member_count: 1, open_tickets: 0 }];
const USERS = [{ id: 2, name: 'Ada', last_name: 'Lovelace', position: 'Analista', department_name: 'TI' }];

beforeEach(() => {
  vi.clearAllMocks();
  authState.user = { id: 7, permissions: ['team.manage'] };
  api.get.mockImplementation((url) => {
    if (url === '/api/teams') return Promise.resolve({ data: TEAMS });
    if (url === '/api/users/assignable') return Promise.resolve({ data: USERS });
    if (url === '/api/teams/1') return Promise.reject(new Error('BOOM'));
    return Promise.reject(new Error(`404 ${url}`));
  });
});

describe('debug', () => {
  it('inspecciona el error de miembros', async () => {
    const user = userEvent.setup();
    const { queryClient } = renderWithProviders(<Teams />, { route: '/app/teams' });
    await screen.findByText('Soporte');
    await user.click(screen.getByRole('button', { name: 'Miembros' }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/teams/1'));
    await new Promise((r) => setTimeout(r, 100));
    // eslint-disable-next-line no-console
    console.log('ALERTS:', screen.queryAllByRole('alert').map((a) => a.textContent));
    // eslint-disable-next-line no-console
    console.log('GET CALLS:', JSON.stringify(api.get.mock.calls.map((c) => c[0])));
    // eslint-disable-next-line no-console
    console.log('BODY SNIPPET:', document.body.textContent.slice(0, 400));
    const q = queryClient.getQueryState(['team-members', 1]);
    // eslint-disable-next-line no-console
    console.log('QUERY STATE:', JSON.stringify({ status: q?.status, error: String(q?.error), failureCount: q?.failureCount }));
  });
});
