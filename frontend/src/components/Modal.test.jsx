import React, { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Modal } from './ui';
import ResolveTicketModal from './ResolveTicketModal';

// Reproduce dónde nacen los diálogos de la app: `TicketTable` y casi todas las
// pantallas los montan dentro de `<div className="card overflow-hidden">`, y
// `.card` declara `backdrop-filter` (index.css), que convierte a la tarjeta en
// bloque contenedor de `position: fixed`. Antes del arreglo, el `inset-0` del
// modal se medía contra la tarjeta y su `overflow` le recortaba el pie.
function DentroDeUnaTarjeta({ children }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card overflow-hidden" data-testid="tarjeta">
      <button type="button" onClick={() => setOpen(true)}>
        Abrir
      </button>
      {open ? children : null}
    </div>
  );
}

const ticket = { id: 1, ticket_number: 'TCK-000001', title: 'PC no enciende' };

describe('Modal · el diálogo no puede quedar recortado por quien lo abre', () => {
  it('se monta en document.body y no dentro de la tarjeta que lo abre', async () => {
    const user = userEvent.setup();
    render(
      <DentroDeUnaTarjeta>
        <Modal open onClose={() => {}} title="Editar ticket">
          contenido
        </Modal>
      </DentroDeUnaTarjeta>
    );

    await user.click(screen.getByRole('button', { name: 'Abrir' }));

    const dialog = await screen.findByRole('dialog');
    expect(screen.getByTestId('tarjeta').contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
  });

  // jsdom no calcula layout, así que la comprobación del alto y del
  // desplazamiento tiene que hacerse sobre la estructura que lo implementa:
  // si alguien devuelve el `overflow-y-auto` al panel o quita el `min-h-0` del
  // cuerpo, el diálogo vuelve a crecer por debajo del viewport y ningún test
  // funcional lo detectaría.
  it('acota la altura al viewport y deja el desplazamiento en el cuerpo', () => {
    render(
      <Modal open onClose={() => {}} title="Editar ticket">
        contenido
      </Modal>
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveClass('flex', 'flex-col', 'max-h-[90vh]', 'overflow-hidden');

    const [cabecera, cuerpo] = Array.from(dialog.children);
    expect(cabecera).toHaveClass('shrink-0');
    expect(cabecera.querySelector('h3')).toHaveTextContent('Editar ticket');
    expect(cuerpo).toHaveClass('min-h-0', 'flex-1', 'overflow-y-auto', 'overscroll-contain');
    expect(cuerpo).toHaveTextContent('contenido');
  });

  it('mantiene el cierre por Escape y por el fondo', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Editar ticket">
        contenido
      </Modal>
    );

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.click(screen.getByTestId('modal-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('ResolveTicketModal · usable con poca altura', () => {
  it('deja el pie en una zona estable y los dos botones dentro del diálogo', () => {
    render(<ResolveTicketModal ticket={ticket} onClose={() => {}} onSubmit={async () => {}} />);

    const dialog = screen.getByRole('dialog', { name: 'Resolver TCK-000001' });
    const volver = within(dialog).getByRole('button', { name: 'Volver' });
    const confirmar = within(dialog).getByRole('button', { name: 'Resolver ticket' });

    // `sticky bottom-0` mantiene el pie a la vista aunque el cuerpo se desplace;
    // los márgenes negativos lo apoyan en el borde en lugar de dejarlo flotando
    // dentro del relleno.
    const pie = volver.closest('div');
    expect(pie).toBe(confirmar.closest('div'));
    expect(pie).toHaveClass('sticky', 'bottom-0', 'shrink-0', 'border-t');

    // El textarea sigue siendo alcanzable y conserva su tamaño y su límite.
    const campo = within(dialog).getByLabelText(/Solución \/ trabajo realizado/);
    expect(campo).toHaveAttribute('maxlength', '10000');
    expect(campo).toHaveClass('min-h-[110px]');
  });

  it('se escapa de la tarjeta de la tabla que lo abre', async () => {
    const user = userEvent.setup();
    render(
      <DentroDeUnaTarjeta>
        <ResolveTicketModal ticket={ticket} onClose={() => {}} onSubmit={async () => {}} />
      </DentroDeUnaTarjeta>
    );

    await user.click(screen.getByRole('button', { name: 'Abrir' }));
    const dialog = await screen.findByRole('dialog');
    expect(screen.getByTestId('tarjeta').contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
  });

  it('sigue exigiendo solución y.error sin cerrar el diálogo', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onSubmit = vi.fn().mockRejectedValue(new Error('El ticket ya está cerrado'));
    render(<ResolveTicketModal ticket={ticket} onClose={onClose} onSubmit={onSubmit} />);

    const dialog = await screen.findByRole('dialog');
    const confirmar = within(dialog).getByRole('button', { name: 'Resolver ticket' });
    expect(confirmar).toBeDisabled();

    await user.type(within(dialog).getByLabelText(/Solución \/ trabajo realizado/), '   ');
    expect(within(dialog).getByRole('button', { name: 'Resolver ticket' })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();

    await user.clear(within(dialog).getByLabelText(/Solución \/ trabajo realizado/));
    await user.type(within(dialog).getByLabelText(/Solución \/ trabajo realizado/), 'Se cambió la fuente');
    await user.click(within(dialog).getByRole('button', { name: 'Resolver ticket' }));

    expect(onSubmit).toHaveBeenCalledWith('Se cambió la fuente');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('El ticket ya está cerrado');
    expect(onClose).not.toHaveBeenCalled();
  });
});
