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
        // Primary brand — restrained blue, used for actions/active states only.
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
        // Amber — status/warning tone (no longer a decorative gradient stop).
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
        // Layered dark surfaces (deep neutral navy).
        ink: {
          950: "#060912",
          900: "#0a0f1c",
          850: "#0d1424",
          800: "#111a2e",
          700: "#18233c",
        },
      },
      boxShadow: {
        // Quiet elevation scale — cards sit on the page, they don't float.
        card: "0 1px 2px rgba(15, 23, 42, 0.04), 0 1px 3px rgba(15, 23, 42, 0.06)",
        "card-hover": "0 2px 4px rgba(15, 23, 42, 0.05), 0 6px 16px rgba(15, 23, 42, 0.08)",
        overlay: "0 10px 38px -10px rgba(15, 23, 42, 0.28), 0 10px 20px -15px rgba(15, 23, 42, 0.2)",
        // Legacy aliases still referenced in a few places — mapped to the quiet scale.
        glass: "0 1px 2px rgba(15, 23, 42, 0.04), 0 1px 3px rgba(15, 23, 42, 0.06)",
        glasshover: "0 2px 4px rgba(15, 23, 42, 0.05), 0 6px 16px rgba(15, 23, 42, 0.08)",
        glow: "0 1px 2px rgba(15, 23, 42, 0.08)",
        "glow-accent": "0 1px 2px rgba(15, 23, 42, 0.08)",
      },
      keyframes: {
        "fade-up": { "0%": { opacity: "0", transform: "translateY(6px)" }, "100%": { opacity: "1", transform: "translateY(0)" } },
        "fade-in": { "0%": { opacity: "0" }, "100%": { opacity: "1" } },
        "scale-in": { "0%": { opacity: "0", transform: "scale(.98)" }, "100%": { opacity: "1", transform: "scale(1)" } },
        shimmer: { "100%": { transform: "translateX(100%)" } },
      },
      animation: {
        "fade-up": "fade-up .25s cubic-bezier(.2,.7,.2,1) both",
        "fade-in": "fade-in .18s ease-out both",
        "scale-in": "scale-in .15s ease-out both",
        shimmer: "shimmer 1.6s infinite",
      },
    },
  },
  plugins: [],
};

export default config;
