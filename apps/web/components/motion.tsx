"use client";

import { motion, useReducedMotion, type Variants } from "framer-motion";
import type { HTMLAttributes, ReactNode } from "react";

/* ------------------------------------------------------------------ *
 * Layout primitives for the CLG Search design system.
 *
 * SPEED-FIRST (de-animated): these used to fade/rise every child into view
 * with per-element IntersectionObservers and an initial opacity:0 state. On a
 * data-heavy dashboard that made content start INVISIBLE and trickle in — the
 * page "felt slow" even when the data was already there, and every scroll
 * spun up observers. They are now instant pass-throughs (plain divs): content
 * paints immediately, navigation feels instant, and framer-motion is off the
 * hot path for every page that used them. The component API is unchanged so no
 * page needs editing; the animation-only props are accepted and ignored.
 * ------------------------------------------------------------------ */

export const EASE_OUT = [0.22, 0.7, 0.2, 1] as const;
export const SPRING = { type: "spring", stiffness: 500, damping: 38 } as const;

/** Container (was a stagger-into-view wrapper) — now an instant pass-through. */
export function Stagger({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
  /** Accepted for API compatibility; no longer animated. */
  delay?: number;
  gap?: number;
  once?: boolean;
}) {
  return <div className={className}>{children}</div>;
}

/** A single block (was a fade/rise-into-view) — now an instant pass-through. */
export function Reveal({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
  /** Accepted for API compatibility; no longer animated. */
  y?: number;
  delay?: number;
  once?: boolean;
}) {
  return <div className={className}>{children}</div>;
}

/** Kept for any external import; no longer used to drive an entrance. */
export const itemVariants: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.25, ease: EASE_OUT } },
};

/** Child block inside a <Stagger> — now an instant pass-through div. */
export function Item({ children, className = "", ...rest }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  return (
    <div className={className} {...rest}>
      {children}
    </div>
  );
}

export { motion, useReducedMotion };
