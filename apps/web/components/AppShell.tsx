"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion, MotionConfig } from "framer-motion";
import { Nav } from "./Nav";
import { Header } from "./Header";
import { ToastProvider } from "./Toast";
import { CommandPalette } from "./CommandPalette";
import { RouteProgress } from "./RouteProgress";
import { LicenseLock } from "./LicenseLock";
import { LicenseGraceBanner } from "./LicenseGraceBanner";
import { LoginPage } from "./LoginPage";
import { SetupWizard } from "./SetupWizard";
import { api, type LicenseStatus, type AuthUser } from "../lib/api";

const LICENSE_WARNING_DAYS = 30;

function shouldWarn(status: LicenseStatus): boolean {
  return status.state === "grace" || (status.state === "valid" && (status.daysLeft ?? Infinity) <= LICENSE_WARNING_DAYS);
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [dark, setDark] = useState(false);
  const [license, setLicense] = useState<LicenseStatus | null>(null);
  const [setupRequired, setSetupRequired] = useState<boolean | null>(null);
  // undefined = not yet checked, null = checked and logged out, AuthUser = logged in.
  const [me, setMe] = useState<AuthUser | null | undefined>(undefined);

  // Global license gate: polled independently of any single page, so an
  // invalid/expired license locks EVERY route with no exceptions.
  useEffect(() => {
    let alive = true;
    const tick = () => api.get<LicenseStatus>("/license/status").then((s) => { if (alive) setLicense(s); }).catch(() => {});
    tick();
    const t = setInterval(tick, 60000);
    window.addEventListener("focus", tick);
    return () => { alive = false; clearInterval(t); window.removeEventListener("focus", tick); };
  }, []);

  // Auth: who (if anyone) is signed in, and whether first-run setup is needed.
  // A stray 401 elsewhere (session expired mid-use) dispatches "clg:auth-required"
  // (see lib/api.ts) so this re-checks immediately instead of waiting to poll.
  const checkAuth = useCallback(() => {
    api.get<{ setupRequired: boolean }>("/auth/setup-required").then((r) => setSetupRequired(r.setupRequired)).catch(() => {});
    api.get<{ user: AuthUser | null }>("/auth/me").then((r) => setMe(r.user)).catch(() => setMe(null));
  }, []);
  useEffect(() => {
    checkAuth();
    const t = setInterval(checkAuth, 60000);
    window.addEventListener("focus", checkAuth);
    window.addEventListener("clg:auth-required", checkAuth);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", checkAuth);
      window.removeEventListener("clg:auth-required", checkAuth);
    };
  }, [checkAuth]);

  // Initialise theme from storage / system preference.
  useEffect(() => {
    const stored = localStorage.getItem("clg-theme");
    const isDark = stored ? stored === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
    setDark(isDark);
    document.documentElement.classList.toggle("dark", isDark);
  }, []);

  const toggleTheme = useCallback(() => {
    setDark((d) => {
      const next = !d;
      document.documentElement.classList.toggle("dark", next);
      localStorage.setItem("clg-theme", next ? "dark" : "light");
      return next;
    });
  }, []);

  // Close the mobile drawer on route change.
  useEffect(() => setMobileOpen(false), [pathname]);

  // Every page is unreachable behind an invalid license — no exceptions.
  if (license?.state === "invalid") {
    return (
      <MotionConfig reducedMotion="user">
        <ToastProvider>
          <LicenseLock status={license} onActivated={setLicense} />
        </ToastProvider>
      </MotionConfig>
    );
  }

  // Skeleton while license/auth state resolves — avoids a flash of the app
  // (or the wrong gate screen) before we know which one applies.
  if (!license || setupRequired === null || me === undefined) {
    return (
      <MotionConfig reducedMotion="user">
        <div className="flex min-h-screen items-center justify-center bg-slate-50 dark:bg-ink-950">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600" />
        </div>
      </MotionConfig>
    );
  }

  if (setupRequired) {
    return (
      <MotionConfig reducedMotion="user">
        <ToastProvider>
          <SetupWizard onCreated={(user) => { setSetupRequired(false); setMe(user); }} />
        </ToastProvider>
      </MotionConfig>
    );
  }

  if (!me) {
    return (
      <MotionConfig reducedMotion="user">
        <ToastProvider>
          <LoginPage customerName={license.customerName} onLoggedIn={setMe} />
        </ToastProvider>
      </MotionConfig>
    );
  }

  return (
    <MotionConfig reducedMotion="user">
    <ToastProvider>
      <RouteProgress />
      <CommandPalette />
      <div className="flex min-h-screen">
        {/* Sidebar: sticky (stays put while content scrolls) on desktop,
            slide-in drawer on mobile. */}
        <aside
          className={`fixed inset-y-0 left-0 z-40 w-64 transform transition-transform duration-200 ease-out lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 lg:self-start lg:overflow-y-auto ${
            mobileOpen ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <Nav onNavigate={() => setMobileOpen(false)} />
        </aside>

        <AnimatePresence>
          {mobileOpen && (
            <motion.div
              key="scrim"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="fixed inset-0 z-30 bg-slate-900/50 lg:hidden"
              onClick={() => setMobileOpen(false)}
            />
          )}
        </AnimatePresence>

        <div className="flex min-w-0 flex-1 flex-col">
          <Header dark={dark} onToggleTheme={toggleTheme} onMenu={() => setMobileOpen(true)} user={me} onSignedOut={() => setMe(null)} />
          <main className="relative flex-1 px-5 py-6 md:px-8 lg:px-10">
            {/* No entrance animation: the new route's content paints instantly
                on navigation (the old fade started every page at opacity:0 for
                150ms, which read as lag). The top RouteProgress bar already
                gives immediate click feedback. */}
            <div className="mx-auto w-full max-w-6xl">
              {license && shouldWarn(license) && <LicenseGraceBanner status={license} />}
              {children}
            </div>
          </main>
        </div>
      </div>
    </ToastProvider>
    </MotionConfig>
  );
}
