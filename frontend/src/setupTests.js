import '@testing-library/jest-dom';

// jsdom no implementa Element.prototype.scrollTo; algunos componentes lo usan
// en efectos (p. ej. auto-scroll del hilo de comentarios). Stub inofensivo para
// que los tests no lancen "el.scrollTo is not a function".
if (typeof Element !== 'undefined' && !Element.prototype.scrollTo) {
  Element.prototype.scrollTo = () => {};
}

// Salvaguarda para que ningún test abra una conexión SSE real (jsdom no la
// soporta y no hay backend disponible). Las suites que necesiten inspeccionar
// la conexión sobrescriben globalThis.EventSource con su propio mock.
globalThis.EventSource =
  globalThis.EventSource ||
  class EventSourceStub {
    constructor() {
      this.url = '/api/notifications/stream';
      this.onmessage = null;
      this.onopen = null;
      this.onerror = null;
    }
    addEventListener() {}
    removeEventListener() {}
    close() {}
  };