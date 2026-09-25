import { useEffect, useMemo, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';

// Bus frontal de eventos de tickets. La única conexión SSE global del panel
// (abierta por <Notifications/> en el Layout) entrega aquí los eventos de
// tickets de baja fidelidad; las pantallas se suscriben sin abrir EventSources.
const listeners = new Set();

export function notifyTicketEvent(event) {
  for (const cb of listeners) cb(event);
}

export function subscribeTicketEvents(cb) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useTicketEvents(handler) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const cb = (event) => ref.current(event);
    return subscribeTicketEvents(cb);
  }, []);
}

// Suscribe la pantalla a los eventos de tickets y, con un pequeño debounce
// (evita ráfagas de invalidaciones), refresca las queries de los prefijos dados.
export function useTicketEventInvalidator(prefixKeys, debounceMs = 400) {
  const queryClient = useQueryClient();
  const deps = `${prefixKeys.join('|')}|${debounceMs}`;
  const handler = useMemo(() => {
    let timer = null;
    return () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        for (const k of prefixKeys) queryClient.invalidateQueries({ queryKey: [k] });
      }, debounceMs);
    };
  }, [queryClient, deps]);
  useTicketEvents(handler);
}