"use client";

import { Fragment, type ReactNode } from "react";
import Link from "next/link";
import { Icons } from "./icons";

interface StepDef { n: number; href: string; label: string; icon: ReactNode }
const STEPS: StepDef[] = [
  { n: 1, href: "/universities", label: "Universities", icon: <Icons.university size={15} /> },
  { n: 2, href: "/crawl", label: "Crawl & Validate", icon: <Icons.crawl size={15} /> },
  { n: 3, href: "/revalidate", label: "Revalidate", icon: <Icons.shield size={15} /> },
  { n: 4, href: "/export", label: "Export & Aliff", icon: <Icons.operations size={15} /> },
];

/**
 * Guided 4-step stepper shown at the top of every pipeline page so the user
 * always sees where they are and can jump between steps. `current` highlights the
 * active step; earlier steps render as completed, later ones as upcoming. Purely
 * navigational (no fetch) — fast and safe to drop on any page.
 */
export function PipelineStepper({ current }: { current: 1 | 2 | 3 | 4 }) {
  return (
    <nav aria-label="Pipeline steps" className="glass flex flex-wrap items-center gap-1.5 rounded-2xl p-2 ring-1 ring-black/5 dark:ring-white/10">
      {STEPS.map((s, i) => {
        const state = s.n < current ? "done" : s.n === current ? "active" : "todo";
        const tone =
          state === "active"
            ? "bg-brand-50 text-brand-700 ring-1 ring-brand-500/25 dark:bg-brand-500/15 dark:text-brand-200"
            : state === "done"
              ? "text-emerald-700 hover:bg-emerald-50/60 dark:text-emerald-300 dark:hover:bg-white/5"
              : "text-slate-500 hover:bg-slate-100/60 dark:text-slate-400 dark:hover:bg-white/5";
        const badge =
          state === "active"
            ? "bg-brand-500 text-white"
            : state === "done"
              ? "bg-emerald-500 text-white"
              : "bg-slate-200 text-slate-500 dark:bg-white/10 dark:text-slate-400";
        return (
          <Fragment key={s.href}>
            <Link
              href={s.href}
              aria-current={state === "active" ? "step" : undefined}
              className={`group flex min-w-0 items-center gap-2 rounded-xl px-2.5 py-1.5 text-sm font-medium transition-colors ${tone}`}
            >
              <span className={`flex h-5 w-5 flex-none items-center justify-center rounded-md text-[11px] font-bold transition-transform group-hover:scale-110 ${badge}`}>
                {state === "done" ? "✓" : s.n}
              </span>
              <span className="hidden truncate sm:inline">{s.label}</span>
              <span className="truncate sm:hidden">{s.icon}</span>
            </Link>
            {i < STEPS.length - 1 && (
              <span aria-hidden className={`h-px w-3 flex-none sm:w-5 ${s.n < current ? "bg-emerald-400/60" : "bg-slate-200 dark:bg-white/10"}`} />
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}

/**
 * "Continue to the next step" call-to-action — a consistent footer button that
 * keeps the user moving through the pipeline without hunting in the sidebar.
 */
export function NextStep({ href, label, hint }: { href: string; label: string; hint?: string }) {
  return (
    <Link
      href={href}
      className="glass group flex items-center justify-between gap-4 rounded-2xl p-4 ring-1 ring-brand-500/15 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-glasshover"
    >
      <div className="min-w-0">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Next step</div>
        <div className="truncate font-semibold text-slate-900">{label}</div>
        {hint && <div className="truncate text-sm text-slate-500">{hint}</div>}
      </div>
      <span className="flex h-9 w-9 flex-none items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 text-white shadow-sm transition-transform group-hover:translate-x-0.5">
        <Icons.external size={16} />
      </span>
    </Link>
  );
}
