"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

type Stage = "idle" | "loading" | "done" | "fading";

const START_EVENT = "clg:route-progress-start";

/** Call before a PROGRAMMATIC navigation (router.push, not a real <a> click —
 *  e.g. the command palette) so it gets the same instant feedback as a link
 *  click. Anchor clicks are caught automatically; this covers everything else. */
export function startRouteProgress() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(START_EVENT));
}

const STYLE: Record<Stage, React.CSSProperties> = {
  idle: { width: 0, opacity: 0, transitionDuration: "0ms" },
  // Creeps toward ~85% over a couple seconds so it never visibly "finishes"
  // while still waiting — most navigations here complete well before this.
  loading: { width: "85%", opacity: 1, transitionDuration: "2500ms", transitionTimingFunction: "cubic-bezier(0.1, 0.9, 0.2, 1)" },
  // Route landed: snap the remaining distance to 100% quickly.
  done: { width: "100%", opacity: 1, transitionDuration: "180ms", transitionTimingFunction: "ease-out" },
  // Then fade out in place (width unchanged) before resetting to idle.
  fading: { width: "100%", opacity: 0, transitionDuration: "250ms", transitionTimingFunction: "ease-in" },
};

/**
 * Global top-of-page progress bar for route transitions — the classic
 * "YouTube-style" bar that starts the INSTANT a nav link is clicked, giving
 * immediate confirmation the click registered even before the destination
 * route's RSC payload/JS chunk has arrived. Without this, a click on a
 * not-yet-prefetched route shows nothing at all until the new page is ready.
 *
 * A real four-stage machine (not a naive 0%<->100% toggle) so FAST
 * navigations — the common case here, since Next prefetches viewport-visible
 * links — don't flicker. Every stage transition happens via setState (never
 * direct DOM style mutation), so it's immune to a parent re-render (AppShell
 * has its own state) stomping an in-progress fade via React's next render.
 * Advancing idle->done->fading->idle is tied to the REAL `transitionend`
 * event, not a guessed timeout.
 *
 * Deliberately plain CSS (no framer-motion): renders identically — invisible,
 * width 0 — on the server and the client's first paint; everything here only
 * happens after mount via effects/listeners, so it can't hit the
 * useReducedMotion() synchronous-read hydration-mismatch class of bug.
 */
export function RouteProgress() {
  const pathname = usePathname();
  const [stage, setStage] = useState<Stage>("idle");
  const barRef = useRef<HTMLDivElement | null>(null);
  const prevPathname = useRef(pathname);

  // A same-tab, same-origin link click means a route change is *starting* —
  // show the bar immediately, well before Next has swapped anything in.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // open-in-new-tab etc.
      const anchor = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      if (anchor.target && anchor.target !== "_self") return;
      if (anchor.hasAttribute("download")) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      // A same-page hash-only link (or the current path) isn't a route change.
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      setStage("loading");
    };
    document.addEventListener("click", onClick, true);
    const onStart = () => setStage("loading");
    window.addEventListener(START_EVENT, onStart);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener(START_EVENT, onStart);
    };
  }, []);

  // The pathname changing confirms the new route has actually landed.
  useEffect(() => {
    if (prevPathname.current === pathname) return;
    prevPathname.current = pathname;
    setStage((s) => (s === "loading" ? "done" : s));
  }, [pathname]);

  // Advance done -> fading -> idle strictly on the real transition finishing.
  useEffect(() => {
    if (stage !== "done" && stage !== "fading") return;
    const el = barRef.current;
    if (!el) return;
    const onEnd = (ev: TransitionEvent) => {
      if (stage === "done" && ev.propertyName === "width") setStage("fading");
      else if (stage === "fading" && ev.propertyName === "opacity") setStage("idle");
    };
    el.addEventListener("transitionend", onEnd);
    return () => el.removeEventListener("transitionend", onEnd);
  }, [stage]);

  return (
    <div
      ref={barRef}
      aria-hidden
      className="pointer-events-none fixed left-0 top-0 z-[200] h-[2.5px] bg-gradient-to-r from-brand-400 via-brand-500 to-brand-600 transition-[width,opacity]"
      style={STYLE[stage]}
    />
  );
}
