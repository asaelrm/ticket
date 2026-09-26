import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    host: 'localhost',
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
