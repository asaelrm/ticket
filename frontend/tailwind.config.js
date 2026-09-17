/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eef4ff',
          100: '#d9e6ff',
          200: '#bcd3ff',
          300: '#8eb6ff',
          400: '#5990ff',
          500: '#3366ff',
          600: '#1f4ff5',
          700: '#183de1',
          800: '#1a33b6',
          900: '#1b2f8f',
          950: '#141f57',
        },
        // Escala invertida para el tema oscuro: los tonos "claros" se vuelven
        // superficies oscuras y los "oscuros" pasan a ser texto claro.
        slate: {
          50: '#0a0f1a',
          100: '#121a29',
          200: '#1e293b',
          300: '#334155',
          400: '#64748b',
          500: '#94a3b8',
          600: '#cbd5e1',
          700: '#e2e8f0',
          800: '#f1f5f9',
          900: '#f8fafc',
          950: '#ffffff',
        },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 2px 0 rgb(0 0 0 / 0.04), 0 1px 3px 0 rgb(0 0 0 / 0.08)',
        pop: '0 8px 30px rgb(0 0 0 / 0.12)',
      },
    },
  },
  plugins: [],
};