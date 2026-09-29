import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Select from './Select';

const OPTIONS = [
  { value: '', label: 'Todos los estados' },
  { value: 'OPEN', label: 'Abierto' },
  { value: 'IN_PROGRESS', label: 'En proceso' },
  { value: 'PENDING', label: 'Pendiente' },
];

const setup = (props = {}) => {
  const onChange = vi.fn();
  const utils = render(<Select id="estado" options={OPTIONS} value="" onChange={onChange} {...props} />);
  return { onChange, trigger: screen.getByRole('combobox'), ...utils };
};

describe('Select', () => {
  it('muestra la opción vigente cerrada y arranca con la lista oculta', () => {
    setup({ value: 'PENDING' });

    const trigger = screen.getByRole('combobox');
    expect(trigger).toHaveTextContent('Pendiente');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveAttribute('aria-haspopup', 'listbox');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('recorta el rótulo a la etiqueta cuando el valor no existe', () => {
    setup({ value: 'NOPE', placeholder: 'Todos los estados' });

    const trigger = screen.getByRole('combobox');
    expect(trigger).toHaveTextContent('Todos los estados');
    expect(trigger).toHaveAttribute('data-placeholder', 'true');
  });

  it('abre y cierra con click', async () => {
    const user = userEvent.setup();
    const { trigger } = setup();

    await user.click(trigger);
    const listbox = screen.getByRole('listbox');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger).toHaveAttribute('aria-controls', listbox.id);
    expect(within(listbox).getAllByRole('option')).toHaveLength(OPTIONS.length);

    await user.click(trigger);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('cierra al pulsar fuera del control', async () => {
    const user = userEvent.setup();
    const { trigger } = setup();

    await user.click(trigger);
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    await user.click(document.body);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('entrega el valor elegido y cierra el menú', async () => {
    const user = userEvent.setup();
    const { onChange, trigger } = setup();

    await user.click(trigger);
    await user.click(screen.getByRole('option', { name: /En proceso/ }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('IN_PROGRESS');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('devuelve cadenas también cuando la opción trae número', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Select
        id="categoria"
        value=""
        onChange={onChange}
        options={[{ value: '', label: 'Todas' }, { value: 4, label: 'Hardware' }]}
      />
    );

    await user.click(screen.getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: 'Hardware' }));

    expect(onChange).toHaveBeenCalledWith('4');
  });

  // Los `<select>` nativos con opción vacía la dejaban seleccionable, de modo que
  // los filtros se limpiaban eligiendo "Todos" otra vez, sin botón de reinicio.
  it('permite volver a elegir la opción vacía y entrega la cadena vacía', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Select id="estado" value="OPEN" onChange={onChange} options={OPTIONS} />);

    await user.click(screen.getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: 'Todos los estados' }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('trata la opción vacía como una opción normal, no como placeholder', () => {
    setup({ value: '' });

    const trigger = screen.getByRole('combobox');
    // Con `placeholder` el rótulo vacío sería un recorte; aquí es una opción real.
    expect(trigger).toHaveTextContent('Todos los estados');
    expect(trigger).not.toHaveAttribute('data-placeholder', 'true');
  });

  it('marca la opción seleccionada y le pone check', async () => {
    const user = userEvent.setup();
    setup({ value: 'OPEN' });

    await user.click(screen.getByRole('combobox'));

    const selected = screen.getAllByRole('option').filter((o) => o.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0]).toHaveTextContent('Abierto');
    // El check es decorativo y aria-hidden: no duplica el anuncio de la opción.
    const check = selected[0].querySelector('svg');
    expect(check).not.toBeNull();
    expect(check).toHaveAttribute('aria-hidden', 'true');
    // Las demás opciones no llevan check, pero reservan el hueco para no bailen.
    const other = screen.getAllByRole('option').find((o) => o !== selected[0]);
    expect(other.querySelector('svg')).toBeNull();
    expect(other.querySelector('span').className).toContain('w-4');
  });

  it('abre con ArrowDown, mueve con las flechas y elige con Enter', async () => {
    const user = userEvent.setup();
    const { onChange, trigger } = setup({ value: 'OPEN' });

    trigger.focus();
    expect(trigger).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Enter}');

    expect(onChange).toHaveBeenCalledWith('IN_PROGRESS');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('ArrowUp abre sobre la última opción', async () => {
    const user = userEvent.setup();
    const { onChange, trigger } = setup();

    trigger.focus();
    await user.keyboard('{ArrowUp}');
    await user.keyboard('{Enter}');

    expect(onChange).toHaveBeenCalledWith('PENDING');
  });

  it('Space abre y elige, sin desplazar la página', async () => {
    const user = userEvent.setup();
    const { onChange, trigger } = setup();

    trigger.focus();
    await user.keyboard(' ');
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    await user.keyboard('{ArrowDown} ');
    expect(onChange).toHaveBeenCalledWith('OPEN');
  });

  it('Home y End saltan a los extremos', async () => {
    const user = userEvent.setup();
    const { onChange, trigger } = setup({ value: 'OPEN' });

    trigger.focus();
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{End}{Enter}');
    expect(onChange).toHaveBeenLastCalledWith('PENDING');

    trigger.focus();
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Home}{Enter}');
    // El primer elemento es la opción "todos", no la que estaba seleccionada.
    expect(onChange).toHaveBeenLastCalledWith('');
  });

  it('Escape cierra sin cambiar el valor', async () => {
    const user = userEvent.setup();
    const { onChange, trigger } = setup({ value: 'OPEN' });

    await user.click(trigger);
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('anuncia la opción activa mientras está abierto', async () => {
    const user = userEvent.setup();
    const { trigger } = setup({ value: 'OPEN' });

    await user.click(trigger);
    const active = trigger.getAttribute('aria-activedescendant');
    expect(active).toBeTruthy();
    expect(document.getElementById(active)).toHaveTextContent('Abierto');

    await user.keyboard('{ArrowDown}');
    expect(trigger.getAttribute('aria-activedescendant')).not.toBe(active);
    // El foco sigue en el botón: el menú se recorre con aria-activedescendant.
    expect(trigger).toHaveFocus();
  });

  it('busca por letras, ignorando tildes y mayúsculas', async () => {
    const user = userEvent.setup();
    const { onChange, trigger } = setup({
      options: [
        { value: 'a', label: 'Baja' },
        { value: 'b', label: 'Crítica' },
      ],
      value: '',
    });

    trigger.focus();
    await user.keyboard('{ArrowDown}');
    await user.keyboard('c');
    await user.keyboard('{Enter}');

    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('no hace nada cuando está disabled', async () => {
    const user = userEvent.setup();
    const { onChange, trigger } = setup({ disabled: true });

    expect(trigger).toBeDisabled();
    await user.click(trigger);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('salta las opciones deshabilitadas al navegar', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Select
        id="prioridad"
        value=""
        onChange={onChange}
        options={[
          { value: 'LOW', label: 'Baja' },
          { value: 'HIGH', label: 'Alta', disabled: true },
          { value: 'CRIT', label: 'Crítica' },
        ]}
      />
    );

    const trigger = screen.getByRole('combobox');
    trigger.focus();
    await user.keyboard('{ArrowDown}');

    // La opción deshabilitada se ve, pero marcada como tal y sin iluminarse.
    const off = screen.getByRole('option', { name: 'Alta' });
    expect(off).toHaveAttribute('data-disabled', 'true');

    await user.keyboard('{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenCalledWith('CRIT');
  });

  it('ignora el clic sobre una opción deshabilitada', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Select
        id="prioridad"
        value=""
        onChange={onChange}
        options={[
          { value: 'LOW', label: 'Baja' },
          { value: 'HIGH', label: 'Alta', disabled: true },
        ]}
      />
    );

    await user.click(screen.getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: 'Alta' }));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('renderiza un input oculto cuando recibe name', () => {
    const { container } = render(
      <Select name="status" id="estado" value="OPEN" onChange={() => {}} options={OPTIONS} />
    );

    const hidden = container.querySelector('input[type="hidden"]');
    expect(hidden).toHaveAttribute('name', 'status');
    expect(hidden).toHaveValue('OPEN');
  });

  it('no deja restos de <select> nativo en el DOM', async () => {
    const user = userEvent.setup();
    const { container } = setup({ value: 'OPEN' });
    await user.click(screen.getByRole('combobox'));

    expect(container.querySelector('select')).toBeNull();
    // Con el menú abierto también se revisa `document`, que es donde queda el
    // portal: ningún <select> debe colarse tampoco por ahí.
    expect(document.querySelector('select')).toBeNull();
    expect(document.querySelector('option')).toBeNull();
  });

  describe('overlay', () => {
    it('monta el menú fuera del DOM del control para que nada lo recorte', async () => {
      const user = userEvent.setup();
      const { container } = setup();

      await user.click(screen.getByRole('combobox'));
      const listbox = screen.getByRole('listbox');

      // Regresión del bug de stacking: dentro del DOM del control el menú
      // quedaría atrapado en el stacking context de la tarjeta (backdrop-filter)
      // y la tabla lo taparía, por muy alto que fuese su z-index.
      expect(container.contains(listbox)).toBe(false);
      expect(listbox.parentElement).toBe(document.body);
      // Al salir de la tarjeta tampoco hay ningún ancestro con overflow.
      expect(listbox.closest('.card')).toBeNull();
    });

    it('mantiene las clases que sostienen el overlay', async () => {
      const user = userEvent.setup();
      setup();

      await user.click(screen.getByRole('combobox'));
      const listbox = screen.getByRole('listbox');

      expect(listbox).toHaveClass('select-menu');
      // `panel-glass` da la superficie de vidrio del tema y `nex-pop` su
      // animación; si se caen, el menú deja de verse como el resto.
      expect(listbox).toHaveClass('panel-glass', 'nex-pop');
    });

    it('.select-menu se posiciona en fixed y con z-index en la escala del tema', () => {
      // El z-index vive en la hoja de estilos, así que se comprueba el contrato
      // en el CSS: no se puede verificar de forma fiable en jsdom.
      const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
      const rule = css.match(/\.select-menu\s*\{([^}]*)\}/);

      expect(rule).not.toBeNull();
      expect(rule[1]).toMatch(/position:\s*fixed/);
      expect(rule[1]).toMatch(/z-index:\s*50/);
    });

    it('se reposiciona al cambiar el tamaño de la ventana', async () => {
      const user = userEvent.setup();
      setup();

      await user.click(screen.getByRole('combobox'));
      const listbox = screen.getByRole('listbox');

      const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
        top: 100,
        bottom: 132,
        left: 300,
        right: 500,
        width: 200,
        height: 32,
      });
      act(() => {
        window.dispatchEvent(new Event('resize'));
      });

      expect(listbox.style.top).toBe('136px');
      expect(listbox.style.left).toBe('300px');
      expect(listbox.style.minWidth).toBe('200px');
      rect.mockRestore();
    });

    it('se reposiciona al hacer scroll en la página', async () => {
      const user = userEvent.setup();
      setup();

      await user.click(screen.getByRole('combobox'));
      const listbox = screen.getByRole('listbox');

      const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
        top: 20,
        bottom: 52,
        left: 16,
        right: 216,
        width: 200,
        height: 32,
      });
      act(() => {
        window.dispatchEvent(new Event('scroll'));
      });

      expect(listbox.style.top).toBe('56px');
      rect.mockRestore();
    });

    it('abre hacia arriba cuando no cabe debajo del control', async () => {
      const user = userEvent.setup();
      setup();
      const height = vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(500);

      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
        top: 380,
        bottom: 412,
        left: 16,
        right: 216,
        width: 200,
        height: 32,
      });
      await user.click(screen.getByRole('combobox'));

      const listbox = screen.getByRole('listbox');
      expect(listbox.style.top).toBe('');
      // 500 de ventana - 380 del control + 4 de separación.
      expect(listbox.style.bottom).toBe('124px');
      // Solo queda 76px debajo, así que el alto se recorta a lo que hay arriba.
      expect(listbox.style.maxHeight).toBe('288px');
      vi.restoreAllMocks();
      height.mockRestore();
    });
  });
});
