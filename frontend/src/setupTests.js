import '@testing-library/jest-dom';

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