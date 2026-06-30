"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion, MotionConfig } from "framer-motion";
import { Nav } from "./Nav";
import { Header } from "./Header";
import { ToastProvider } from "./Toast";
import { CommandPalette } from "./CommandPalette";
import { BackdropFX } from "./BackdropFX";

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [dark, setDark] = useState(false);

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

  return (
    <MotionConfig reducedMotion="user">
    <ToastProvider>
      <BackdropFX />
      <CommandPalette />
      <div className="flex min-h-screen">
        {/* Sidebar: sticky (stays put while content scrolls) on desktop,
            slide-in drawer on mobile. */}
        <aside
          className={`fixed inset-y-0 left-0 z-40 w-64 transform transition-transform duration-300 ease-[cubic-bezier(.2,.7,.2,1)] lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 lg:self-start lg:overflow-y-auto ${
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
              className="fixed inset-0 z-30 bg-slate-900/40 backdrop-blur-sm lg:hidden"
              onClick={() => setMobileOpen(false)}
            />
          )}
        </AnimatePresence>

        <div className="flex min-w-0 flex-1 flex-col">
          <Header dark={dark} onToggleTheme={toggleTheme} onMenu={() => setMobileOpen(true)} />
          <main className="relative flex-1 px-5 py-6 md:px-8 lg:px-10">
            <AnimatePresence mode="wait">
              <motion.div
                key={pathname}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.3, ease: [0.22, 0.7, 0.2, 1] }}
                className="mx-auto w-full max-w-6xl"
              >
                {children}
              </motion.div>
            </AnimatePresence>
          </main>
        </div>
      </div>
    </ToastProvider>
    </MotionConfig>
  );
}
