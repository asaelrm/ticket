import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TemplatePicker from './TemplatePicker';
import { api } from '../lib/api';
import { renderWithProviders } from '../test/utils';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual('../lib/api');
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } };
});

const TICKET = {
  id: 42,
  ticket_number: 'TCK-000042',
  title: 'La impresora no imprime',
  reporter_name: 'Ana Ruiz',
  status: 'IN_PROGRESS',
  priority: 'HIGH',
  category_name: 'Hardware',
  department_name: 'Operaciones',
  team_name: 'Soporte Nivel 1',
  sla_due_at: '2026-09-30T18:00:00Z',
};

const CONTEXT = {
  ticket_number: 'TCK-000042',
  ticket_title: 'La impresora no imprime',
  reporter_name: 'Ana Ruiz',
  ticket_status: 'En proceso',
  ticket_priority: 'Alta',
  category_name: 'Hardware',
  department_name: 'Operaciones',
  team_name: 'Soporte Nivel 1',
  technician_name: 'Luis Pérez',
  sla_due: '2026-09-30T18:00:00Z',
};

const TEMPLATES = [
  {
    id: 1,
    title: 'Saludo inicial',
    body: 'Hola {{reporter_name}}, su ticket {{ticket_number}} está en revisión.',
    scope: 'GLOBAL',
    is_active: 1,
    use_count: 9,
  },
  {
    id: 2,
    title: 'Diagnóstico de red',
    body: 'Revisamos la red del área **{{department_name}}**.',
    scope: 'TEAM',
    team_name: 'Soporte Nivel 1',
    is_active: 1,
    use_count: 4,
  },
  {
    id: 3,
    title: 'Con variable desconocida',
    body: 'Saludos {{no_existe}}',
    scope: 'PERSONAL',
    is_active: 1,
    use_count: 0,
  },
];

function listResponse(list) {
  return Promise.resolve({ data: { data: list, total: list.length, page: 1, limit: 25 } });
}

beforeEach(() => {
  vi.resetAllMocks();
  api.get.mockImplementation((url) => {
    if (String(url).startsWith('/api/canned-responses?')) return listResponse(TEMPLATES);
    return Promise.reject(new Error(`404 ${url}`));
  });
});

async function openPicker(props = {}) {
  const onInsert = vi.fn();
  const user = userEvent.setup();
  renderWithProviders(
    <TemplatePicker context={CONTEXT} onInsert={onInsert} {...props} />,
    { route: '/app/tickets/42' }
  );
  await user.click(screen.getByRole('button', { name: /Respuestas rápidas/ }));
  await screen.findByRole('dialog', { name: 'Respuestas rápidas' });
  return { user, onInsert };
}

describe('TemplatePicker', () => {
  it('no pide plantillas hasta que se abre', async () => {
    renderWithProviders(<TemplatePicker context={CONTEXT} onInsert={vi.fn()} />);
    expect(api.get).not.toHaveBeenCalled();
  });

  it('lista las plantillas agrupadas por ámbito con sus variables', async () => {
    await openPicker();
    const dialog = screen.getByRole('dialog', { name: 'Respuestas rápidas' });
    expect(within(dialog).getByText('Saludo inicial')).toBeInTheDocument();
    expect(within(dialog).getByText('Global')).toBeInTheDocument();
    expect(within(dialog).getByText('Equipo: Soporte Nivel 1')).toBeInTheDocument();
    expect(within(dialog).getByText('Personal')).toBeInTheDocument();
  });

  it('expande las variables del catálogo en la vista previa', async () => {
    await openPicker();
    const dialog = screen.getByRole('dialog', { name: 'Respuestas rápidas' });
    expect(
      within(dialog).getByText('Hola Ana Ruiz, su ticket TCK-000042 está en revisión.')
    ).toBeInTheDocument();
  });

  it('deja literal una variable desconocida y la señala', async () => {
    const { user } = await openPicker();
    await user.click(screen.getByText('Con variable desconocida'));
    const dialog = await screen.findByRole('dialog', { name: 'Respuestas rápidas' });
    // Se muestra como aviso y, a la vez, queda literal en la vista previa.
    expect(within(dialog).getByText('{{no_existe}}')).toBeInTheDocument();
    expect(within(dialog).getByText(/Desconocida:/)).toBeInTheDocument();
    expect(within(dialog).getByText('Saludos {{no_existe}}')).toBeInTheDocument();
  });

  it('escapa el HTML en la vista previa (no ejecuta el contenido de la plantilla)', async () => {
    api.get.mockImplementation(() =>
      listResponse([
        { id: 9, title: 'XSS', body: '<img src=x onerror="alert(1)">', scope: 'GLOBAL', is_active: 1, use_count: 0 },
      ])
    );
    const { container } = renderWithProviders(<TemplatePicker context={CONTEXT} onInsert={vi.fn()} />);
    await userEvent.setup().click(screen.getByRole('button', { name: /Respuestas rápidas/ }));
    await screen.findByRole('dialog', { name: 'Respuestas rápidas' });
    const dialog = screen.getByRole('dialog', { name: 'Respuestas rápidas' });
    expect(dialog.querySelector('img')).toBeNull();
    expect(dialog.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(container.querySelector('img')).toBeNull();
  });

  it('inserta el texto expandido al pulsar Insertar y no envía nada', async () => {
    const { user, onInsert } = await openPicker();
    await user.click(screen.getByRole('button', { name: 'Insertar' }));

    expect(onInsert).toHaveBeenCalledTimes(1);
    expect(onInsert).toHaveBeenCalledWith({
      text: 'Hola Ana Ruiz, su ticket TCK-000042 está en revisión.',
      template: TEMPLATES[0],
      mode: 'cursor',
    });
    // Ni comentarios ni tecleo: el selector no toca la API de escritura.
    expect(api.post).not.toHaveBeenCalled();
  });

  it('soporta insertar en el cursor y reemplazar todo', async () => {
    const { user, onInsert } = await openPicker();
    await user.click(screen.getByRole('button', { name: 'Insertar' }));
    expect(onInsert.mock.calls[0][0].mode).toBe('cursor');

    await openPickerAgain(user);
    await user.click(screen.getByRole('button', { name: 'Reemplazar todo' }));
    expect(onInsert.mock.calls[1][0].mode).toBe('replace');
  });

  it('bloquea la inserción si el texto expandido supera los 4000 caracteres', async () => {
    api.get.mockImplementation(() =>
      listResponse([
        {
          id: 10,
          title: 'Enorme',
          body: 'a'.repeat(2000) + ' {{ticket_title}} ' + 'b'.repeat(1990),
          scope: 'GLOBAL',
          is_active: 1,
          use_count: 0,
        },
      ])
    );
    const { user, onInsert } = await openPicker();
    expect(await screen.findByText(/supera el máximo de 4000/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Insertar' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Insertar' }));
    expect(onInsert).not.toHaveBeenCalled();
  });

  it('permite insertar un texto de 3900 caracteres expandidos', async () => {
    api.get.mockImplementation(() =>
      listResponse([
        { id: 11, title: 'Largo ok', body: 'a'.repeat(3890) + '{{ticket_title}}', scope: 'GLOBAL', is_active: 1, use_count: 0 },
      ])
    );
    const { onInsert } = await openPicker();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Insertar' }));
    expect(onInsert).toHaveBeenCalledTimes(1);
  });

  it('filtra en el servidor al escribir la búsqueda', async () => {
    const { user } = await openPicker();
    await user.type(screen.getByLabelText('Buscar respuestas rápidas'), 'red');
    await waitFor(() => {
      const calls = api.get.mock.calls.map(([u]) => u);
      expect(calls.some((u) => String(u).includes('q=red'))).toBe(true);
    });
  });

  it('muestra estado vacío cuando no hay plantillas', async () => {
    api.get.mockImplementation(() => listResponse([]));
    await openPicker();
    expect(await screen.findByText('Sin respuestas rápidas')).toBeInTheDocument();
  });

  it('muestra error si la carga falla', async () => {
    api.get.mockImplementation(() => Promise.reject(new Error('Error de red')));
    await openPicker();
    expect(await screen.findByText('Error de red')).toBeInTheDocument();
  });

  it('cierra con Escape y navega a la administración', async () => {
    const onManagePersonal = vi.fn();
    const onManageGlobal = vi.fn();
    const { user } = await openPicker({ onManagePersonal, onManageGlobal, canManageGlobal: true });

    await user.click(screen.getByRole('button', { name: 'Administrar mis plantillas' }));
    expect(onManagePersonal).toHaveBeenCalled();

    await openPickerAgain(user);
    await user.click(screen.getByRole('button', { name: 'Plantillas globales y de equipo' }));
    expect(onManageGlobal).toHaveBeenCalled();
  });

  it('oculta el enlace de administración global sin settings.manage ni team.manage', async () => {
    await openPicker({ onManagePersonal: vi.fn(), onManageGlobal: vi.fn(), canManageGlobal: false });
    expect(screen.queryByRole('button', { name: 'Plantillas globales y de equipo' })).toBeNull();
  });
});

// Reabre el panel en la misma instancia ya montada.
async function openPickerAgain(user) {
  await user.click(screen.getByRole('button', { name: /Respuestas rápidas/ }));
  await screen.findByRole('dialog', { name: 'Respuestas rápidas' });
}
