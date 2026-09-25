import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Categories from './Categories';
import { api } from '../lib/api';
import { renderWithProviders } from '../test/utils';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual('../lib/api');
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  };
});

const LIST_URL = '/api/categories?withCounts=1';

function category(overrides = {}) {
  return {
    id: 1,
    name: 'Hardware',
    description: 'Problemas físicos del equipo',
    color: '#3366ff',
    active: true,
    tickets_count: 7,
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

function categoryCalls() {
  return api.get.mock.calls.filter(([u]) => u === LIST_URL).length;
}

beforeEach(() => {
  vi.clearAllMocks();
  api.patch.mockResolvedValue({ category: category() });
  api.post.mockResolvedValue({ category: category({ id: 9 }) });
  setup([category(), category({ id: 2, name: 'Software', description: '', active: false, tickets_count: 0 })]);
});

describe('Categories', () => {
  it('muestra la pantalla de carga mientras la API responde', () => {
    api.get.mockImplementation((url) => (url === LIST_URL ? new Promise(() => {}) : Promise.reject(new Error('404'))));

    renderWithProviders(<Categories />, { route: '/app/categories' });
    expect(screen.getByText('Cargando…')).toBeInTheDocument();
  });

  it('lista las categorías con su conteo de tickets', async () => {
    renderWithProviders(<Categories />, { route: '/app/categories' });

    expect(await screen.findByText('Hardware')).toBeInTheDocument();
    expect(screen.getByText('Software')).toBeInTheDocument();
    expect(screen.getByText('7 tickets')).toBeInTheDocument();
    expect(screen.getByText('0 tickets')).toBeInTheDocument();
    expect(screen.getByText('Problemas físicos del equipo')).toBeInTheDocument();
    expect(screen.getByText('Sin descripción')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith(LIST_URL);
  });

  it('muestra el error al fallar la carga del listado', async () => {
    api.get.mockImplementation((url) => (url === LIST_URL ? Promise.reject(new Error('Error al cargar categorías')) : Promise.reject(new Error('404'))));

    renderWithProviders(<Categories />, { route: '/app/categories' });
    expect(await screen.findByRole('alert')).toHaveTextContent('Error al cargar categorías');
  });

  it('muestra el estado vacío cuando no hay categorías', async () => {
    setup([]);

    renderWithProviders(<Categories />, { route: '/app/categories' });
    expect(await screen.findByText('Sin categorías')).toBeInTheDocument();
  });

  it('filtra solo las activas con la casilla "Solo activas"', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Categories />, { route: '/app/categories' });
    await screen.findByText('Hardware');

    await user.click(screen.getByRole('checkbox', { name: 'Solo activas' }));

    expect(screen.getByText('Hardware')).toBeInTheDocument();
    expect(screen.queryByText('Software')).not.toBeInTheDocument();
  });

  it('crea una categoría y refresca el listado', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Categories />, { route: '/app/categories' });
    await screen.findByText('Hardware');

    const before = categoryCalls();
    await user.click(screen.getByRole('button', { name: '+ Nueva categoría' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nueva categoría' });

    await user.type(fieldFor('Nombre *', 'input', within(dialog)), 'Accesorios');
    await user.type(fieldFor('Descripción', 'textarea', within(dialog)), 'Cables y monitores');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/api/categories', {
        name: 'Accesorios',
        description: 'Cables y monitores',
        color: '#3366ff',
      })
    );
    await waitFor(() => expect(categoryCalls()).toBeGreaterThan(before));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Nueva categoría' })).not.toBeInTheDocument());
  });

  it('cancela la creación sin llamar a la API', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Categories />, { route: '/app/categories' });
    await screen.findByText('Hardware');

    await user.click(screen.getByRole('button', { name: '+ Nueva categoría' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nueva categoría' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Nueva categoría' })).not.toBeInTheDocument());
    expect(api.post).not.toHaveBeenCalled();
  });

  it('edita una categoría existente enviando active en true', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Categories />, { route: '/app/categories' });
    await screen.findByText('Hardware');

    await user.click(within(cardFor('Hardware')).getByRole('button', { name: 'Editar' }));
    const dialog = await screen.findByRole('dialog', { name: 'Editar categoría' });

    const name = fieldFor('Nombre *', 'input', within(dialog));
    expect(name).toHaveValue('Hardware');
    await user.clear(name);
    await user.type(name, 'Hardware y periféricos');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }));

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/api/categories/1', {
        name: 'Hardware y periféricos',
        description: 'Problemas físicos del equipo',
        color: '#3366ff',
        active: true,
      })
    );
  });

  it('desactiva una categoría con el interruptor y refresca el listado', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Categories />, { route: '/app/categories' });
    await screen.findByText('Hardware');

    const before = categoryCalls();
    const toggle = screen.getByRole('switch', { name: 'Hardware' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    await user.click(toggle);

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/categories/1', { active: false }));
    await waitFor(() => expect(categoryCalls()).toBeGreaterThan(before));
  });

  it('activa una categoría inactiva', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Categories />, { route: '/app/categories' });
    await screen.findByText('Software');

    const toggle = screen.getByRole('switch', { name: 'Software' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await user.click(toggle);

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/categories/2', { active: true }));
  });

  it('muestra el error devuelto por la API al activar o desactivar', async () => {
    api.patch.mockRejectedValueOnce(new Error('No se pudo cambiar el estado'));

    const user = userEvent.setup();
    renderWithProviders(<Categories />, { route: '/app/categories' });
    await screen.findByText('Hardware');

    await user.click(screen.getByRole('switch', { name: 'Hardware' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo cambiar el estado');
  });

  it('muestra los errores de validación por campo al guardar', async () => {
    api.post.mockRejectedValueOnce(Object.assign(new Error('Datos inválidos'), { fields: { name: 'El nombre es obligatorio' } }));

    const user = userEvent.setup();
    renderWithProviders(<Categories />, { route: '/app/categories' });
    await screen.findByText('Hardware');

    await user.click(screen.getByRole('button', { name: '+ Nueva categoría' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nueva categoría' });
    await user.type(fieldFor('Nombre *', 'input', within(dialog)), 'Duplicada');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('El nombre es obligatorio');
    expect(screen.getByRole('dialog', { name: 'Nueva categoría' })).toBeInTheDocument();
  });

  it('muestra el error de la API al guardar una categoría nueva', async () => {
    api.post.mockRejectedValueOnce(new Error('Ya existe una categoría con ese nombre'));

    const user = userEvent.setup();
    renderWithProviders(<Categories />, { route: '/app/categories' });
    await screen.findByText('Hardware');

    await user.click(screen.getByRole('button', { name: '+ Nueva categoría' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nueva categoría' });
    await user.type(fieldFor('Nombre *', 'input', within(dialog)), 'Hardware');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Ya existe una categoría con ese nombre');
  });
});
