import React from 'react';
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import { Skeleton, SkeletonGroup, SkeletonText } from './ui';

// El esqueleto se apoya en el tema, asÃ­ que su contrato de color y de animaciÃ³n
// vive en la hoja de estilos y no se puede comprobar de forma fiable en jsdom:
// se lee el CSS, igual que hace Select.test.jsx con `.select-menu`.
const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

// Devuelve el cuerpo de una regla a partir de su selector completo, con punto
// incluido: `rule('.skeleton')`.
function rule(selector) {
  const match = css.match(new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`));
  expect(match, `no se encuentra la regla ${selector} en index.css`).not.toBeNull();
  return match[1];
}

describe('Skeleton', () => {
  it('es un bloque decorativo con las medidas que le pasa quien lo usa', () => {
    render(<Skeleton className="h-4 w-24 rounded-full" />);

    const block = document.querySelector('.skeleton');
    expect(block).toBeInTheDocument();
    expect(block).toHaveClass('h-4', 'w-24', 'rounded-full');
    // Adorno: la tecnologÃ­a de asistencia tÃ©cnica no debe leerlo.
    expect(block).toHaveAttribute('aria-hidden', 'true');
  });

  it('acepta atributos propios sin perder los de la clase', () => {
    render(<Skeleton data-testid="bloque" className="h-3" />);

    expect(screen.getByTestId('bloque')).toHaveClass('skeleton', 'h-3');
  });
});

describe('SkeletonText', () => {
  it('dibuja una lÃ­nea por pÃ¡rrafo pedido y deja la Ãºltima mÃ¡s corta', () => {
    const { container } = render(<SkeletonText lines={3} />);

    const lines = container.querySelectorAll('.skeleton');
    expect(lines).toHaveLength(3);
    // Sin acortar, un pÃ¡rrafo se lee como una caja maciza: el texto real casi
    // nunca llena el ancho del todo.
    expect(lines[0].className).toContain('w-full');
    expect(lines[2].className).toContain('60%');
    expect(lines[2].className).not.toContain('w-full');
  });

  it('con una sola lÃ­nea la deja a lo ancho, porque no hay Ãºltima', () => {
    const { container } = render(<SkeletonText lines={1} />);

    const line = container.querySelector('.skeleton');
    expect(line).toHaveClass('w-full');
    expect(line.className).not.toContain('60%');
  });

  it('acepta la medida de lÃ­nea que le pase quien lo usa', () => {
    const { container } = render(<SkeletonText lines={2} lineClassName="h-5" />);

    container.querySelectorAll('.skeleton').forEach((line) => {
      expect(line).toHaveClass('h-5');
    });
  });
});

describe('SkeletonGroup', () => {
  it('anuncia la carga una sola vez y deja los bloques fuera del anuncio', () => {
    render(
      <SkeletonGroup label="Cargando dashboardâ€¦">
        <Skeleton className="h-4" />
      </SkeletonGroup>
    );

    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(region).toHaveAttribute('aria-live', 'polite');
    // Un Ãºnico mensaje para toda la regiÃ³n: los bloques son adorno y no aÃ±aden
    // texto que anunciar.
    expect(within(region).getAllByText('Cargando dashboardâ€¦')).toHaveLength(1);
    // La etiqueta es sÃ³lo visual para el lector de pantalla.
    expect(screen.getByText('Cargando dashboardâ€¦')).toHaveClass('sr-only');
  });
});

describe('Skeleton Â· contrato de tema', () => {
  it('el bloque se pinta con los tokens del tema, no con colores sueltos', () => {
    const body = rule('.skeleton');

    expect(body).toMatch(/background-color:\s*var\(--skeleton-base\)/);
    expect(body).toMatch(/linear-gradient\([^)]*var\(--skeleton-sheen\)/);
  });

  it('los dos temas declaran su propio par de tonos', () => {
    // Claro y oscuro no pueden compartir el mismo valor: con --skeleton-base
    // igual en ambos, el bloque desaparece sobre la superficie oscura.
    const light = css.match(/:root\s*\{([\s\S]*?)\}/)[1];
    const dark = css.match(/:root\[data-theme='dark'\]\s*\{([\s\S]*?)\}/)[1];

    const base = (block) => block.match(/--skeleton-base:\s*([^;]+);/)[1].trim();
    const sheen = (block) => block.match(/--skeleton-sheen:\s*([^;]+);/)[1].trim();

    expect(light).toMatch(/--skeleton-base:/);
    expect(light).toMatch(/--skeleton-sheen:/);
    expect(dark).toMatch(/--skeleton-base:/);
    expect(dark).toMatch(/--skeleton-sheen:/);
    expect(base(light)).not.toBe(base(dark));
    expect(sheen(light)).not.toBe(sheen(dark));
  });

  it('la animaciÃ³n es un brillo lateral y lento, no un parpadeo', () => {
    const body = rule('.skeleton');
    const keyframes = css.match(/@keyframes sifha-skeleton\s*\{([\s\S]*?)\}\s*\}/);

    expect(body).toMatch(/animation:\s*sifha-skeleton/);
    // `ease-in-out` y sin parpadeo: el brillo tiene que poder recorrerse entero
    // sin marear ni distraer de la lectura.
    expect(body).toMatch(/ease-in-out/);
    expect(keyframes).not.toBeNull();
    expect(keyframes[1]).toMatch(/background-position/);
  });

  it('con movimiento reducido el bloque se queda quieto y sin el brillo a medias', () => {
    const reduced = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.skeleton\s*\{([^}]*)\}/);

    expect(reduced).not.toBeNull();
    expect(reduced[1]).toMatch(/animation:\s*none/);
    // Sin quitar el degradado, la barra quedarÃ­a congelada a mitad del barrido.
    expect(reduced[1]).toMatch(/background-image:\s*none/);
  });

  it('el bloque vive en la capa de componentes para que manden las utilidades', () => {
    // Fuera de capa, `rounded-xl` o `h-10` no prevalecerÃ­an sobre el esqueleto
    // y todos los huecos habrÃ­a que medirlos con `!important`.
    const layered = css.match(/@layer components\s*\{([\s\S]*?)\n\}/);

    expect(layered).not.toBeNull();
    expect(layered[1]).toContain('.skeleton');
  });
});
