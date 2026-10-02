import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    host: 'localhost',
    // Vite rechaza cualquier petición cuyo Host no esté en esta lista (control
    // de seguridad añadido en 5.4.15). El laboratorio entra por el proxy Caddy
    // con el Host "tickets.lan", así que sin esta entrada TODAS las páginas
    // devolvían 403 y solo funcionaba /api/*, que va directo a Express.
    //
    // Se permite sólo el nombre exacto que usa el laboratorio. Poner `true`
    // desactivaría el control y permitiría el envenenamiento de caché y de
    // contraseña a través del Host desde cualquier red, que es justo lo que
    // este control evita. Para un dominio propio, añadirlo aquí explícitamente.
    allowedHosts: ['tickets.lan', '.trycloudflare.com'],
    proxy: {
      '/api': {
        target: 'http://backend:4000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/setupTests.js',
    // Los formularios con userEvent tardan ~3 s en solitario. Con 31 ficheros de
    // pruebas en paralelo esa carga sube del límite por defecto de 5 s y el fallo
    // cae sobre un test distinto en cada ejecución, así que el rojo no significa
    // nada. 20 s deja margen sin ocultar timeouts reales.
    testTimeout: 20000,
  },
});

