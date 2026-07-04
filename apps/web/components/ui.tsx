"use client";

import type { MouseEvent, ReactNode } from "react";
import { AnimatedCounter } from "./AnimatedCounter";

/**
 * Premium glass card. Backward-compatible ({children, className}) with optional
 * `spotlight` (cursor-tracking glow) and `hover` (lift on hover) enhancements.
 */
export function Card({
  children,
  className = "",
  spotlight = false,
  hover = false,
  gradientRing = false,
}: {
  children: ReactNode;
  className?: string;
  spotlight?: boolean;
  hover?: boolean;
  gradientRing?: boolean;
}) {
  const onMove = (e: MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty("--mx", `${e.clientX - r.left}px`);
    e.currentTarget.style.setProperty("--my", `${e.clientY - r.top}px`);
  };
  return (
    <div
      onMouseMove={spotlight ? onMove : undefined}
      className={[
        "glass relative rounded-2xl transition-all duration-300",
        spotlight ? "spotlight overflow-hidden" : "",
        hover ? "hover:-translate-y-0.5 hover:shadow-glasshover" : "",
        gradientRing ? "ring-gradient" : "",
        className,
      ].join(" ")}
    >
      {children}
    </div>
  );
}

export function StatCard({
  label,
  value,
  accent = "text-slate-900",
  icon,
}: {
  label: string;
  value: ReactNode;
  accent?: string;
  icon?: ReactNode;
}) {
  return (
    <Card spotlight hover className="group p-5">
      {/* top sheen line */}
      <span className="pointer-events-none absolute inset-x-5 top-0 h-px bg-gradient-to-r from-transparent via-brand-400/60 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-slate-500">{label}</div>
        {icon && (
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-brand-50 text-brand-500 transition-colors duration-300 group-hover:bg-brand-100 dark:bg-brand-500/15 dark:text-brand-300">
            {icon}
          </div>
        )}
      </div>
      <div className={`tnum mt-2 text-3xl font-semibold tracking-tight ${accent}`}>
        {typeof value === "number" ? <AnimatedCounter value={value} /> : value}
      </div>
    </Card>
  );
}

/** Shimmering skeleton block for loading states. */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton ${className}`} />;
}

/** Friendly empty state. */
export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon?: ReactNode;
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300/70 px-6 py-12 text-center dark:border-white/10">
      {icon && (
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-400 dark:bg-white/5">
          {icon}
        </div>
      )}
      <div className="text-sm font-semibold text-slate-700">{title}</div>
      {hint && <div className="mt-1 max-w-md text-sm text-slate-500">{hint}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

// Tone-based badge styling that adapts to dark mode.
const BADGE_TONE: Record<string, string> = {
  green: "bg-emerald-100 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-400/20",
  blue: "bg-brand-100 text-brand-700 ring-brand-600/20 dark:bg-brand-500/15 dark:text-brand-300 dark:ring-brand-400/20",
  indigo: "bg-indigo-100 text-indigo-700 ring-indigo-600/20 dark:bg-indigo-500/15 dark:text-indigo-300 dark:ring-indigo-400/20",
  amber: "bg-amber-100 text-amber-700 ring-amber-600/20 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-400/20",
  orange: "bg-orange-100 text-orange-700 ring-orange-600/20 dark:bg-orange-500/15 dark:text-orange-300 dark:ring-orange-400/20",
  red: "bg-rose-100 text-rose-700 ring-rose-600/20 dark:bg-rose-500/15 dark:text-rose-300 dark:ring-rose-400/20",
  teal: "bg-teal-100 text-teal-700 ring-teal-600/20 dark:bg-teal-500/15 dark:text-teal-300 dark:ring-teal-400/20",
  purple: "bg-purple-100 text-purple-700 ring-purple-600/20 dark:bg-purple-500/15 dark:text-purple-300 dark:ring-purple-400/20",
  slate: "bg-slate-100 text-slate-600 ring-slate-500/20 dark:bg-white/10 dark:text-slate-300 dark:ring-white/15",
};

const BADGE_VALUE_TONE: Record<string, keyof typeof BADGE_TONE> = {
  APPROVED: "green", COMPLETED: "green", OK: "green", VALID_COURSE_PAGE: "green",
  VALID_ADMISSION_PAGE: "green",
  PENDING: "blue", DISCOVERING: "blue",
  RUNNING: "green", READY: "green",
  QUEUED: "indigo",
  LOW_CONFIDENCE: "amber", WARN: "amber",
  NEEDS_REVIEW: "orange", BLOCKED: "orange",
  REJECTED: "red", FAILED: "red", ERROR: "red", BROKEN_LINK: "red",
  POSSIBLE_REQUIREMENT_PAGE: "teal",
  PDF_DEFERRED: "purple",
  REJECTED_CROSS_CONTEXT: "purple",
  DUPLICATE: "slate", IDLE: "slate", STOPPED: "slate",
};

export function Badge({ value }: { value: string }) {
  const tone = BADGE_TONE[BADGE_VALUE_TONE[value] ?? "slate"];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${tone}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
      {value}
    </span>
  );
}

export function ConfidenceBadge({ score }: { score: number }) {
  const color = score >= 0.8 ? "text-emerald-600 dark:text-emerald-400" : score >= 0.6 ? "text-amber-600 dark:text-amber-400" : "text-rose-600 dark:text-rose-400";
  return <span className={`tnum font-mono text-sm font-semibold ${color}`}>{score.toFixed(2)}</span>;
}

export function Button({
  children,
  onClick,
  variant = "primary",
  type = "button",
  disabled,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "danger" | "ghost" | "accent";
  type?: "button" | "submit";
  disabled?: boolean;
}) {
  const styles: Record<string, string> = {
    primary:
      "bg-gradient-to-b from-brand-500 to-brand-600 text-white shadow-sm hover:shadow-glow hover:from-brand-500 hover:to-brand-700",
    accent:
      "bg-gradient-to-b from-accent-400 to-accent-600 text-white shadow-sm hover:shadow-glow-accent hover:to-accent-700",
    secondary:
      "border border-slate-300 bg-white text-slate-800 shadow-sm hover:border-brand-300 hover:bg-slate-50 hover:text-brand-700 dark:border-white/20 dark:bg-white/[0.08] dark:text-slate-100 dark:hover:bg-white/[0.16] dark:hover:border-white/30",
    danger:
      "bg-gradient-to-b from-rose-500 to-rose-600 text-white shadow-sm hover:from-rose-500 hover:to-rose-700 hover:shadow-[0_0_0_1px_rgba(244,63,94,0.15),0_10px_40px_-12px_rgba(225,29,72,0.6)]",
    ghost: "text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-white/10 dark:hover:text-white",
  };
  const sheen = variant === "primary" || variant === "accent" || variant === "danger";
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`group relative inline-flex items-center justify-center gap-1.5 overflow-hidden rounded-lg px-3.5 py-1.5 text-sm font-medium transition-all duration-200 active:scale-[0.97] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/60 disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none disabled:active:scale-100 ${styles[variant]}`}
    >
      {sheen && (
        <span className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/30 to-transparent transition-transform duration-700 group-hover:translate-x-full" />
      )}
      <span className="relative z-10 inline-flex items-center gap-1.5">{children}</span>
    </button>
  );
}

/** Animated progress bar with optional label + percentage. */
export function ProgressBar({ percent, label }: { percent: number; label?: ReactNode }) {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div>
      {label !== undefined && (
        <div className="mb-1 flex items-center justify-between text-xs text-slate-500">
          <span>{label}</span>
          <span className="tnum font-medium text-slate-700">{p}%</span>
        </div>
      )}
      <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200/70 dark:bg-white/10">
        <div
          className="relative h-full rounded-full bg-gradient-to-r from-brand-400 via-brand-500 to-accent-500 shadow-[0_0_12px_rgba(59,130,246,0.45)] transition-all duration-500"
          style={{ width: `${p}%` }}
        >
          <span className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-white/40 to-transparent" />
        </div>
      </div>
    </div>
  );
}
