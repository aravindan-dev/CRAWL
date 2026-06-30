"use client";

import {
  motion,
  useReducedMotion,
  type HTMLMotionProps,
  type Variants,
} from "framer-motion";
import type { ReactNode } from "react";

/* ------------------------------------------------------------------ *
 * Shared Framer Motion primitives for the CLG Search design system.
 * Premium, restrained, accessibility-aware (honours prefers-reduced-motion).
 * ------------------------------------------------------------------ */

export const EASE_OUT = [0.22, 0.7, 0.2, 1] as const;
export const SPRING = { type: "spring", stiffness: 380, damping: 30 } as const;

/** Container that staggers its children into view. */
export function Stagger({
  children,
  className = "",
  delay = 0,
  gap = 0.07,
  once = true,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  gap?: number;
  once?: boolean;
}) {
  const reduce = useReducedMotion();
  const variants: Variants = {
    hidden: {},
    show: { transition: { staggerChildren: reduce ? 0 : gap, delayChildren: delay } },
  };
  return (
    <motion.div
      className={className}
      variants={variants}
      initial="hidden"
      whileInView="show"
      viewport={{ once, margin: "-60px" }}
    >
      {children}
    </motion.div>
  );
}

/** A single item that fades/rises into view — pairs with <Stagger> or works solo. */
export function Reveal({
  children,
  className = "",
  y = 16,
  delay = 0,
  once = true,
}: {
  children: ReactNode;
  className?: string;
  y?: number;
  delay?: number;
  once?: boolean;
}) {
  const reduce = useReducedMotion();
  const variants: Variants = {
    hidden: { opacity: 0, y: reduce ? 0 : y },
    show: { opacity: 1, y: 0, transition: { duration: 0.55, ease: EASE_OUT, delay } },
  };
  return (
    <motion.div
      className={className}
      variants={variants}
      initial="hidden"
      whileInView="show"
      viewport={{ once, margin: "-60px" }}
    >
      {children}
    </motion.div>
  );
}

/** Child variant for use inside a <Stagger> (no own viewport trigger). */
export const itemVariants: Variants = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE_OUT } },
};

export function Item({ children, className = "", ...rest }: HTMLMotionProps<"div"> & { children: ReactNode }) {
  return (
    <motion.div className={className} variants={itemVariants} {...rest}>
      {children}
    </motion.div>
  );
}

export { motion, useReducedMotion };
