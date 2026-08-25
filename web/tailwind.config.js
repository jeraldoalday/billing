/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // One brand ramp, referenced everywhere as `brand-*` so the whole
        // app re-themes from this block alone.
        brand: {
          50: '#eef4ff',
          100: '#dae5ff',
          200: '#bdd0ff',
          300: '#90b1ff',
          400: '#5c86fc',
          500: '#375ef6',
          600: '#213eeb',
          700: '#1a2fd7',
          800: '#1c29ae',
          900: '#1c2a89',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
