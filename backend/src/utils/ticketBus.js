import { EventEmitter } from 'node:events';

// Bus de eventos en proceso para las conversaciones de tickets.
// Permite que las conexiones SSE reciban cambios sin polling.
const bus = new EventEmitter();
bus.setMaxListeners(0);

export function emitTicketEvent(ticketId, type, data = {}) {
  bus.emit('ticket', { ticketId, type, data, at: Date.now() });
}

export function onTicketEvent(listener) {
  bus.on('ticket', listener);
  return () => bus.off('ticket', listener);
}
