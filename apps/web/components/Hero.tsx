"use client";

import { motion, useReducedMotion } from "framer-motion";
import { EASE_OUT } from "./motion";

export interface HeroChip {
  label: string;
  value: string | number;
  accent?: "brand" | "emerald" | "amber" | "slate";
}

const ACCENT: Record<NonNullable<HeroChip["accent"]>, string> = {
  brand: "text-brand-600 dark:text-brand-300",
  emerald: "text-emerald-600 dark:text-emerald-300",
  amber: "text-accent-600 dark:text-accent-300",
  slate: "text-slate-700 dark:text-slate-200",
};

/**
 * Premium animated hero for the home dashboard. Glass panel with a moving
 * aurora/beam wash, a sweeping sheen, a gradient headline and a row of live
 * stat chips. Fully theme-aware and reduced-motion safe.
 */
export function Hero({ eyebrow, title, subtitle, chips = [] }: { eyebrow: string; title: string; subtitle: string; chips?: HeroChip[] }) {
  const reduce = useReducedMotion();

  return (
    <motion.section
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: EASE_OUT }}
      className="glass ring-gradient relative overflow-hidden rounded-3xl p-7 md:p-9"
    >
      {/* moving aurora wash */}
      {!reduce && (
        <motion.div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-0"
          style={{
            background:
              "radial-gradient(60% 80% at 15% 10%, rgba(59,130,246,0.25), transparent 60%), radial-gradient(50% 70% at 90% 20%, rgba(245,158,11,0.18), transparent 60%), radial-gradient(60% 80% at 60% 120%, rgba(99,102,241,0.22), transparent 60%)",
            backgroundSize: "200% 200%",
          }}
          animate={{ backgroundPosition: ["0% 50%", "100% 50%", "0% 50%"] }}
          transition={{ duration: 18, repeat: Infinity, ease: "easeInOut" }}
        />
      )}
      {/* sweeping sheen */}
      {!reduce && (
        <motion.div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 -z-0 w-1/3 bg-gradient-to-r from-transparent via-white/25 to-transparent dark:via-white/10"
          initial={{ x: "-130%" }}
          animate={{ x: ["-130%", "330%"] }}
          transition={{ duration: 7, repeat: Infinity, repeatDelay: 4, ease: "easeInOut" }}
        />
      )}

      <div className="relative z-10">
        <motion.span
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05, duration: 0.5, ease: EASE_OUT }}
          className="eyebrow"
        >
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-400 opacity-70" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-brand-500" />
          </span>
          {eyebrow}
        </motion.span>

        <h1 className="mt-3 text-3xl font-bold tracking-tight md:text-[2.6rem] md:leading-[1.05]">
          <span className="gradient-text">{title}</span>
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-600 md:text-[15px] dark:text-slate-300">{subtitle}</p>

        {chips.length > 0 && (
          <motion.div
            className="mt-6 flex flex-wrap gap-2.5"
            initial="hidden"
            animate="show"
            variants={{ hidden: {}, show: { transition: { staggerChildren: reduce ? 0 : 0.08, delayChildren: 0.15 } } }}
          >
            {chips.map((c) => (
              <motion.div
                key={c.label}
                variants={{ hidden: { opacity: 0, y: 10, scale: 0.96 }, show: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.45, ease: EASE_OUT } } }}
                className="glass-soft flex items-center gap-2 rounded-full px-3.5 py-1.5"
              >
                <span className={`tnum text-base font-bold ${ACCENT[c.accent ?? "slate"]}`}>{c.value}</span>
                <span className="text-xs font-medium text-slate-500 dark:text-slate-400">{c.label}</span>
              </motion.div>
            ))}
          </motion.div>
        )}
      </div>
    </motion.section>
  );
}
