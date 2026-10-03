import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import ErrorPage from './ErrorPage';
import { cssVariables, contrastRatio } from '../test/contrast';

const renderPage = (props = {}) =>
  render(
    <ErrorPage
      code="404"
      title="Página no encontrada"
      description="La dirección solicitada no existe en SIFHA."
      detail={<>Ruta solicitada: /no-existe</>}
      actions={<button type="button">Volver al inicio</button>}
      {...props}
    />
  );

/** El token `var(--x)` que declara el propio elemento, no el que hereda. */
function tokenOf(element) {
  const match = String(element.className).match(/text-\[var\((--[a-z-]+)\)\]/);
  return match?.[1] || null;
}

describe('ErrorPage · contenido y estructura', () => {
  it('muestra código, título, explicación, detalle y acciones', () => {
    renderPage();

    expect(screen.getByText('404')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Página no encontrada' })).toBeInTheDocument();
    expect(screen.getByText('La dirección solicitada no existe en SIFHA.')).toBeInTheDocument();
    expect(screen.getByText(/Ruta solicitada: \/no-existe/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Volver al inicio' })).toBeInTheDocument();
  });

  it('en pantalla completa aporta su propio landmark main y el pie institucional', () => {
    const { container } = renderPage();

    // Un segundo `main` dentro del de `Layout` sería landmark duplicado.
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByText('SIFHA · Mesa de Ayuda')).toBeInTheDocument();
    expect(container.querySelectorAll('main')).toHaveLength(1);
  });

  it('dentro de la aplicación el título baja a h2 y no se duplica el landmark', () => {
    const { container } = renderPage({ embedded: true });

    // `Layout` ya pinta su propio h1 de página y su propio main.
    expect(screen.getByRole('heading', { level: 2, name: 'Página no encontrada' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
    expect(screen.queryByRole('main')).not.toBeInTheDocument();
    expect(screen.queryByText('SIFHA · Mesa de Ayuda')).not.toBeInTheDocument();
    expect(container.querySelectorAll('main')).toHaveLength(0);
  });

  it('el logotipo solo aparece en la versión de pantalla completa', () => {
    const { unmount } = renderPage({ showLogo: true });
    expect(screen.getByAltText('SIFHA')).toBeInTheDocument();
    expect(screen.getByAltText('SIFHA')).toHaveAttribute('src', '/logo/TSIFHA-PNG.png');
    unmount();

    renderPage({ showLogo: false });
    expect(screen.queryByAltText('SIFHA')).not.toBeInTheDocument();
  });

  it('el icono es decorativo y no añade un nombre accesible vacío', () => {
    const { container } = renderPage({
      code: undefined,
      icon: (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 9v4" />
        </svg>
      ),
    });

    expect(screen.queryByText('404')).not.toBeInTheDocument();
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('heading', { name: 'Página no encontrada' })).toBeInTheDocument();
  });
});

describe('ErrorPage · identidad visual SIFHA', () => {
  it('usa la paleta institucional y nada de degradados o violeta', () => {
    const { container } = renderPage();

    const html = container.innerHTML.toLowerCase();
    expect(html).not.toMatch(/gradient/);
    expect(html).not.toMatch(/violet|purple|fuchsia/);
    // Los colores salen de los tokens del tema, no de hex sueltos.
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,6}\b/i);
    expect(container.querySelector('.card')).toHaveClass('nex-pop');
  });

  it('los textos declaran tokens del tema, que es lo que cambia entre claro y oscuro', () => {
    renderPage({
      detail: <>Ruta solicitada: /no-existe</>,
      icon: <svg viewBox="0 0 24 24" aria-hidden="true" />,
    });

    expect(tokenOf(screen.getByRole('heading'))).toBe('--text');
    expect(tokenOf(screen.getByText('La dirección solicitada no existe en SIFHA.'))).toBe('--text-muted');
    expect(tokenOf(screen.getByText('404'))).toBe('--brand');
    // La ruta se lee con el color de texto, no con el secundario: sobre
    // `--surface-secondary` ese gris no llega al mínimo en tema claro.
    expect(tokenOf(screen.getByText(/Ruta solicitada/))).toBe('--text');
  });
});

describe('ErrorPage · responsive', () => {
  it('en móvil apila las acciones a lo ancho y a partir de sm las pone en fila', () => {
    const { container } = renderPage();

    const acciones = screen.getByRole('button', { name: 'Volver al inicio' }).parentElement;
    expect(acciones).toHaveClass('flex-col');
    expect(acciones).toHaveClass('sm:flex-row');
    expect(acciones).toHaveClass('w-full');
    // Sin anchos fijos: el `min-width` del body ya fija el suelo en 320px.
    expect(acciones.className).not.toMatch(/w-\[\d+px\]|min-w-\[\d+px\]/);
  });

  it('la tarjeta se adapta al viewport con padding lateral y ancho máximo', () => {
    const { container } = renderPage();

    const tarjeta = container.querySelector('.card');
    expect(tarjeta).toHaveClass('p-6');
    expect(tarjeta).toHaveClass('sm:p-8');
    expect(tarjeta.className).not.toMatch(/vw/);

    const pantalla = screen.getByRole('main');
    expect(pantalla).toHaveClass('px-4', 'py-10');
    expect(pantalla.className).toMatch(/max-w-lg|min-h-screen/);
    // El ancho máximo va en la columna central, no en el landmark.
    const columna = pantalla.firstElementChild;
    expect(columna).toHaveClass('w-full');
    expect(columna.className).toMatch(/max-w-lg/);
  });

  it('la variante embebida también limita el ancho dentro del main de Layout', () => {
    const { container } = renderPage({ embedded: true });

    const contenedor = container.querySelector('.card').parentElement;
    expect(contenedor).toHaveClass('w-full');
    expect(contenedor.className).toMatch(/max-w-xl/);
  });
});

describe('ErrorPage · accesibilidad', () => {
  it('el título es un encabezado y las acciones son alcanzables con teclado', () => {
    const { container } = renderPage({ actions: <><a href="/app">Inicio</a><button type="button">Atrás</button></> });

    const titulo = screen.getByRole('heading', { name: 'Página no encontrada' });
    expect(titulo.tagName).toBe('H1');
    // Botones y enlaces nativos: heredan foco, activación por Enter y por Espacio.
    expect(screen.getByRole('link', { name: 'Inicio' })).toBeInTheDocument();
    expect(within(container).getByRole('button', { name: 'Atrás' })).toBeInTheDocument();
  });

  it('mantiene el mínimo de contraste en claro y en oscuro', () => {
    const claro = cssVariables(':root');
    const oscuro = cssVariables(":root[data-theme='dark']");

    // Los mínimos WCAG: 4.5:1 para texto normal y 3:1 para texto grande o iconos.
    const combinaciones = [
      ['título', '--text', '--surface', 4.5],
      ['explicación', '--text-muted', '--surface', 4.5],
      ['código de estado', '--brand', '--surface', 3],
      ['detalle de la ruta', '--text', '--surface-secondary', 4.5],
      ['icono de aviso', '--warning', '--surface-secondary', 3],
    ];

    for (const [label, fg, bg, min] of combinaciones) {
      expect(contrastRatio(claro[fg], claro[bg]), `${label} en claro`).toBeGreaterThanOrEqual(min);
      expect(contrastRatio(oscuro[fg], oscuro[bg]), `${label} en oscuro`).toBeGreaterThanOrEqual(min);
    }
  });
});