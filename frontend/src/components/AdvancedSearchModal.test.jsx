import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdvancedSearchModal from './AdvancedSearchModal';
import { api } from '../lib/api';
import { renderWithProviders, pickOption, optionLabels } from '../test/utils';

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

const VIEW_ALL = { id: 7, name: 'Supervisor', permissions: ['ticket.view.all', 'ticket.create'] };
const EMPLOYEE = { id: 8, name: 'Ana', permissions: ['ticket.create', 'ticket.view.own', 'ticket.comment'] };

const NO_FILTERS = {};

function renderModal(props = {}) {
  return renderWithProviders(
    <AdvancedSearchModal
      open
      onClose={props.onClose || (() => {})}
      filters={NO_FILTERS}
      onApply={props.onApply || (() => {})}
      onClear={() => {}}
    />,
    { route: '/app/tickets' }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.user = VIEW_ALL;
  api.get.mockImplementation((url) => {
    if (url === '/api/categories') return Promise.resolve({ data: [{ id: 1, name: 'Hardware' }] });
    if (url === '/api/departments') return Promise.resolve({ data: [{ id: 3, name: 'TI' }] });
    if (url === '/api/users/assignable') {
      return Promise.resolve({ data: [{ id: 9, name: 'Beto', last_name: 'Gómez' }] });
    }
    if (url === '/api/teams/assignable') {
      return Promise.resolve({ data: [{ id: 4, name: 'Soporte', member_count: 3 }] });
    }
    return Promise.reject(new Error(`404 ${url}`));
  });
});

describe('AdvancedSearchModal · directorios según la función', () => {
  it('con ticket.view.all carga los directorios y ofrece sus filtros', async () => {
    const user = userEvent.setup();
    authState.user = VIEW_ALL;
    renderModal();

    expect(await screen.findByRole('dialog', { name: 'Búsqueda avanzada' })).toBeInTheDocument();
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/users/assignable'));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/teams/assignable'));

    expect(screen.getByLabelText('Solicitante')).toBeInTheDocument();
    expect(screen.getByLabelText('Técnico asignado')).toBeInTheDocument();
    expect(screen.getByLabelText('Equipo asignado')).toBeInTheDocument();
    // Y sus opciones llegan a poblarse. El menú se abre bajo demanda y vive en
    // `document.body` por el portal, así que se consulta a nivel de documento.
    await user.click(screen.getByLabelText('Solicitante'));
    await waitFor(() => expect(screen.getByRole('option', { name: 'Beto Gómez' })).toBeInTheDocument());
    await user.click(screen.getByRole('option', { name: 'Beto Gómez' }));
    // El contador de miembros del equipo se conserva tal cual lo pintaba el nativo.
    await user.click(screen.getByLabelText('Equipo asignado'));
    await waitFor(() => expect(screen.getByRole('option', { name: 'Soporte (3)' })).toBeInTheDocument());
  });

  it('sin ticket.view.all no solicita los directorios', async () => {
    authState.user = EMPLOYEE;
    renderModal();

    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/categories'));
    // Los catálogos propios de la búsqueda siempre se piden.
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/departments'));

    // Los directorios no: solo producirían un 403.
    expect(api.get).not.toHaveBeenCalledWith('/api/users/assignable');
    expect(api.get).not.toHaveBeenCalledWith('/api/teams/assignable');
  });

  it('sin ticket.view.all no usa un endpoint alternativo para saltarse el 403', async () => {
    authState.user = EMPLOYEE;
    renderModal();

    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/departments'));
    expect(api.get).not.toHaveBeenCalledWith(expect.stringContaining('/api/users?'));
  });

  it('sin ticket.view.all oculta los filtros de directorio y explica por qué', async () => {
    authState.user = EMPLOYEE;
    renderModal();

    const dialog = await screen.findByRole('dialog', { name: 'Búsqueda avanzada' });
    expect(within(dialog).queryByLabelText('Solicitante')).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Técnico asignado')).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Equipo asignado')).not.toBeInTheDocument();
    expect(within(dialog).getByText(/requiere permiso para ver todos los tickets/)).toBeInTheDocument();
  });

  it('conserva los filtros propios de la búsqueda sin ticket.view.all', async () => {
    const user = userEvent.setup();
    authState.user = EMPLOYEE;
    const onApply = vi.fn();
    renderModal({ onApply });

    await screen.findByRole('dialog', { name: 'Búsqueda avanzada' });
    await pickOption(user, screen.getByLabelText('Estado'), 'En proceso');
    await pickOption(user, screen.getByLabelText('Prioridad'), 'Crítica');
    await user.click(screen.getByRole('button', { name: /Aplicar filtros/ }));

    await waitFor(() => expect(onApply).toHaveBeenCalled());
    const applied = onApply.mock.calls[0][0];
    expect(applied.status).toBe('IN_PROGRESS');
    expect(applied.priority).toBe('CRITICAL');
  });

  it('descarta un filtro de directorio heredado si el usuario no puede verlo', async () => {
    const user = userEvent.setup();
    authState.user = EMPLOYEE;
    const onApply = vi.fn();
    // Una vista guardada dejó ?user=9&team=4 en la URL; ese usuario no puede
    // ver esos selectores, así que no deben recortar sus resultados.
    renderWithProviders(
      <AdvancedSearchModal
        open
        onClose={() => {}}
        filters={{ status: 'OPEN', user: '9', assigned: '9', team: '4' }}
        onApply={onApply}
        onClear={() => {}}
      />,
      { route: '/app/tickets' }
    );

    await screen.findByRole('dialog', { name: 'Búsqueda avanzada' });
    await user.click(screen.getByRole('button', { name: /Aplicar filtros/ }));

    await waitFor(() => expect(onApply).toHaveBeenCalled());
    const applied = onApply.mock.calls[0][0];
    expect(applied.status).toBe('OPEN');
    // Los tres filtros de directorio heredados se descartan…
    expect(applied.user).toBe('');
    expect(applied.assigned).toBe('');
    expect(applied.team).toBe('');
  });

  it('cada filtro conserva su opción vacía para poder quitarlo sin "Limpiar"', async () => {
    const user = userEvent.setup();
    authState.user = VIEW_ALL;
    const onApply = vi.fn();
    renderModal({ onApply });

    await screen.findByRole('dialog', { name: 'Búsqueda avanzada' });
    // En el `<select>` nativo la opción vacía ("Todos"/"Todas"/"Sin asignar")
    // era seleccionable. Si se convirtiera en `placeholder` desaparecería de la
    // lista y el filtro ya no se podría quitar eligiéndola.
    expect(await optionLabels(user, screen.getByLabelText('Estado'))).toEqual([
      'Todos',
      'Abierto',
      'Asignado',
      'En proceso',
      'Pendiente',
      'Resuelto',
      'Cerrado',
      'Cancelado',
    ]);
    expect(await optionLabels(user, screen.getByLabelText('Prioridad'))).toEqual([
      'Todas',
      'Baja',
      'Media',
      'Alta',
      'Crítica',
    ]);
    expect(await optionLabels(user, screen.getByLabelText('Solicitante'))).toEqual([
      'Todos',
      'Beto Gómez',
    ]);
    expect(await optionLabels(user, screen.getByLabelText('Técnico asignado'))).toEqual([
      'Todos',
      'Sin asignar',
      'Beto Gómez',
    ]);
    expect(await optionLabels(user, screen.getByLabelText('Equipo asignado'))).toEqual([
      'Todos',
      'Soporte (3)',
    ]);

    // Y al volver a elegirla se devuelve la cadena vacía, no `undefined`.
    await pickOption(user, screen.getByLabelText('Estado'), 'En proceso');
    await pickOption(user, screen.getByLabelText('Estado'), 'Todos');
    await pickOption(user, screen.getByLabelText('Técnico asignado'), 'Beto Gómez');
    await pickOption(user, screen.getByLabelText('Técnico asignado'), 'Todos');
    await user.click(screen.getByRole('button', { name: /Aplicar filtros/ }));

    await waitFor(() => expect(onApply).toHaveBeenCalled());
    const applied = onApply.mock.calls[0][0];
    expect(applied.status).toBe('');
    expect(applied.assigned).toBe('');
  });
});
