"use client";

import { useEffect, useRef } from "react";
import { motion, useReducedMotion } from "framer-motion";

/* ------------------------------------------------------------------ *
 * BackdropFX — the global "motion graphics" backdrop for CLG Search.
 * Fixed behind all content (-z-10), pointer-events-none, theme-aware,
 * and fully disabled under prefers-reduced-motion. Three layers:
 *   1. Slowly rotating gradient beams (conic) — depth + life.
 *   2. Drifting blurred colour orbs (framer-motion).
 *   3. A live constellation particle field on <canvas>.
 * The faint grid + base aurora still come from globals.css.
 * ------------------------------------------------------------------ */

function Constellation() {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let w = 0;
    let h = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    type P = { x: number; y: number; vx: number; vy: number; r: number };
    let pts: P[] = [];

    const isDark = () => document.documentElement.classList.contains("dark");

    const seed = () => {
      // particle count scales with area but is capped for performance
      const count = Math.min(70, Math.round((w * h) / 26000));
      pts = Array.from({ length: count }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.22,
        vy: (Math.random() - 0.5) * 0.22,
        r: Math.random() * 1.6 + 0.6,
      }));
    };

    const resize = () => {
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed();
    };

    const draw = () => {
      const dark = isDark();
      const dot = dark ? "rgba(147,197,253,0.55)" : "rgba(37,99,235,0.45)";
      const line = dark ? "147,197,253" : "37,99,235";
      ctx.clearRect(0, 0, w, h);

      for (const p of pts) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0 || p.x > w) p.vx *= -1;
        if (p.y < 0 || p.y > h) p.vy *= -1;
      }

      // links between nearby particles
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const a = pts[i]!;
          const b = pts[j]!;
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < 140 * 140) {
            const o = (1 - Math.sqrt(d2) / 140) * (dark ? 0.18 : 0.13);
            ctx.strokeStyle = `rgba(${line},${o})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }

      // particles
      ctx.fillStyle = dot;
      for (const p of pts) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }

      raf = requestAnimationFrame(draw);
    };

    resize();
    draw();
    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return <canvas ref={ref} className="absolute inset-0 h-full w-full opacity-70 dark:opacity-80" aria-hidden />;
}

export function BackdropFX() {
  const reduce = useReducedMotion();

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      {/* 1 — rotating conic beams */}
      {!reduce && (
        <motion.div
          className="absolute left-1/2 top-[-30%] h-[80vmax] w-[80vmax] -translate-x-1/2 rounded-full opacity-[0.18] blur-2xl dark:opacity-25"
          style={{
            background:
              "conic-gradient(from 0deg, rgba(59,130,246,0.0), rgba(59,130,246,0.55), rgba(99,102,241,0.0), rgba(245,158,11,0.35), rgba(59,130,246,0.0))",
          }}
          animate={{ rotate: 360 }}
          transition={{ duration: 90, repeat: Infinity, ease: "linear" }}
        />
      )}

      {/* 2 — drifting colour orbs */}
      {!reduce && (
        <>
          <motion.div
            className="absolute left-[-6%] top-[-8%] h-80 w-80 rounded-full bg-brand-500/25 blur-3xl dark:bg-brand-500/30"
            animate={{ x: [0, 40, 0], y: [0, 24, 0], scale: [1, 1.12, 1] }}
            transition={{ duration: 24, repeat: Infinity, ease: "easeInOut" }}
          />
          <motion.div
            className="absolute right-[-8%] top-[12%] h-96 w-96 rounded-full bg-accent-500/15 blur-3xl dark:bg-accent-500/20"
            animate={{ x: [0, -36, 0], y: [0, 30, 0], scale: [1.05, 1, 1.05] }}
            transition={{ duration: 28, repeat: Infinity, ease: "easeInOut" }}
          />
          <motion.div
            className="absolute bottom-[-14%] left-[38%] h-80 w-80 rounded-full bg-indigo-500/20 blur-3xl dark:bg-indigo-500/25"
            animate={{ x: [0, 28, 0], y: [0, -22, 0], scale: [1, 1.1, 1] }}
            transition={{ duration: 26, repeat: Infinity, ease: "easeInOut" }}
          />
        </>
      )}

      {/* 3 — live constellation (skipped under reduced motion) */}
      {!reduce && <Constellation />}
    </div>
  );
}
