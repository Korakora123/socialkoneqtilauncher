/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        navy: { DEFAULT: '#050C1A', 2: '#0D1829', 3: '#131F30', 4: '#1A2740' },
        violet: { DEFAULT: '#7C3AED', light: '#A78BFA' },
        mint: { DEFAULT: '#10B981' },
        gold: { DEFAULT: '#F59E0B' },
        ink: { 1: '#F8FAFC', 2: '#94A3B8', 3: '#64748B' },
      },
      fontFamily: {
        display: ['"Plus Jakarta Sans"', 'Inter', 'system-ui', 'sans-serif'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
