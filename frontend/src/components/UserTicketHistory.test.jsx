import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import UserTicketHistory from './UserTicketHistory';
import { api } from '../lib/api';
import { renderWithProviders } from '../test/utils';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual('../lib/api');
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  };
});

function ticket(overrides = {}) {
  return {
    id: 11,
    ticket_number: 'TCK-000011',
    title: 'PC no enciende',
    status: 'OPEN',
    priority: 'HIGH',
    category_name: 'Hardware',
    category_color: '#64748b',
    created_at: '2026-09-20T10:00:00Z',
    sla_due_at: '2099-01-01T00:00:00Z',
    is_overdue: false,
    ...overrides,
  };
}

function historyResp(rows = [ticket()], overrides = {}) {
  return {
    data: rows,
    total: rows.length,
    page: 1,
    pages: 1,
    by_status: { OPEN: 1, CLOSED: 0 },
    ...overrides,
  };
}

function url(scope, page = 1, perPage = 8) {
  return `/api/users/2/tickets?scope=${scope}&page=${page}&perPage=${perPage}`;
}

function setup(handler) {
  api.get.mockImplementation(handler || ((u) => Promise.resolve(historyResp())));
}

beforeEach(() => {
  vi.resetAllMocks();
  setup();
});

describe('UserTicketHistory', () => {
  it('muestra un indicador de carga sin tabla mientras responde la API', () => {
    setup(() => new Promise(() => {}));

    renderWithProviders(<UserTicketHistory userId={2} />, { route: '/app/users' });
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText('Sin tickets')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reportados' })).toBeInTheDocument();
  });

  it('no consulta nada si no recibe userId y muestra el estado vacío', async () => {
    renderWithProviders(<UserTicketHistory />, { route: '/app/users' });

    expect(await screen.findByText('Sin tickets')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();
  });

  it('carga los tickets reportados del usuario', async () => {
    setup((u) => Promise.resolve(historyResp([ticket()])));

    renderWithProviders(<UserTicketHistory userId={2} />, { route: '/app/users' });

    expect(await screen.findByText('PC no enciende')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith(url('reported'));
    const table = within(screen.getByRole('table'));
    expect(table.getByText('TCK-000011')).toBeInTheDocument();
    expect(table.getByText('Abierto')).toBeInTheDocument();
    expect(table.getByText('Alta')).toBeInTheDocument();
    expect(table.getByText('Hardware')).toBeInTheDocument();
    expect(table.getByText('Número')).toBeInTheDocument();
    expect(table.getByText('Categoría')).toBeInTheDocument();
    expect(table.getByText('SLA')).toBeInTheDocument();
  });

  it('usa las etiquetas de Reportados y Asignados fuera del perfil propio', async () => {
    renderWithProviders(<UserTicketHistory userId={2} />, { route: '/app/users' });
    await screen.findByText('PC no enciende');

    expect(screen.getByRole('button', { name: 'Reportados' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Asignados' })).toBeInTheDocument();
  });

  it('usa las etiquetas de Reportados por mí y Asignados a mí en el perfil propio', async () => {
    renderWithProviders(<UserTicketHistory userId={2} self />, { route: '/app/profile' });
    await screen.findByText('PC no enciende');

    expect(screen.getByRole('button', { name: 'Reportados por mí' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Asignados a mí' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reportados' })).not.toBeInTheDocument();
  });

  it('muestra el estado vacío cuando el usuario no tiene tickets', async () => {
    setup((u) => Promise.resolve(historyResp([], { total: 0, by_status: {} })));

    renderWithProviders(<UserTicketHistory userId={2} />, { route: '/app/users' });

    expect(await screen.findByText('Sin tickets')).toBeInTheDocument();
    expect(screen.getByText('No hay tickets en este historial.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('muestra el error de carga del historial', async () => {
    setup(() => Promise.reject(new Error('No se pudo cargar el historial')));

    renderWithProviders(<UserTicketHistory userId={2} />, { route: '/app/users' });

    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo cargar el historial');
  });

  it('resume los totales por estado', async () => {
    setup(() =>
      Promise.resolve(
        historyResp([ticket(), ticket({ id: 12, status: 'RESOLVED' })], { total: 7, by_status: { OPEN: 1, ASSIGNED: 2, RESOLVED: 3, CLOSED: 1 } })
      )
    );

    renderWithProviders(<UserTicketHistory userId={2} />, { route: '/app/users' });

    expect(await screen.findByText('7 en total')).toBeInTheDocument();
    expect(screen.getByText('3 abiertos')).toBeInTheDocument();
    expect(screen.getByText('4 cerrados')).toBeInTheDocument();
  });

  it('cambia al historial de tickets asignados', async () => {
    const user = userEvent.setup();
    setup((u) =>
      Promise.resolve(
        historyResp(
          u.includes('scope=assigned') ? [ticket({ id: 12, title: 'Ticket asignado' })] : [ticket({ title: 'PC no enciende' })],
          { total: 1, pages: 1 }
        )
      )
    );

    renderWithProviders(<UserTicketHistory userId={2} />, { route: '/app/users' });
    await screen.findByText('PC no enciende');

    await user.click(screen.getByRole('button', { name: 'Asignados' }));

    await waitFor(() => expect(api.get).toHaveBeenCalledWith(url('assigned')));
    expect(await screen.findByText('Ticket asignado')).toBeInTheDocument();
  });

  it('vuelve a la primera página al cambiar de pestaña', async () => {
    const user = userEvent.setup();
    setup((u) => Promise.resolve(historyResp([ticket()], { total: 20, pages: 3 })));

    renderWithProviders(<UserTicketHistory userId={2} />, { route: '/app/users' });
    await screen.findByText('PC no enciende');

    await user.click(screen.getByRole('button', { name: 'Siguiente →' }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(url('reported', 2)));

    await user.click(screen.getByRole('button', { name: 'Asignados' }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(url('assigned', 1)));
  });

  it('respeta el tamaño de página recibido por props', async () => {
    renderWithProviders(<UserTicketHistory userId={2} perPage={25} />, { route: '/app/users' });

    await screen.findByText('PC no enciende');
    expect(api.get).toHaveBeenCalledWith(url('reported', 1, 25));
  });

  it('pagina hacia atrás y adelante', async () => {
    const user = userEvent.setup();
    setup((u) => {
      const page = u.includes('page=2') ? 2 : 1;
      return Promise.resolve(historyResp([ticket()], { total: 20, page, pages: 2 }));
    });

    renderWithProviders(<UserTicketHistory userId={2} />, { route: '/app/users' });
    await screen.findByText('PC no enciende');

    expect(screen.getByText('Página 1 de 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '← Anterior' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Siguiente →' }));
    await screen.findByText('Página 2 de 2');
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(url('reported', 2)));
    expect(screen.getByRole('button', { name: 'Siguiente →' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: '← Anterior' }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(url('reported', 1)));
  });

  it('oculta la paginación cuando solo hay una página', async () => {
    renderWithProviders(<UserTicketHistory userId={2} />, { route: '/app/users' });
    await screen.findByText('PC no enciende');

    expect(screen.queryByRole('button', { name: 'Siguiente →' })).not.toBeInTheDocument();
  });

  it('enlaza cada ticket con su detalle', async () => {
    renderWithProviders(<UserTicketHistory userId={2} />, { route: '/app/users' });

    const link = await screen.findByRole('link', { name: 'TCK-000011' });
    expect(link).toHaveAttribute('href', '/app/tickets/11');
    const title = screen.getByRole('link', { name: 'PC no enciende' });
    expect(title).toHaveAttribute('href', '/app/tickets/11');
  });

  it('muestra el SLA de los tickets abiertos y un guion en los cerrados', async () => {
    setup(() =>
      Promise.resolve(
        historyResp([
          ticket({ sla_due_at: '2099-01-01T00:00:00Z' }),
          ticket({ id: 12, status: 'CLOSED', sla_due_at: null, title: 'Ticket cerrado' }),
        ])
      )
    );

    renderWithProviders(<UserTicketHistory userId={2} />, { route: '/app/users' });

    expect(await screen.findByText('PC no enciende')).toBeInTheDocument();
    const cells = within(screen.getByRole('table')).getAllByRole('cell');
    const slas = cells.filter((c) => /Vence en|Vencido hace/.test(c.textContent) || c.textContent === '—');
    expect(slas.length).toBe(2);
  });

  it('marca en rojo el SLA vencido', async () => {
    setup(() =>
      Promise.resolve(
        historyResp([ticket({ sla_due_at: '2000-01-01T00:00:00Z', is_overdue: true })])
      )
    );

    renderWithProviders(<UserTicketHistory userId={2} />, { route: '/app/users' });

    const sla = await screen.findByText(/Vencido hace/);
    expect(sla).toHaveClass('text-red-600');
  });

  it('muestra un guion cuando el ticket no tiene categoría', async () => {
    setup(() => Promise.resolve(historyResp([ticket({ category_name: null, category_color: null })])));

    renderWithProviders(<UserTicketHistory userId={2} />, { route: '/app/users' });

    expect(await screen.findByText('PC no enciende')).toBeInTheDocument();
    expect(within(screen.getByRole('table')).getByText('—')).toBeInTheDocument();
  });

  it('recarga el historial del usuario cuando cambia el userId', async () => {
    const user = userEvent.setup();
    setup((u) =>
      Promise.resolve(
        historyResp([u.includes('/users/5/') ? ticket({ id: 21, title: 'Otro usuario' }) : ticket()], { total: 1, pages: 1 })
      )
    );

    function Harness() {
      const [id, setId] = React.useState(2);
      return (
        <>
          <button onClick={() => setId(5)}>cambiar usuario</button>
          <UserTicketHistory userId={id} />
        </>
      );
    }

    renderWithProviders(<Harness />, { route: '/app/users' });
    await screen.findByText('PC no enciende');

    await user.click(screen.getByRole('button', { name: 'cambiar usuario' }));

    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/users/5/tickets?scope=reported&page=1&perPage=8'));
    expect(await screen.findByText('Otro usuario')).toBeInTheDocument();
  });
});
