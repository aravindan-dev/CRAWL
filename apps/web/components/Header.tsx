"use client";

import type { AuthUser } from "../lib/api";
import { UserMenu } from "./UserMenu";

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}
function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}
function MenuIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

export function Header({
  dark,
  onToggleTheme,
  onMenu,
  user,
  onSignedOut,
}: {
  dark: boolean;
  onToggleTheme: () => void;
  onMenu: () => void;
  user?: AuthUser | null;
  onSignedOut?: () => void;
}) {
  return (
    <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-slate-200 bg-white/90 px-4 backdrop-blur-sm dark:border-white/[0.08] dark:bg-ink-900/90 md:px-8 lg:px-10">
      <div className="flex items-center gap-3">
        <button onClick={onMenu} aria-label="Open menu" className="rounded-lg p-2 text-slate-600 transition-colors hover:bg-slate-100 lg:hidden dark:hover:bg-white/10">
          <MenuIcon />
        </button>
        <div className="flex items-center gap-2 lg:hidden">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-600 text-xs font-bold text-white">CS</div>
          <span className="text-sm font-bold text-slate-900">CLG Search</span>
        </div>
        <div className="hidden items-center gap-2 text-sm text-slate-500 lg:flex">
          <span className="flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
          International Eligibility URL Extractor
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={onToggleTheme}
          aria-label="Toggle theme"
          className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 dark:border-white/15 dark:bg-white/[0.06] dark:text-slate-200 dark:hover:bg-white/[0.1]"
        >
          {dark ? <SunIcon /> : <MoonIcon />}
          <span className="hidden sm:inline">{dark ? "Light" : "Dark"}</span>
        </button>
        {user && onSignedOut && <UserMenu user={user} onSignedOut={onSignedOut} />}
      </div>
    </header>
  );
}
