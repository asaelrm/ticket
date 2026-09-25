import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Departments from './Departments';
import { api } from '../lib/api';
import { renderWithProviders } from '../test/utils';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual('../lib/api');
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  };
});

const LIST_URL = '/api/departments';

function department(overrides = {}) {
  return {
    id: 1,
    name: 'TI',
    description: 'Soporte técnico',
    active: true,
    ...overrides,
  };
}

function setup(list) {
  api.get.mockImplementation((url) => {
    if (url === LIST_URL) return Promise.resolve({ data: list });
    return Promise.reject(new Error(`404 ${url}`));
  });
}

function cardFor(name) {
  return screen.getByText(name).closest('.card');
}

function fieldFor(labelText, tag, scope) {
  const label = scope.getByText(labelText, { selector: 'label' });
  return label.closest('div').querySelector(tag);
}

function listCalls() {
  return api.get.mock.calls.filter(([u]) => u === LIST_URL).length;
}

beforeEach(() => {
  vi.clearAllMocks();
  api.post.mockResolvedValue({ department: department({ id: 9 }) });
  api.patch.mockResolvedValue({ department: department() });
  setup([department(), department({ id: 2, name: 'RRHH', description: '', active: false })]);
});

describe('Departments', () => {
  it('muestra la pantalla de carga mientras la API responde', () => {
    api.get.mockImplementation((url) => (url === LIST_URL ? new Promise(() => {}) : Promise.reject(new Error('404'))));

    renderWithProviders(<Departments />, { route: '/app/departments' });
    expect(screen.getByText('Cargando…')).toBeInTheDocument();
  });

  it('lista los departamentos', async () => {
    renderWithProviders(<Departments />, { route: '/app/departments' });

    expect(await screen.findByText('TI')).toBeInTheDocument();
    expect(screen.getByText('RRHH')).toBeInTheDocument();
    expect(screen.getByText('Soporte técnico')).toBeInTheDocument();
    expect(screen.getByText('Sin descripción')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith(LIST_URL);
  });

  it('muestra el error al fallar la carga del listado', async () => {
    api.get.mockImplementation((url) => (url === LIST_URL ? Promise.reject(new Error('Error al cargar departamentos')) : Promise.reject(new Error('404'))));

    renderWithProviders(<Departments />, { route: '/app/departments' });
    expect(await screen.findByRole('alert')).toHaveTextContent('Error al cargar departamentos');
  });

  it('muestra el estado vacío cuando no hay departamentos', async () => {
    setup([]);

    renderWithProviders(<Departments />, { route: '/app/departments' });
    expect(await screen.findByText('Sin departamentos')).toBeInTheDocument();
  });

  it('filtra solo los departamentos activos', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Departments />, { route: '/app/departments' });
    await screen.findByText('TI');

    await user.click(screen.getByRole('checkbox', { name: 'Solo activos' }));

    expect(screen.getByText('TI')).toBeInTheDocument();
    expect(screen.queryByText('RRHH')).not.toBeInTheDocument();
  });

  it('el filtro de activos no vuelve a consultar la API', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Departments />, { route: '/app/departments' });
    await screen.findByText('TI');

    const before = listCalls();
    await user.click(screen.getByRole('checkbox', { name: 'Solo activos' }));

    expect(listCalls()).toBe(before);
  });

  it('crea un departamento y refresca el listado', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Departments />, { route: '/app/departments' });
    await screen.findByText('TI');

    const before = listCalls();
    await user.click(screen.getByRole('button', { name: '+ Nuevo departamento' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nuevo departamento' });

    await user.type(fieldFor('Nombre *', 'input', within(dialog)), 'Finanzas');
    await user.type(fieldFor('Descripción', 'textarea', within(dialog)), 'Contabilidad');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/api/departments', { name: 'Finanzas', description: 'Contabilidad' })
    );
    await waitFor(() => expect(listCalls()).toBeGreaterThan(before));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Nuevo departamento' })).not.toBeInTheDocument());
  });

  it('edita un departamento existente enviando active en true', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Departments />, { route: '/app/departments' });
    await screen.findByText('TI');

    await user.click(within(cardFor('TI')).getByRole('button', { name: 'Editar' }));
    const dialog = await screen.findByRole('dialog', { name: 'Editar departamento' });

    const name = fieldFor('Nombre *', 'input', within(dialog));
    expect(name).toHaveValue('TI');
    await user.clear(name);
    await user.type(name, 'TI y Telecomunicaciones');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }));

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/api/departments/1', {
        name: 'TI y Telecomunicaciones',
        description: 'Soporte técnico',
        active: true,
      })
    );
  });

  it('desactiva y activa un departamento con el interruptor', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Departments />, { route: '/app/departments' });
    await screen.findByText('TI');

    const before = listCalls();
    const ti = screen.getByRole('switch', { name: 'TI' });
    expect(ti).toHaveAttribute('aria-checked', 'true');
    await user.click(ti);
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/departments/1', { active: false }));
    await waitFor(() => expect(listCalls()).toBeGreaterThan(before));

    const rrhh = screen.getByRole('switch', { name: 'RRHH' });
    expect(rrhh).toHaveAttribute('aria-checked', 'false');
    await user.click(rrhh);
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/departments/2', { active: true }));
  });

  it('muestra el error al cambiar el estado de un departamento', async () => {
    api.patch.mockRejectedValueOnce(new Error('No se pudo cambiar el estado'));

    const user = userEvent.setup();
    renderWithProviders(<Departments />, { route: '/app/departments' });
    await screen.findByText('TI');

    await user.click(screen.getByRole('switch', { name: 'TI' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo cambiar el estado');
  });

  it('muestra el error dentro del modal al no poder guardar', async () => {
    api.post.mockRejectedValueOnce(new Error('No se pudo guardar'));

    const user = userEvent.setup();
    renderWithProviders(<Departments />, { route: '/app/departments' });
    await screen.findByText('TI');

    await user.click(screen.getByRole('button', { name: '+ Nuevo departamento' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nuevo departamento' });
    await user.type(fieldFor('Nombre *', 'input', within(dialog)), 'Finanzas');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('No se pudo guardar');
  });

  it('muestra los errores de validación por campo dentro del modal', async () => {
    api.post.mockRejectedValueOnce(Object.assign(new Error('Datos inválidos'), { fields: { name: 'El nombre ya existe' } }));

    const user = userEvent.setup();
    renderWithProviders(<Departments />, { route: '/app/departments' });
    await screen.findByText('TI');

    await user.click(screen.getByRole('button', { name: '+ Nuevo departamento' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nuevo departamento' });
    await user.type(fieldFor('Nombre *', 'input', within(dialog)), 'TI');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('El nombre ya existe');
  });

  it('limpia el error previo al volver a abrir el modal', async () => {
    api.post.mockRejectedValueOnce(new Error('No se pudo guardar'));

    const user = userEvent.setup();
    renderWithProviders(<Departments />, { route: '/app/departments' });
    await screen.findByText('TI');

    await user.click(screen.getByRole('button', { name: '+ Nuevo departamento' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nuevo departamento' });
    await user.type(fieldFor('Nombre *', 'input', within(dialog)), 'Finanzas');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }));
    expect(await within(dialog).findByRole('alert')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: '+ Nuevo departamento' }));
    expect(await within(screen.getByRole('dialog', { name: 'Nuevo departamento' })).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('cancela la edición sin llamar a la API', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Departments />, { route: '/app/departments' });
    await screen.findByText('TI');

    await user.click(within(cardFor('TI')).getByRole('button', { name: 'Editar' }));
    const dialog = await screen.findByRole('dialog', { name: 'Editar departamento' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Editar departamento' })).not.toBeInTheDocument());
    expect(api.patch).not.toHaveBeenCalled();
  });
});
