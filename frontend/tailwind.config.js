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