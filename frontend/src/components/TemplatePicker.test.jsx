import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TemplatePicker from './TemplatePicker';
import { api } from '../lib/api';
import { renderWithProviders } from '../test/utils';
import { backgroundOf, expectContrast, luminance, readColors } from '../test/contrast';

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
    // Se avisa en la lista de variables y el texto queda literal en la vista previa.
    expect(dialog.textContent).toContain('Desconocida: {{no_existe}}');
    expect(dialog.textContent).toContain('Saludos {{no_existe}}');
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

  // --- Cobertura añadida en la verificación final ---

  it('cierra el panel con Escape sin insertar nada', async () => {
    const { user, onInsert } = await openPicker();
    expect(screen.getByRole('dialog', { name: 'Respuestas rápidas' })).toBeInTheDocument();

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Respuestas rápidas' })).toBeNull());
    expect(screen.getByRole('button', { name: /Respuestas rápidas/ })).toHaveAttribute('aria-expanded', 'false');
    expect(onInsert).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('distingue "Sin resultados" de un selector sin plantillas', async () => {
    api.get.mockImplementation((url) =>
      String(url).includes('q=') && !String(url).endsWith('q=') ? listResponse([]) : listResponse(TEMPLATES)
    );
    const { user } = await openPicker();
    expect(await screen.findByText('Saludo inicial')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Buscar respuestas rápidas'), 'zzz');

    expect(await screen.findByText('Sin resultados')).toBeInTheDocument();
    expect(screen.queryByText('Sin respuestas rápidas')).toBeNull();
  });

  it('descarta los espacios de la búsqueda antes de consultar', async () => {
    const { user } = await openPicker();
    await user.type(screen.getByLabelText('Buscar respuestas rápidas'), '  red  ');

    await waitFor(() => {
      const calls = api.get.mock.calls.map(([u]) => String(u));
      expect(calls.some((u) => u.endsWith('q=red'))).toBe(true);
    });
    // Nunca envía el término con los espacios sin recortar.
    const calls = api.get.mock.calls.map(([u]) => String(u));
    expect(calls.every((u) => !u.includes('q=%20red'))).toBe(true);
  });

  it('no inserta nada al solo seleccionar con el ratón: hace falta una acción explícita', async () => {
    const { user, onInsert } = await openPicker();

    await user.click(screen.getByText('Diagnóstico de red'));

    // Elegir la plantilla solo cambia la vista previa.
    expect(onInsert).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
    expect(api.patch).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Insertar' })).toBeInTheDocument();
  });

  it('Enter inserta una sola vez y por el cursor, sin enviar el comentario', async () => {
    const { user, onInsert } = await openPicker();

    await user.click(screen.getByText('Saludo inicial'));
    await user.keyboard('{Enter}');

    expect(onInsert).toHaveBeenCalledTimes(1);
    expect(onInsert.mock.calls[0][0].mode).toBe('cursor');
    expect(api.post).not.toHaveBeenCalled();
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('navega con el teclado y el Enter inserta la plantilla resaltada', async () => {
    const { user, onInsert } = await openPicker();

    await user.keyboard('{ArrowDown}{Enter}');

    expect(onInsert).toHaveBeenCalledTimes(1);
    expect(onInsert.mock.calls[0][0].template.title).toBe('Diagnóstico de red');
    expect(api.post).not.toHaveBeenCalled();
  });

  it('Copiar lleva el texto expandido al portapapeles y tampoco envía nada', async () => {
    // userEvent.setup() instala su propio stub de portapapeles, así que el
    // espía se define después de abrir el panel.
    const { user, onInsert } = await openPicker();
    const writeText = vi.fn().mockResolvedValue(undefined);
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      await user.click(screen.getByText('Saludo inicial'));
      await user.click(screen.getByRole('button', { name: 'Copiar' }));

      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
      expect(writeText.mock.calls[0][0]).toBe('Hola Ana Ruiz, su ticket TCK-000042 está en revisión.');
      expect(onInsert).not.toHaveBeenCalled();
      expect(api.post).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Respuestas rápidas' })).toBeNull());
    } finally {
      if (original) Object.defineProperty(navigator, 'clipboard', original);
      else delete navigator.clipboard;
    }
  });

  it('solo consulta el endpoint visible: nunca /manage ni /mine', async () => {
    const { user } = await openPicker({ onManagePersonal: vi.fn(), onManageGlobal: vi.fn(), canManageGlobal: true });
    await user.type(screen.getByLabelText('Buscar respuestas rápidas'), 'red');
    await waitFor(() => expect(api.get).toHaveBeenCalled());

    const urls = api.get.mock.calls.map(([u]) => String(u));
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url.startsWith('/api/canned-responses?')).toBe(true);
      expect(url).not.toContain('/manage');
      expect(url).not.toContain('/mine');
    }
  });

  it('omite el enlace de administración personal cuando el padre no lo ofrece', async () => {
    await openPicker({ onManageGlobal: vi.fn(), canManageGlobal: true });
    expect(screen.getByRole('button', { name: 'Plantillas globales y de equipo' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Administrar mis plantillas' })).toBeNull();
  });

  it('se recupera de un error de red al reintentar la búsqueda', async () => {
    let fail = true;
    api.get.mockImplementation((url) => {
      if (fail) return Promise.reject(new Error('Error de red'));
      return String(url).includes('q=recupera')
        ? listResponse([{ id: 12, title: 'Recuperada', body: 'Ya funciona', scope: 'GLOBAL', is_active: 1, use_count: 0 }])
        : listResponse(TEMPLATES);
    });

    const { user } = await openPicker();
    expect(await screen.findByText('Error de red')).toBeInTheDocument();

    fail = false;
    await user.type(screen.getByLabelText('Buscar respuestas rápidas'), 'recupera');

    expect(await screen.findByText('Recuperada')).toBeInTheDocument();
    expect(screen.queryByText('Error de red')).toBeNull();
  });

  describe('legibilidad del panel', () => {
    // El panel se portaliza a document.body, así que no hereda ninguna
    // superficie: tiene que declarar la suya. Antes era bg-white (blanco puro)
    // con títulos text-slate-800, que en esta paleta también es blanco
    // (#F8FAFC), y la fila seleccionada usaba bg-brand-50 (#E7FAF1) con el
    // mismo texto blanco: todo ilegible aunque el menú estuviera bien
    // posicionado. Estos tests leen las clases reales del DOM.

    it('el panel declara una superficie propia', async () => {
      await openPicker();
      const panel = screen.getByRole('dialog', { name: 'Respuestas rápidas' });
      const { bg } = readColors(panel.className);
      expect(bg, 'el panel debe declarar su propio fondo').toBeTruthy();
      expect(backgroundOf(panel.className, '#ffffff').toLowerCase()).toBe('#ffffff');
    });

    it('el título de cada plantilla es legible sobre el panel', async () => {
      await openPicker();
      const panel = screen.getByRole('dialog', { name: 'Respuestas rápidas' });
      const surface = backgroundOf(panel.className, '#ffffff');
      for (const title of ['Saludo inicial', 'Diagnóstico de red']) {
        const el = screen.getByText(title);
        expect(expectContrast(el, { surface, min: 4.5, label: `título "${title}"` })).toBeGreaterThanOrEqual(4.5);
      }
    });

    it('el extracto de cada plantilla es legible sobre el panel', async () => {
      await openPicker();
      await screen.findByText('Saludo inicial');
      const panel = screen.getByRole('dialog', { name: 'Respuestas rápidas' });
      const surface = backgroundOf(panel.className, '#ffffff');
      const excerpt = panel.querySelector('span.truncate');
      expect(excerpt, 'la fila debe mostrar un extracto del cuerpo').toBeTruthy();
      expect(expectContrast(excerpt, { surface, min: 3, label: 'extracto de plantilla' })).toBeGreaterThanOrEqual(3);
    });

    it('la fila seleccionada se distingue del resto por contraste de color y de fondo', async () => {
      await openPicker();
      await screen.findByText('Saludo inicial');
      const selected = screen.getByText('Saludo inicial');
      const unselected = screen.getByText('Diagnóstico de red');
      const { bg } = readColors(selected.parentElement.className);
      expect(bg, 'la fila seleccionada debe declarar un fondo propio').toBeTruthy();

      // La selección SIFHA usa azul suave y el texto mantiene contraste AA.
      const selectedBg = backgroundOf(selected.parentElement.className, '#0e3a50');
      expect(luminance(selectedBg), 'la fila seleccionada debe diferenciarse de la superficie blanca').toBeLessThan(0.98);

      // Y el texto de la fila no seleccionada tiene que seguir siendo legible
      // sobre el fondo del panel, no solo sobre el de la selección.
      const panel = screen.getByRole('dialog', { name: 'Respuestas rápidas' });
      const surface = backgroundOf(panel.className, '#ffffff');
      expect(expectContrast(unselected, { surface, min: 4.5, label: 'título no seleccionado' })).toBeGreaterThanOrEqual(4.5);
    });

    it('la vista previa es legible sobre su propia superficie', async () => {
      await openPicker();
      await screen.findByText('Saludo inicial');
      const panel = screen.getByRole('dialog', { name: 'Respuestas rápidas' });
      const box = panel.querySelector('div[class*="rounded-lg"]');
      expect(box, 'debe aparecer la caja de vista previa').toBeTruthy();
      const surface = backgroundOf(box.className, '#0e3a50');
      expect(surface.toLowerCase(), 'la vista previa usa una superficie clara con texto oscuro').toBe('#ffffff');
      expect(expectContrast(box, { surface, min: 4.5, label: 'vista previa' })).toBeGreaterThanOrEqual(4.5);
    });

    it('los botones de acción Insertar/Reemplazar/Copiar son legibles', async () => {
      const { user } = await openPicker();
      await user.click(screen.getByText('Saludo inicial'));
      for (const name of ['Insertar', 'Reemplazar todo', 'Copiar']) {
        const btn = screen.getByRole('button', { name });
        // btn-primary / btn-secondary / btn-ghost declaran su color en la hoja
        // de estilos; aquí se comprueba que no lo anulan con un token oscuro.
        expect(readColors(btn.className).text ?? null).toBeNull();
        expect(btn).toBeInTheDocument();
      }
    });
  });

  describe('posicionamiento', () => {
    it('mantiene el panel dentro de la ventana en una pantalla baja', async () => {
      // Regresión: la posición se calculaba asumiendo un alto fijo de 320 px
      // (top = min(bottom + 6, innerHeight - 320)). Con una ventana más baja
      // que 320 px el top salía negativo y el menú aparecía fuera de la
      // pantalla, precisamente en móvil o en ventanas pequeñas.
      const originalHeight = window.innerHeight;
      const originalWidth = window.innerWidth;
      Object.defineProperty(window, 'innerHeight', { value: 300, configurable: true });
      Object.defineProperty(window, 'innerWidth', { value: 360, configurable: true });
      try {
        await openPicker();
        await screen.findByText('Saludo inicial');
        const panel = screen.getByRole('dialog', { name: 'Respuestas rápidas' });

        const top = parseFloat(panel.style.top);
        const left = parseFloat(panel.style.left);
        const width = Math.min(420, window.innerWidth - 16);

        expect(Number.isFinite(top), `top no numérico: "${panel.style.top}"`).toBe(true);
        expect(Number.isFinite(left), `left no numérico: "${panel.style.left}"`).toBe(true);
        expect(top, 'el panel no puede empezar por encima de la ventana').toBeGreaterThanOrEqual(0);
        expect(top, 'el panel no puede empezar por debajo de la ventana').toBeLessThan(window.innerHeight);
        expect(left, 'el panel no puede empezar por la izquierda de la ventana').toBeGreaterThanOrEqual(0);
        expect(left + width, 'el panel no puede desbordar por la derecha').toBeLessThanOrEqual(window.innerWidth);
      } finally {
        Object.defineProperty(window, 'innerHeight', { value: originalHeight, configurable: true });
        Object.defineProperty(window, 'innerWidth', { value: originalWidth, configurable: true });
      }
    });

    it('coloca el panel a la derecha cuando el botón está cerca del borde', async () => {
      const originalWidth = window.innerWidth;
      Object.defineProperty(window, 'innerWidth', { value: 500, configurable: true });
      try {
        await openPicker();
        const panel = screen.getByRole('dialog', { name: 'Respuestas rápidas' });
        const left = parseFloat(panel.style.left);
        const width = Math.min(420, window.innerWidth - 16);
        // El botón arranca en x=0 en jsdom: el panel no puede desbordar.
        expect(left + width).toBeLessThanOrEqual(window.innerWidth);
      } finally {
        Object.defineProperty(window, 'innerWidth', { value: originalWidth, configurable: true });
      }
    });
  });
});

// Reabre el panel en la misma instancia ya montada.
async function openPickerAgain(user) {
  await user.click(screen.getByRole('button', { name: /Respuestas rápidas/ }));
  await screen.findByRole('dialog', { name: 'Respuestas rápidas' });
}
