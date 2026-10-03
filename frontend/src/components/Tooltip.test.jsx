import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Tooltip from './Tooltip';
import { cssVariables, contrastRatio } from '../test/contrast';

// jsdom no mide nada, así que la geometría se falsea: es lo único que permite
// comprobar que la burbuja se coloca donde toca en vez de en (0,0).
function rect({ top, left, width, height }) {
  return {
    top,
    left,
    width,
    height,
    bottom: top + height,
    right: left + width,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}

/**
 * Fija la geometría: la burbuja se distingue por `role="tooltip"` y el
 * disparador es el resto (el `<span class="inline-flex">` que envuelve al
 * control, o el propio botón si se consulta).
 */
function stubGeometry({ trigger: t = {}, bubble: b = {} }) {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function () {
    if (this.getAttribute?.('role') === 'tooltip') return rect(b);
    return rect(t);
  });
}

const control = () => screen.getByRole('button', { name: 'Guardar' });
const bubble = () => screen.queryByRole('tooltip');
const aparecer = () => waitFor(() => expect(bubble()).toBeInTheDocument(), { timeout: 2000 });
// wait bubble() no sirve: devuelve null al instante, porque la apertura tiene retardo.
const abierto = async () => {
  await aparecer();
  return bubble();
};
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  window.innerWidth = 1280;
  window.innerHeight = 800;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Tooltip · aparición con ratón', () => {
  it('no aparece al montar: sólo al posar el puntero', async () => {
    const user = userEvent.setup();
    render(<Tooltip text="Guardar cambios"><button type="button">Guardar</button></Tooltip>);

    expect(bubble()).toBeNull();
    await user.hover(control());
    await aparecer();
    expect(bubble()).toHaveTextContent('Guardar cambios');
  });

  it('espera un instante antes de mostrarse, para no parpadear al recorrer una tabla', async () => {
    const user = userEvent.setup();
    render(<Tooltip text="Guardar cambios"><button type="button">Guardar</button></Tooltip>);

    await user.hover(control());
    await esperar(60);
    expect(bubble()).toBeNull();
    await aparecer();
  });

  it('no aparece si no hay texto que mostrar', async () => {
    const user = userEvent.setup();
    render(<Tooltip text=""><button type="button">Guardar</button></Tooltip>);

    await user.hover(control());
    await esperar(500);
    expect(bubble()).toBeNull();
  });

  it('no deja el tooltip colgando si se sale antes del retardo', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Tooltip text="Guardar cambios"><button type="button">Guardar</button></Tooltip>
        <button type="button">Otro</button>
      </>
    );

    await user.hover(control());
    await user.unhover(control());
    await esperar(500);

    expect(bubble()).toBeNull();
  });
});

describe('Tooltip · aparición con teclado', () => {
  it('aparece al recibir el foco del teclado', async () => {
    const user = userEvent.setup();
    render(<Tooltip text="Guardar cambios"><button type="button">Guardar</button></Tooltip>);

    await user.tab();
    expect(control()).toHaveFocus();
    expect(await abierto()).toHaveTextContent('Guardar cambios');
  });

  it('funciona igual sin eventos de puntero, como ocurre en algunos entornos', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<Tooltip text="Guardar cambios"><button type="button">Guardar</button></Tooltip>);

    await user.tab();
    expect(await abierto()).toBeInTheDocument();
  });

  it('Escape lo cierra sin mover el foco, para poder seguir con el control', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Tooltip text="Guardar cambios"><button type="button">Guardar</button></Tooltip>
        <button type="button">Otro</button>
      </>
    );

    await user.tab();
    await aparecer();
    await user.keyboard('{Escape}');

    await waitFor(() => expect(bubble()).not.toBeInTheDocument());
    expect(control()).toHaveFocus();
  });

  it('se oculta al pasar el foco al siguiente control', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Tooltip text="Guardar cambios"><button type="button">Guardar</button></Tooltip>
        <Tooltip text="Cancelar"><button type="button">Cancelar</button></Tooltip>
      </>
    );

    await user.tab();
    await aparecer();
    await user.tab();

    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Cancelar' })).toHaveFocus();
  });
});

describe('Tooltip · ocultamiento', () => {
  it('se oculta al salir el puntero', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Tooltip text="Guardar cambios"><button type="button">Guardar</button></Tooltip>
        <button type="button">Otro</button>
      </>
    );

    await user.hover(control());
    await aparecer();
    await user.hover(screen.getByRole('button', { name: 'Otro' }));

    await waitFor(() => expect(bubble()).not.toBeInTheDocument());
  });

  it('se cierra al desplazar la página, para no quedar apuntando al vacío', async () => {
    const user = userEvent.setup();
    render(<Tooltip text="Guardar cambios"><button type="button">Guardar</button></Tooltip>);

    await user.hover(control());
    await aparecer();
    window.dispatchEvent(new Event('scroll'));

    await waitFor(() => expect(bubble()).not.toBeInTheDocument());
  });

  it('se cierra al redimensionar, porque la posición calculada ya no vale', async () => {
    const user = userEvent.setup();
    render(<Tooltip text="Guardar cambios"><button type="button">Guardar</button></Tooltip>);

    await user.hover(control());
    await aparecer();
    window.dispatchEvent(new Event('resize'));

    await waitFor(() => expect(bubble()).not.toBeInTheDocument());
  });

  it('desaparece de verdad al desmontar el componente', async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <Tooltip text="Guardar cambios"><button type="button">Guardar</button></Tooltip>
    );

    await user.hover(control());
    await aparecer();
    unmount();

    expect(bubble()).toBeNull();
  });

  it('el control sigue funcionando igual con el tooltip encima', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Tooltip text="Guardar cambios">
        <button type="button" onClick={onClick}>Guardar</button>
      </Tooltip>
    );

    await user.click(control());

    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('Tooltip · asociación accesible', () => {
  it('el texto es descripción del control y no sustituye a su nombre', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip text="Se guarda en el servidor">
        <button type="button" aria-label="Guardar">icono</button>
      </Tooltip>
    );

    const boton = screen.getByRole('button', { name: 'Guardar' });
    const describedby = boton.getAttribute('aria-describedby');
    expect(describedby).toBeTruthy();

    await user.hover(boton);
    const el = await abierto();
    expect(el).toHaveAttribute('id', describedby);
    expect(el).toHaveAttribute('role', 'tooltip');
    // El nombre sigue siendo "Guardar", no el texto del tooltip.
    expect(screen.getByRole('button', { name: 'Guardar' })).toBe(boton);
  });

  it('un control sólo con icono conserva su nombre accesible', () => {
    render(
      <Tooltip text="Quitar archivo">
        <button type="button" aria-label="Quitar archivo">✕</button>
      </Tooltip>
    );

    expect(screen.getByRole('button', { name: 'Quitar archivo' })).toBeInTheDocument();
  });

  it('no pisa un aria-describedby que el control ya tuviera', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Tooltip text="Segundo tooltip">
          <button type="button" aria-label="Guardar" aria-describedby="nota-externa">
            Guardar
          </button>
        </Tooltip>
        <p id="nota-externa">Atajo: Ctrl+S</p>
      </>
    );

    const ids = screen.getByRole('button', { name: 'Guardar' }).getAttribute('aria-describedby').split(' ');
    expect(ids).toContain('nota-externa');

    await user.hover(screen.getByRole('button', { name: 'Guardar' }));
    expect(ids).toContain((await abierto()).id);
  });

  it('con describe={false} la burbuja es sólo visual y no se anuncia dos veces', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip text="Fuera de plazo" describe={false}>
        <span role="img" aria-label="Fuera de plazo" />
      </Tooltip>
    );

    const marca = screen.getByRole('img', { name: 'Fuera de plazo' });
    expect(marca).not.toHaveAttribute('aria-describedby');

    await user.hover(marca);
    // Sin `role="tooltip"` no entra en el árbol accesible, pero se ve en pantalla.
    await esperar(400);
    expect(screen.queryByRole('tooltip')).toBeNull();
    const visual = document.querySelector('[aria-hidden="true"]');
    expect(visual).toHaveTextContent('Fuera de plazo');
  });

  it('cada tooltip tiene su identificador, sin ids escritos a mano', () => {
    render(
      <>
        <Tooltip text="Primero"><button type="button">A</button></Tooltip>
        <Tooltip text="Segundo"><button type="button">B</button></Tooltip>
      </>
    );

    const [a, b] = screen.getAllByRole('button');
    const idA = a.getAttribute('aria-describedby');
    const idB = b.getAttribute('aria-describedby');
    expect(idA).toBeTruthy();
    expect(idB).toBeTruthy();
    expect(idA).not.toBe(idB);
    // Sin espacios: un id con espacio rompería la referencia.
    expect(idA).not.toMatch(/\s/);
  });
});

describe('Tooltip · tema claro/oscuro y movimiento reducido', () => {
  it('usa tokens del tema, que es lo que cambia entre claro y oscuro', async () => {
    const user = userEvent.setup();
    render(<Tooltip text="Guardar cambios"><button type="button">Guardar</button></Tooltip>);

    await user.hover(control());
    const el = await abierto();

    expect(el).toHaveClass('bg-[var(--surface-elevated)]');
    expect(el).toHaveClass('text-[var(--text)]');
    expect(el).toHaveClass('border-[var(--border)]');
    expect(el.className).not.toMatch(/#[0-9a-f]{3,6}\b/i);
    expect(el.className).not.toMatch(/gradient|violet|purple/);
  });

  it('mantiene el contraste mínimo en claro y en oscuro', () => {
    const claro = cssVariables(':root');
    const oscuro = cssVariables(":root[data-theme='dark']");

    expect(contrastRatio(claro['--text'], claro['--surface-elevated'])).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(oscuro['--text'], oscuro['--surface-elevated'])).toBeGreaterThanOrEqual(4.5);
  });

  it('la animación es la del proyecto, ya neutralizada con prefers-reduced-motion', async () => {
    const user = userEvent.setup();
    render(<Tooltip text="Guardar cambios"><button type="button">Guardar</button></Tooltip>);

    await user.hover(control());
    // `nex-fade` está cubierta por la regla global de index.css que deja la
    // duración en ~0 cuando el sistema pide movimiento reducido.
    expect(await abierto()).toHaveClass('nex-fade');
  });

  it('no intercepta el puntero: la burbuja no tapa el control ni las filas de al lado', async () => {
    const user = userEvent.setup();
    render(<Tooltip text="Guardar cambios"><button type="button">Guardar</button></Tooltip>);

    await user.hover(control());
    expect(await abierto()).toHaveClass('pointer-events-none');
  });
});

describe('Tooltip · posición', () => {
  const medidas = { trigger: { top: 300, left: 300, width: 80, height: 32 }, bubble: { top: 0, left: 0, width: 120, height: 28 } };

  it('se coloca encima del control, sin taparlo', async () => {
    stubGeometry(medidas);
    const user = userEvent.setup();
    render(<Tooltip text="Guardar cambios"><button type="button">Guardar</button></Tooltip>);

    await user.hover(control());
    const el = await abierto();
    await waitFor(() => expect(el.style.visibility).not.toBe('hidden'));

    // Arriba del disparador, con 8px de separación: 300 - 28 - 8.
    expect(el.style.top).toBe('264px');
    // Centrado en el disparador: 300 + 40 - 60.
    expect(el.style.left).toBe('280px');
  });

  it('se da la vuelta abajo cuando arriba no cabe', async () => {
    stubGeometry({ ...medidas, trigger: { top: 4, left: 300, width: 80, height: 32 } });
    const user = userEvent.setup();
    render(<Tooltip text="Guardar cambios"><button type="button">Guardar</button></Tooltip>);

    await user.hover(control());
    const el = await abierto();
    await waitFor(() => expect(el.style.visibility).not.toBe('hidden'));

    // 4px de espacio arriba no bastan, así que baja: borde inferior + 8px.
    expect(el.style.top).toBe('44px');
  });

  it('respeta la preferencia de colocar abajo', async () => {
    stubGeometry(medidas);
    const user = userEvent.setup();
    render(
      <Tooltip text="Guardar cambios" placement="bottom">
        <button type="button">Guardar</button>
      </Tooltip>
    );

    await user.hover(control());
    const el = await abierto();
    await waitFor(() => expect(el.style.visibility).not.toBe('hidden'));

    expect(el.style.top).toBe('340px');
  });

  it('se recorta al viewport en pantallas estrechas', async () => {
    window.innerWidth = 400;
    stubGeometry({
      trigger: { top: 300, left: 360, width: 32, height: 32 },
      bubble: { top: 0, left: 0, width: 200, height: 28 },
    });
    const user = userEvent.setup();
    render(<Tooltip text="Un texto de tooltip bastante largo"><button type="button">Guardar</button></Tooltip>);

    await user.hover(control());
    const el = await abierto();
    await waitFor(() => expect(el.style.visibility).not.toBe('hidden'));

    const left = Number.parseInt(el.style.left, 10);
    // 8px de margen mínimo y la burbuja entera dentro de la ventana.
    expect(left).toBeGreaterThanOrEqual(8);
    expect(left + 200).toBeLessThanOrEqual(400 - 8);
  });

  it('limita su ancho al viewport para no desbordarse en móvil', async () => {
    const user = userEvent.setup();
    render(<Tooltip text="Un texto de tooltip bastante largo"><button type="button">Guardar</button></Tooltip>);

    await user.hover(control());
    const el = await abierto();

    expect(el).toHaveClass('max-w-[min(18rem,calc(100vw-1.5rem))]');
  });

  it('no se dibuja en (0,0) mientras se mide: nace invisible y ya colocada', async () => {
    stubGeometry(medidas);
    const user = userEvent.setup();
    render(<Tooltip text="Guardar cambios"><button type="button">Guardar</button></Tooltip>);

    await user.hover(control());
    // Lo que se ve primero ya está en su sitio: el efecto de layout mide antes
    // del primer pintado, así que no hay salto visible.
    const el = await abierto();
    await waitFor(() => expect(el.style.visibility).not.toBe('hidden'));
    expect(el.style.visibility).toBe('');
  });
});