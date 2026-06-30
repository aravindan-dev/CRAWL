import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "sans-serif",
        ],
        display: ["Inter Tight", "Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      colors: {
        // Primary brand — refined blue ramp (Linear/Stripe energy)
        brand: {
          50: "#eef4ff",
          100: "#dbe6fe",
          200: "#bfd3fe",
          300: "#93b4fd",
          400: "#608ef9",
          500: "#3b82f6",
          600: "#2563eb",
          700: "#1d4ed8",
          800: "#1e40af",
          900: "#1e3a8a",
          950: "#172554",
        },
        // Accent — warm amber for CTAs / highlights (WCAG-tuned)
        accent: {
          50: "#fff8eb",
          100: "#feefc7",
          200: "#fedf8a",
          300: "#fcc94d",
          400: "#fbb324",
          500: "#f59e0b",
          600: "#d97706",
          700: "#b45309",
          800: "#92400e",
          900: "#78350f",
        },
        // Layered dark surfaces (deep midnight, not pure black)
        ink: {
          950: "#060912",
          900: "#0a0f1c",
          850: "#0d1424",
          800: "#111a2e",
          700: "#18233c",
        },
      },
      boxShadow: {
        glass: "0 8px 30px rgba(2, 6, 23, 0.08)",
        glasshover: "0 18px 50px rgba(2, 6, 23, 0.14)",
        glow: "0 0 0 1px rgba(59,130,246,0.10), 0 10px 40px -12px rgba(37,99,235,0.55)",
        "glow-accent": "0 0 0 1px rgba(245,158,11,0.12), 0 10px 40px -12px rgba(217,119,6,0.5)",
        "inner-top": "inset 0 1px 0 rgba(255,255,255,0.06)",
      },
      backgroundImage: {
        "aurora-light":
          "radial-gradient(1200px 700px at 90% -10%, rgba(59,130,246,0.16), transparent 60%), radial-gradient(1000px 600px at -10% 10%, rgba(217,119,6,0.10), transparent 55%), radial-gradient(900px 600px at 50% 120%, rgba(99,102,241,0.14), transparent 55%)",
        "aurora-dark":
          "radial-gradient(1200px 700px at 90% -10%, rgba(59,130,246,0.22), transparent 60%), radial-gradient(1000px 600px at -10% 10%, rgba(245,158,11,0.10), transparent 55%), radial-gradient(900px 600px at 50% 120%, rgba(99,102,241,0.18), transparent 55%)",
        "grid-light":
          "linear-gradient(to right, rgba(2,6,23,0.045) 1px, transparent 1px), linear-gradient(to bottom, rgba(2,6,23,0.045) 1px, transparent 1px)",
        "grid-dark":
          "linear-gradient(to right, rgba(255,255,255,0.045) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.045) 1px, transparent 1px)",
        "sheen": "linear-gradient(110deg, transparent 30%, rgba(255,255,255,0.55) 50%, transparent 70%)",
      },
      keyframes: {
        "fade-up": { "0%": { opacity: "0", transform: "translateY(10px)" }, "100%": { opacity: "1", transform: "translateY(0)" } },
        "fade-in": { "0%": { opacity: "0" }, "100%": { opacity: "1" } },
        "scale-in": { "0%": { opacity: "0", transform: "scale(.96)" }, "100%": { opacity: "1", transform: "scale(1)" } },
        shimmer: { "100%": { transform: "translateX(100%)" } },
        aurora: {
          "0%, 100%": { transform: "translate3d(0,0,0) scale(1)", opacity: "0.9" },
          "50%": { transform: "translate3d(2%, -2%, 0) scale(1.08)", opacity: "1" },
        },
        "aurora-2": {
          "0%, 100%": { transform: "translate3d(0,0,0) scale(1.05)", opacity: "0.8" },
          "50%": { transform: "translate3d(-3%, 3%, 0) scale(1)", opacity: "1" },
        },
        float: { "0%,100%": { transform: "translateY(0)" }, "50%": { transform: "translateY(-8px)" } },
        "glow-pulse": {
          "0%,100%": { opacity: "0.6", transform: "scale(1)" },
          "50%": { opacity: "1", transform: "scale(1.15)" },
        },
        "gradient-x": {
          "0%,100%": { backgroundPosition: "0% 50%" },
          "50%": { backgroundPosition: "100% 50%" },
        },
        sheen: { "0%": { transform: "translateX(-150%)" }, "100%": { transform: "translateX(150%)" } },
      },
      animation: {
        "fade-up": "fade-up .5s cubic-bezier(.2,.7,.2,1) both",
        "fade-in": "fade-in .3s ease-out both",
        "scale-in": "scale-in .18s ease-out both",
        shimmer: "shimmer 1.6s infinite",
        aurora: "aurora 18s ease-in-out infinite",
        "aurora-2": "aurora-2 22s ease-in-out infinite",
        float: "float 6s ease-in-out infinite",
        "glow-pulse": "glow-pulse 3.5s ease-in-out infinite",
        "gradient-x": "gradient-x 6s ease infinite",
        sheen: "sheen 1.1s ease-in-out",
      },
    },
  },
  plugins: [],
};

export default config;
