import React from 'react';
import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import TicketTimeline from './TicketTimeline';
import { renderWithProviders } from '../test/utils';

function evento(over = {}) {
  return {
    id: 1,
    action: 'CREATED',
    description: 'Ticket creado por Ana Díaz',
    user_name: 'Ana Díaz',
    old_value: null,
    new_value: null,
    created_at: '2026-09-01T08:00:00.000Z',
    ...over,
  };
}

function comentario(over = {}) {
  return {
    id: 1,
    user_name: 'Juan Pérez',
    message: 'Revisando el equipo',
    is_internal: false,
    created_at: '2026-09-01T09:00:00.000Z',
    attachments: [],
    ...over,
  };
}

describe('TicketTimeline', () => {
  it('avisa cuando no hay actividad', () => {
    renderWithProviders(<TicketTimeline />);
    expect(screen.getByText('Sin actividad todavía.')).toBeInTheDocument();
  });

  it('muestra el autor y la descripción de cada evento', () => {
    renderWithProviders(<TicketTimeline history={[evento()]} />);
    expect(screen.getByText('Ana Díaz')).toBeInTheDocument();
    expect(screen.getByText(/Ticket creado por/)).toBeInTheDocument();
  });

  it('muestra el valor anterior y el nuevo de un cambio de estado', () => {
    renderWithProviders(
      <TicketTimeline
        history={[
          evento({
            id: 2,
            action: 'STATUS_CHANGED',
            description: 'Estado cambiado: Abierto → En proceso',
            old_value: 'OPEN',
            new_value: 'IN_PROGRESS',
          }),
        ]}
      />
    );

    expect(screen.getByText('Abierto')).toBeInTheDocument();
    expect(screen.getByText('En proceso')).toBeInTheDocument();
  });

  it('traduce también el cambio de prioridad', () => {
    renderWithProviders(
      <TicketTimeline
        history={[
          evento({
            id: 3,
            action: 'PRIORITY_CHANGED',
            description: 'Prioridad cambiada: Media → Alta',
            old_value: 'MEDIUM',
            new_value: 'HIGH',
          }),
        ]}
      />
    );

    expect(screen.getByText('Media')).toBeInTheDocument();
    expect(screen.getByText('Alta')).toBeInTheDocument();
  });

  it('no inventa un antes y un después si el valor no se puede traducir', () => {
    const { container } = renderWithProviders(
      <TicketTimeline
        history={[
          evento({
            id: 4,
            action: 'ASSIGNED',
            description: 'Asignado a Juan Pérez',
            old_value: '3',
            new_value: '5',
          }),
        ]}
      />
    );

    // Los ids internos no significan nada para quien lee: no se pintan en crudo.
    expect(container.querySelector('.line-through')).toBeNull();
    expect(container.textContent).not.toContain('3 →');
    expect(container.textContent).not.toContain('3→5');
    expect(screen.getByText(/Asignado a Juan Pérez/)).toBeInTheDocument();
  });

  it('omite el cambio cuando el valor antiguo y el nuevo son iguales', () => {
    const { container } = renderWithProviders(
      <TicketTimeline
        history={[
          evento({ id: 5, action: 'STATUS_CHANGED', old_value: 'OPEN', new_value: 'OPEN' }),
        ]}
      />
    );
    expect(container.querySelector('.line-through')).toBeNull();
  });

  it('representa los eventos que antes caían en un icono genérico', () => {
    const { container } = renderWithProviders(
      <TicketTimeline
        history={[
          evento({ id: 6, action: 'CANCELLED', description: 'Ticket cancelado' }),
          evento({ id: 7, action: 'CSAT_RATED', description: 'Encuesta de satisfacción: 5' }),
          evento({ id: 8, action: 'ESCALATED', description: 'Escalado por SLA' }),
          evento({ id: 9, action: 'NOTE_ATTACHMENT_ADDED', description: 'Se adjuntó informe.pdf' }),
        ]}
      />
    );

    expect(container.textContent).toContain('⛔');
    expect(container.textContent).toContain('⭐');
    expect(container.textContent).toContain('🚨');
    expect(container.textContent).not.toContain('•');
  });

  it('distingue visualmente una nota interna de un comentario público', () => {
    renderWithProviders(
      <TicketTimeline
        comments={[
          comentario({ id: 1, message: 'Comentario para todos' }),
          comentario({ id: 2, message: 'Solo para soporte', is_internal: true }),
        ]}
      />
    );

    expect(screen.getByText('Comentario para todos')).toBeInTheDocument();
    expect(screen.getByText('Solo para soporte')).toBeInTheDocument();
    expect(screen.getByText('Nota interna')).toBeInTheDocument();
  });

  it('ordena eventos y comentarios por fecha', () => {
    renderWithProviders(
      <TicketTimeline
        history={[
          evento({ id: 1, created_at: '2026-09-01T10:00:00.000Z', description: 'Evento posterior' }),
          evento({ id: 2, created_at: '2026-09-01T08:00:00.000Z', description: 'Evento anterior' }),
        ]}
        comments={[comentario({ id: 3, created_at: '2026-09-01T09:00:00.000Z', message: 'Comentario intermedio' })]}
      />
    );

    const orden = screen.getAllByRole('listitem').map((li) => li.textContent);
    const posiciones = ['Evento anterior', 'Comentario intermedio', 'Evento posterior'].map((texto) =>
      orden.findIndex((t) => t.includes(texto))
    );
    expect(posiciones).toEqual([...posiciones].sort((a, b) => a - b));
    expect(posiciones.every((p) => p >= 0)).toBe(true);
  });

  it('muestra el archivo de un comentario con su tamaño', () => {
    renderWithProviders(
      <TicketTimeline
        comments={[
          comentario({
            id: 4,
            attachments: [{ id: 9, original_name: 'captura.png', mime_type: 'image/png', size_bytes: 2048 }],
          }),
          comentario({
            id: 5,
            message: 'Con documento',
            attachments: [{ id: 10, original_name: 'informe.pdf', mime_type: 'application/pdf', size_bytes: 40960 }],
          }),
        ]}
      />
    );

    // Una imagen se muestra como miniatura y un documento como enlace con su peso.
    expect(screen.getByAltText('captura.png')).toHaveAttribute('src', '/api/files/9');
    expect(screen.getByText(/informe\.pdf/)).toBeInTheDocument();
    expect(screen.getByText('40.0 KB')).toBeInTheDocument();
  });
});
