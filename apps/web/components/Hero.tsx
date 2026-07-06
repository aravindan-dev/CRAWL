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
 * Home dashboard hero: clean panel with an eyebrow, headline, subtitle and a
 * row of live stat chips. Quiet surfaces, fast entrance, reduced-motion safe
 * (`reduce` only tunes transition timing, so server/client HTML always match).
 */
export function Hero({ eyebrow, title, subtitle, chips = [] }: { eyebrow: string; title: string; subtitle: string; chips?: HeroChip[] }) {
  const reduce = useReducedMotion();

  return (
    <motion.section
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: EASE_OUT }}
      className="glass p-7 md:p-9"
    >
      <span className="eyebrow">
        <span className="h-2 w-2 rounded-full bg-brand-500" />
        {eyebrow}
      </span>

      <h1 className="mt-3 text-3xl font-bold tracking-tight text-slate-900 md:text-[2.4rem] md:leading-[1.1]">
        {title}
      </h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-600 md:text-[15px] dark:text-slate-300">{subtitle}</p>

      {chips.length > 0 && (
        <motion.div
          className="mt-6 flex flex-wrap gap-2.5"
          initial="hidden"
          animate="show"
          variants={{ hidden: {}, show: { transition: { staggerChildren: reduce ? 0 : 0.04, delayChildren: 0.08 } } }}
        >
          {chips.map((c) => (
            <motion.div
              key={c.label}
              variants={{ hidden: { opacity: 0, y: 6 }, show: { opacity: 1, y: 0, transition: { duration: 0.2, ease: EASE_OUT } } }}
              className="glass-soft flex items-center gap-2 rounded-full px-3.5 py-1.5"
            >
              <span className={`tnum text-base font-bold ${ACCENT[c.accent ?? "slate"]}`}>{c.value}</span>
              <span className="text-xs font-medium text-slate-500 dark:text-slate-400">{c.label}</span>
            </motion.div>
          ))}
        </motion.div>
      )}
    </motion.section>
  );
}
