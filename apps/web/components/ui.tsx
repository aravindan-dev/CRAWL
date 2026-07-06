"use client";

import { useState, type ReactNode } from "react";
import { AnimatedCounter } from "./AnimatedCounter";

/** Small inline spinner for buttons/inline pending states. Sized via font-size (em). */
export function Spinner({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={`h-4 w-4 flex-none animate-spin ${className}`} fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Clean card surface. Backward-compatible ({children, className}); the legacy
 * `spotlight` / `gradientRing` props are accepted but intentionally inert —
 * the professional system uses quiet borders and elevation, not effects.
 */
export function Card({
  children,
  className = "",
  hover = false,
}: {
  children: ReactNode;
  className?: string;
  spotlight?: boolean;
  hover?: boolean;
  gradientRing?: boolean;
}) {
  return (
    <div
      className={[
        "glass relative transition-shadow duration-150",
        hover ? "hover:border-slate-300 hover:shadow-card-hover dark:hover:border-white/[0.14]" : "",
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
    <Card hover className="p-5">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-slate-500">{label}</div>
        {icon && (
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100 text-slate-500 dark:bg-white/[0.06] dark:text-slate-300">
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
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-300/80 px-6 py-12 text-center dark:border-white/10">
      {icon && (
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-slate-100 text-slate-400 dark:bg-white/5">
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
  green: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-400/20",
  blue: "bg-brand-50 text-brand-700 ring-brand-600/20 dark:bg-brand-500/10 dark:text-brand-300 dark:ring-brand-400/20",
  indigo: "bg-indigo-50 text-indigo-700 ring-indigo-600/20 dark:bg-indigo-500/10 dark:text-indigo-300 dark:ring-indigo-400/20",
  amber: "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-400/20",
  orange: "bg-orange-50 text-orange-700 ring-orange-600/20 dark:bg-orange-500/10 dark:text-orange-300 dark:ring-orange-400/20",
  red: "bg-rose-50 text-rose-700 ring-rose-600/20 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-400/20",
  teal: "bg-teal-50 text-teal-700 ring-teal-600/20 dark:bg-teal-500/10 dark:text-teal-300 dark:ring-teal-400/20",
  purple: "bg-purple-50 text-purple-700 ring-purple-600/20 dark:bg-purple-500/10 dark:text-purple-300 dark:ring-purple-400/20",
  slate: "bg-slate-50 text-slate-600 ring-slate-500/20 dark:bg-white/[0.06] dark:text-slate-300 dark:ring-white/15",
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

/** True when a value looks like a thenable (Promise), without importing one type. */
function isThenable(v: unknown): v is Promise<unknown> {
  return !!v && typeof v === "object" && typeof (v as { then?: unknown }).then === "function";
}

export function Button({
  children,
  onClick,
  variant = "primary",
  type = "button",
  disabled,
  loading,
}: {
  children: ReactNode;
  /** May return a Promise — the button then self-manages a pending/disabled/spinner
   *  state for the duration, so every async action gets instant click feedback
   *  without each call site tracking its own "busy" flag. */
  onClick?: () => void | Promise<unknown>;
  variant?: "primary" | "secondary" | "danger" | "ghost" | "accent";
  type?: "button" | "submit";
  disabled?: boolean;
  /** Force the pending/spinner state externally (e.g. a parent tracking which of
   *  several buttons is in flight). Combines with auto-detected async onClick. */
  loading?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const styles: Record<string, string> = {
    primary:
      "bg-brand-600 text-white shadow-sm hover:bg-brand-700 dark:bg-brand-500 dark:hover:bg-brand-400",
    accent:
      "bg-accent-500 text-white shadow-sm hover:bg-accent-600",
    secondary:
      "border border-slate-300 bg-white text-slate-800 shadow-sm hover:border-slate-400 hover:bg-slate-50 dark:border-white/15 dark:bg-white/[0.06] dark:text-slate-100 dark:hover:border-white/25 dark:hover:bg-white/[0.1]",
    danger:
      "bg-rose-600 text-white shadow-sm hover:bg-rose-700",
    ghost: "text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-white/10 dark:hover:text-white",
  };
  const busy = loading || pending;
  const handleClick = () => {
    if (!onClick || busy) return;
    const result = onClick();
    if (isThenable(result)) {
      setPending(true);
      result.finally(() => setPending(false));
    }
  };
  return (
    <button
      type={type}
      onClick={handleClick}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors duration-150 active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/60 disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none disabled:active:scale-100 ${styles[variant]}`}
    >
      {busy && <Spinner />}
      {children}
    </button>
  );
}

/** Progress bar with optional label + percentage. */
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
      <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200/80 dark:bg-white/10">
        <div
          className="h-full rounded-full bg-brand-600 transition-all duration-500 dark:bg-brand-500"
          style={{ width: `${p}%` }}
        />
      </div>
    </div>
  );
}
