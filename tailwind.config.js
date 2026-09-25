/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/**/*.{html,ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: '#0b0c10',
          soft: '#0e1014',
          panel: '#111318',
          elevated: '#161922',
          hover: '#1c202b'
        },
        line: 'rgba(255,255,255,0.06)',
        ink: {
          DEFAULT: '#f2f3f7',
          muted: '#a4abbb',
          faint: '#6b7284'
        },
        // Airbnb "Rausch" — the single warm accent for the whole app.
        brand: {
          DEFAULT: '#ff385c',
          soft: '#e61e4d',
          glow: '#ff8aa3'
        },
        rec: '#ff385c',
        ok: '#3ad99a',
        warn: '#ffb454'
      },
      fontFamily: {
        sans: ['Inter', 'Segoe UI', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Cascadia Code', 'Consolas', 'monospace']
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(255,56,92,0.35), 0 14px 40px -8px rgba(255,56,92,0.45)',
        rec: '0 0 0 1px rgba(255,56,92,0.5), 0 14px 40px -8px rgba(255,56,92,0.4)',
        panel: '0 8px 32px rgba(0,0,0,0.45)',
        pop: '0 12px 40px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.07)'
      },
      keyframes: {
        pulse2: {
          '0%,100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '0.55', transform: 'scale(0.9)' }
        },
        breathe: {
          '0%,100%': { transform: 'scale(1)', opacity: '0.9' },
          '50%': { transform: 'scale(1.06)', opacity: '1' }
        },
        slidein: {
          from: { opacity: '0', transform: 'translateY(5px)' },
          to: { opacity: '1', transform: 'translateY(0)' }
        }
      },
      animation: {
        pulse2: 'pulse2 1.1s ease-in-out infinite',
        breathe: 'breathe 2.4s ease-in-out infinite',
        slidein: 'slidein 0.16s ease-out'
      }
    }
  },
  plugins: []
}
