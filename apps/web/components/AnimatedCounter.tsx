"use client";

/**
 * Renders a number instantly. (Previously it ran a requestAnimationFrame
 * count-up on every value change — which, on live dashboards that re-poll every
 * ~3s, meant the numbers were perpetually rolling and re-rendering. For a fast,
 * calm UI we just show the value.) Kept as a component so callers don't change.
 */
export function AnimatedCounter({ value }: { value: number; duration?: number }) {
  return <>{value.toLocaleString()}</>;
}
