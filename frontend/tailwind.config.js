/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // Verde UCE + turquesa: color de marca y acciones.
        brand: {
          50: '#e7faf1',
          100: '#c9f3df',
          200: '#9aeac5',
          300: '#63dfa6',
          400: '#3ad48b',
          500: '#22C77A',
          600: '#17a963',
          700: '#128d56',
          800: '#0e6e44',
          900: '#0a5233',
          950: '#06301d',
        },
        // Escala navy invertida para el tema oscuro: los tonos "claros" se vuelven
        // superficies oscuras y los "oscuros" pasan a ser texto claro.
        // 50/100 = superficies, 200/300 = bordes, 400+ = texto.
        slate: {
          50: '#0E3A50',
          100: '#0C3347',
          200: '#154E59',
          300: '#2A5F75',
          400: '#8CA5B8',
          500: '#AFC4D4',
          600: '#C6D6E2',
          700: '#DDE8F0',
          800: '#F8FAFC',
          900: '#FFFFFF',
          950: '#FFFFFF',
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