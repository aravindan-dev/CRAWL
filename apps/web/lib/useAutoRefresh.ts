"use client";

import { useEffect, useRef } from "react";

/**
 * Keep a page's data live + in sync with actions taken on OTHER pages.
 * Calls `refresh` once on mount, then on an interval, AND whenever the tab/window
 * regains focus or becomes visible — so a delete/import/crawl elsewhere is
 * reflected here within a few seconds (or instantly when you switch back).
 *
 * Uses a ref so it works even if `refresh` isn't memoised (no churny re-subscribes).
 * Pass intervalMs = 0 for focus/visibility-only refresh (no periodic poll) — use
 * that on active pages (e.g. review screens) where a timer would be disruptive.
 */
export function useAutoRefresh(refresh: () => unknown, intervalMs = 5000): void {
  const ref = useRef(refresh);
  ref.current = refresh;

  useEffect(() => {
    const run = () => { if (typeof document === "undefined" || document.visibilityState === "visible") void ref.current(); };
    run(); // initial load
    const id = intervalMs > 0 ? setInterval(run, intervalMs) : undefined;
    window.addEventListener("focus", run);
    document.addEventListener("visibilitychange", run);
    return () => {
      if (id) clearInterval(id);
      window.removeEventListener("focus", run);
      document.removeEventListener("visibilitychange", run);
    };
  }, [intervalMs]);
}
