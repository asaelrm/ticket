import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ToastProvider, useToast } from './Toast';
import { cssVariables, contrastRatio } from '../test/contrast';

const MSJ = {
  success: 'Categoría creada',
  info: 'Reporte listo',
  warning: 'Quedan 3 intentos',
  error: 'El navegador bloqueó la ventana del PDF. Habilite las ventanas emergentes e intente nuevamente.',
};

function Botonera() {
  const { success, info, warning, error } = useToast();
  const [dialogo, setDialogo] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => success(MSJ.success)}>Mostrar éxito</button>
      <button type="button" onClick={() => info(MSJ.info)}>Mostrar información</button>
      <button type="button" onClick={() => warning(MSJ.warning)}>Mostrar aviso</button>
      <button type="button" onClick={() => error(MSJ.error)}>Mostrar error</button>
      <button type="button" onClick={() => error('Error con plazo', { duration: 1500 })}>Mostrar error con plazo</button>
      <button type="button" onClick={() => success('Duplicado de prueba')}>Mostrar duplicado éxito</button>
      <button type="button" onClick={() => error('Duplicado de prueba')}>Mostrar duplicado error</button>
      <button type="button" onClick={() => setDialogo(true)}>Abrir diálogo</button>
      <button type="button">Control principal</button>
      {dialogo && (
        <div role="dialog" aria-modal="true">
          <p>Diálogo abierto</p>
        </div>
      )}
    </div>
  );
}

const montar = () => render(
  <ToastProvider>
    <Botonera />
  </ToastProvider>
);

const avisos = () => screen.queryAllByTestId('toast');
const region = () => screen.getByTestId('toast-region');
const pulsar = (texto) => fireEvent.click(screen.getByRole('button', { name: texto }));
const avancar = (ms) => act(() => { vi.advanceTimersByTime(ms); });
const cierre = () => screen.getByRole('button', { name: 'Cerrar notificación' });

describe('Toast · región de anuncios', () => {
  it('monta la región aunque esté vacía, con role=status, polite y no atómico', () => {
    montar();

    const reg = region();
    expect(reg).toBeInTheDocument();
    expect(reg).toHaveAttribute('role', 'status');
    expect(reg).toHaveAttribute('aria-live', 'polite');
    expect(reg).toHaveAttribute('aria-atomic', 'false');
    expect(reg.children).toHaveLength(0);
    // Vacía no tiene nada que anunciar, pero sigue siendo una región de estado.
    expect(reg).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('status', { hidden: true })).toBe(reg);
    expect(screen.queryAllByTestId('toast')).toHaveLength(0);
  });

  it('al entrar un aviso la región se anuncia y no usa role=alert', () => {
    montar();
    pulsar('Mostrar error');

    const reg = screen.getByRole('status');
    expect(reg).not.toHaveAttribute('aria-hidden');
    expect(reg).toHaveTextContent(MSJ.error);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('ofrece un botón de cerrar con el nombre accesible exacto', () => {
    montar();
    pulsar('Mostrar éxito');

    expect(screen.getByRole('button', { name: 'Cerrar notificación' })).toBeInTheDocument();
  });

  it('el icono es decorativo y el tipo se dice también en texto', () => {
    montar();
    pulsar('Mostrar error');

    const aviso = screen.getByTestId('toast');
    const adornos = aviso.querySelectorAll('[aria-hidden="true"]');
    // Barra de acento, icono y la x del botón: los tres ocultos.
    expect(adornos).toHaveLength(3);
    expect(adornos[1]).toHaveTextContent('✕');
    expect(aviso.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    // El mensaje no depende sólo del color: lleva el tipo en texto.
    expect(aviso.querySelector('p')).toHaveTextContent('Error: ' + MSJ.error);
  });

  it('no roba el foco ni mueve el que ya tenía la página', () => {
    montar();
    const principal = screen.getByRole('button', { name: 'Control principal' });
    principal.focus();

    pulsar('Mostrar error');

    expect(principal).toHaveFocus();
    expect(cierre()).not.toHaveFocus();
  });
});

describe('Toast · duración', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('success se cierra a los 4 segundos', () => {
    montar();
    pulsar('Mostrar éxito');
    expect(avisos()).toHaveLength(1);

    avancar(3999);
    expect(avisos()).toHaveLength(1);
    avancar(1);
    expect(avisos()).toHaveLength(0);
  });

  it('info se cierra a los 4 segundos', () => {
    montar();
    pulsar('Mostrar información');

    avancar(3999);
    expect(avisos()).toHaveLength(1);
    avancar(1);
    expect(avisos()).toHaveLength(0);
  });

  it('warning se cierra a los 6 segundos', () => {
    montar();
    pulsar('Mostrar aviso');

    avancar(5999);
    expect(avisos()).toHaveLength(1);
    avancar(1);
    expect(avisos()).toHaveLength(0);
  });

  it('error es persistente y sólo se cierra a mano', () => {
    montar();
    pulsar('Mostrar error');

    avancar(120000);
    expect(avisos()).toHaveLength(1);
    expect(screen.getByText(MSJ.error)).toBeInTheDocument();

    fireEvent.click(cierre());
    expect(avisos()).toHaveLength(0);
  });

  it('error admite un plazo explícito cuando no debe quedarse fijo', () => {
    montar();
    pulsar('Mostrar error con plazo');

    avancar(1499);
    expect(avisos()).toHaveLength(1);
    avancar(1);
    expect(avisos()).toHaveLength(0);
  });

  it('un duplicado reinicia su temporizador sin crear otro nodo', () => {
    montar();
    pulsar('Mostrar éxito');
    const nodo = screen.getByTestId('toast');

    avancar(3000);
    pulsar('Mostrar éxito');

    expect(screen.getAllByTestId('toast')).toHaveLength(1);
    expect(screen.getByTestId('toast')).toBe(nodo);

    // 3999 ms desde el primer aviso ya no bastan: el reloj arrancó de nuevo.
    avancar(3999);
    expect(avisos()).toHaveLength(1);
    avancar(1);
    expect(avisos()).toHaveLength(0);
  });

  it('limpia todos los temporizadores al desmontar', () => {
    const { unmount } = montar();
    pulsar('Mostrar éxito');
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('Toast · límite de visibles y duplicados', () => {
  it('el cuarto aviso descarta el más antiguo y conserva el nuevo', () => {
    montar();

    pulsar('Mostrar éxito');
    pulsar('Mostrar información');
    pulsar('Mostrar aviso');
    pulsar('Mostrar error');

    expect(avisos()).toHaveLength(3);
    expect(screen.queryByText(MSJ.success)).not.toBeInTheDocument();
    expect(screen.getByText(MSJ.info)).toBeInTheDocument();
    expect(screen.getByText(MSJ.warning)).toBeInTheDocument();
    expect(screen.getByText(MSJ.error)).toBeInTheDocument();
  });

  it('un duplicado visible no crea un segundo nodo', () => {
    montar();
    const boton = screen.getByRole('button', { name: 'Mostrar éxito' });

    fireEvent.click(boton);
    const primero = screen.getByTestId('toast');
    fireEvent.click(boton);

    expect(screen.getAllByTestId('toast')).toHaveLength(1);
    expect(screen.getByTestId('toast')).toBe(primero);
    expect(screen.queryAllByText(MSJ.success)).toHaveLength(1);
  });

  it('deduplica por tipo Y mensaje: el mismo texto con otro tipo sí suma', () => {
    montar();

    pulsar('Mostrar duplicado éxito');
    pulsar('Mostrar duplicado error');

    expect(avisos()).toHaveLength(2);
    expect(screen.getAllByText('Duplicado de prueba')).toHaveLength(2);
  });
});

describe('Toast · cierre', () => {
  it('el botón de cerrar sólo descarta su aviso', async () => {
    const user = userEvent.setup();
    montar();

    await user.click(screen.getByRole('button', { name: 'Mostrar éxito' }));
    await user.click(screen.getByRole('button', { name: 'Mostrar aviso' }));
    expect(avisos()).toHaveLength(2);

    // El más antiguo es el de éxito: cerrarlo deja el aviso en pie.
    await user.click(screen.getAllByRole('button', { name: 'Cerrar notificación' })[0]);

    expect(avisos()).toHaveLength(1);
    expect(screen.getByText(MSJ.warning)).toBeInTheDocument();
  });

  it('Escape cierra el aviso más reciente', async () => {
    const user = userEvent.setup();
    montar();

    await user.click(screen.getByRole('button', { name: 'Mostrar éxito' }));
    await user.click(screen.getByRole('button', { name: 'Mostrar aviso' }));
    expect(avisos()).toHaveLength(2);

    await user.keyboard('{Escape}');
    expect(avisos()).toHaveLength(1);
    expect(screen.queryByText(MSJ.warning)).not.toBeInTheDocument();
    expect(screen.getByText(MSJ.success)).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(avisos()).toHaveLength(0);
  });

  it('Escape no se lo lleva cuando hay un diálogo modal abierto', async () => {
    const user = userEvent.setup();
    montar();

    await user.click(screen.getByRole('button', { name: 'Mostrar aviso' }));
    await user.click(screen.getByRole('button', { name: 'Abrir diálogo' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await user.keyboard('{Escape}');

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(MSJ.warning)).toBeInTheDocument();
  });
});

describe('Toast · tema claro/oscuro', () => {
  it('usa tokens del proyecto y no colores sueltos', () => {
    montar();
    pulsar('Mostrar error');

    const el = screen.getByTestId('toast');
    expect(el).toHaveClass('bg-[var(--surface-elevated)]');
    expect(el).toHaveClass('text-[var(--text)]');
    expect(el).toHaveClass('border-[var(--border)]');
    expect(el.className).not.toMatch(/#[0-9a-f]{3,6}\b/i);
    // La animación es la del proyecto, ya neutralizada con prefers-reduced-motion.
    expect(el).toHaveClass('nex-pop');
  });

  it('mantiene el contraste mínimo en claro y en oscuro', () => {
    const claro = cssVariables(':root');
    const oscuro = cssVariables(":root[data-theme='dark']");

    for (const tema of [claro, oscuro]) {
      expect(contrastRatio(tema['--text'], tema['--surface-elevated'])).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(tema['--text-muted'], tema['--surface-elevated'])).toBeGreaterThanOrEqual(4.5);
      for (const tokeno of ['--success', '--info', '--warning', '--danger']) {
        expect(contrastRatio(tema[tokeno], tema['--surface-elevated'])).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe('Toast · fuera del proveedor', () => {
  it('explica con claridad que falta ToastProvider', () => {
    const silencio = vi.spyOn(console, 'error').mockImplementation(() => {});
    let capturado = null;

    class Boundary extends React.Component {
      state = { error: null };
      static getDerivedStateFromError(error) {
        capturado = error;
        return { error };
      }
      render() {
        return this.state.error ? null : this.props.children;
      }
    }

    function SinProveedor() {
      useToast();
      return null;
    }

    render(
      <Boundary>
        <SinProveedor />
      </Boundary>
    );

    expect(capturado).toBeInstanceOf(Error);
    expect(capturado.message).toMatch(/ToastProvider/);
    silencio.mockRestore();
  });
});

// Lo que un test de jsdom no puede comprobar es si el aviso se ve de verdad: ahí
// no hay layout ni CSS, así que toda esta sección comprueba el CONTRATO que
// hace visible el aviso. Ese contrato tiene dos capas:
//
//  1. El punto de entrada real monta el proveedor. Si `main.jsx` se sirve sin él,
//     la aplicación abre y las páginas funcionan, pero ningún aviso aparece:
//     es exactamente lo que se vio en el navegador manual, y ninguna prueba de
//     página lo detecta porque cada una monta su propio proveedor.
//  2. La región se ancla al viewport en `document.body`, fuera del subárbol que
//     la dispara. Sin eso el aviso puede quedar tapado por un overlay o recortado
//     por un ancestro con `overflow`/`transform`, igual que pasaba con los
//     Modales y el menú de Select (ver el comentario de `ui.jsx`).
describe('Toast · contrato de visibilidad', () => {
  it('el punto de entrada real monta ToastProvider alrededor de la aplicación', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/main.jsx'), 'utf8');

    expect(src).toMatch(/import\s*\{\s*ToastProvider\s*\}\s*from\s*'\.\/components\/Toast'/);
    // El orden importa: el aviso nace en el mismo nodo que la app para no perder
    // los avisos al cambiar de ruta.
    expect(src).toMatch(/<ToastProvider>[\s\S]*<App\s*\/>[\s\S]*<\/ToastProvider>/);
  });

  it('el aviso sale del subárbol que lo dispara aunque ese nodo recorte', () => {
    render(
      <ToastProvider>
        <div data-testid="recorte" className="overflow-hidden" style={{ transform: 'translateZ(0)' }}>
          <Botonera />
        </div>
      </ToastProvider>
    );

    pulsar('Mostrar éxito');

    const reg = region();
    expect(reg.parentElement).toBe(document.body);
    expect(screen.getByTestId('recorte').contains(reg)).toBe(false);
    expect(screen.getByTestId('toast')).toBeInTheDocument();
  });

  it('la región queda anclada al viewport y por encima de los overlays de la aplicación', () => {
    montar();
    pulsar('Mostrar éxito');

    const reg = region();
    expect(reg).toHaveClass('fixed', 'inset-x-0', 'bottom-0');
    // `pointer-events-none` deja pasar los clics a la página de debajo y el
    // aviso los recupera con `pointer-events-auto`: si el contenedor se quedara
    // con `none`, el botón de cerrar no respondería.
    expect(reg).toHaveClass('pointer-events-none');
    expect(screen.getByTestId('toast')).toHaveClass('pointer-events-auto');

    // Modales, cajones, Select, Notificaciones y la barra de tickets llegan a
    // z-50 y z-40: por debajo de eso, un overlay abierto taparía el aviso.
    const z = reg.className.match(/z-\[(\d+)\]/);
    expect(z).not.toBeNull();
    expect(Number(z[1])).toBeGreaterThan(50);
  });
});
