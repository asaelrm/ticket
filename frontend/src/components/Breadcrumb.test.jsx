import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Breadcrumb from './Breadcrumb';

// La miga usa `Link`, así que necesita un router. `MemoryRouter` basta: lo que
// se comprueba son el marcado y el destino del enlace, no el navegador.
function renderBreadcrumb(ui, { route = '/app/tickets/1' } = {}) {
  return render(<MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>);
}

const CRUMBS = [
  { label: 'Tickets', to: '/app/tickets' },
  { label: 'TCK-000123', to: '/app/tickets/1' },
];

describe('Breadcrumb', () => {
  it('es una región de navegación con nombre y una lista ordenada', () => {
    renderBreadcrumb(<Breadcrumb items={CRUMBS} />);

    const nav = screen.getByRole('navigation', { name: 'Ruta de navegación' });
    expect(nav.tagName).toBe('NAV');
    // Una lista, no un div con flechitas: es lo que la tecnología de asistencia
    // técnica sabe recorrer y anunciar como "1 de 2".
    const items = within(nav).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(nav).getByRole('list')).toBeInTheDocument();
  });

  it('enlaza los saltos y marca el último como la página actual', () => {
    renderBreadcrumb(<Breadcrumb items={CRUMBS} />);

    const root = screen.getByRole('link', { name: 'Tickets' });
    expect(root).toHaveAttribute('href', '/app/tickets');
    // Un enlace a la propia página no lleva a ninguna parte y añade un
    // tabulador sin acción: el último paso es texto.
    expect(screen.queryByRole('link', { name: 'TCK-000123' })).not.toBeInTheDocument();
    expect(screen.getByText('TCK-000123')).toHaveAttribute('aria-current', 'page');
  });

  it('navega al listado al pulsar el salto', async () => {
    // Se montan las dos rutas: sin la de destino, `Link` no tendría nada que
    // pintar y el clic no se podría observar.
    render(
      <MemoryRouter initialEntries={['/app/tickets/1']}>
        <Routes>
          <Route
            path="/app/tickets/1"
            element={
              <>
                <Breadcrumb items={CRUMBS} />
                <p>Detalle del ticket</p>
              </>
            }
          />
          <Route path="/app/tickets" element={<p>Listado de tickets</p>} />
        </Routes>
      </MemoryRouter>
    );

    await userEvent.setup().click(screen.getByRole('link', { name: 'Tickets' }));
    expect(await screen.findByText('Listado de tickets')).toBeInTheDocument();
    expect(screen.queryByText('Detalle del ticket')).not.toBeInTheDocument();
  });

  it('oculta el separador a la tecnología de asistencia técnica', () => {
    const { container } = renderBreadcrumb(<Breadcrumb items={CRUMBS} />);

    // La ruta debe anunciarse como "Tickets, TCK-000123", no con flechas entre
    // medio. Solo hay un separador: el último paso no lo lleva.
    const separators = container.querySelectorAll('svg');
    expect(separators).toHaveLength(1);
    expect(separators[0].closest('span')).toHaveAttribute('aria-hidden', 'true');
  });

  it('usa los tokens del tema, no colores de paleta', () => {
    renderBreadcrumb(<Breadcrumb items={CRUMBS} />);

    // `--text-muted`, `--text`, `--brand-hover` y `--border-strong` cambian con
    // el tema: la misma clase sirve para claro y oscuro sin reglas espejo.
    expect(screen.getByRole('link', { name: 'Tickets' }).className).toContain('var(--text-muted)');
    expect(screen.getByText('TCK-000123').className).toContain('var(--text)');
  });

  it('es compacta: no añade alto ni cajas propias', () => {
    const { container } = renderBreadcrumb(<Breadcrumb items={CRUMBS} />);

    // `text-xs` y nada de tarjeta, borde ni relleno: la miga acompaña al título,
    // no compite con él.
    expect(container.querySelector('ol').className).toContain('text-xs');
    expect(container.querySelector('.card')).toBeNull();
  });

  it('acepta otro nombre accesible y no pinta nada sin rutas', () => {
    renderBreadcrumb(<Breadcrumb items={CRUMBS} label="Ruta del ticket" />);
    expect(screen.getByRole('navigation', { name: 'Ruta del ticket' })).toBeInTheDocument();

    const { container } = renderBreadcrumb(<Breadcrumb items={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
