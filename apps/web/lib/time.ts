// Shared, human-friendly time formatting for the whole web UI.
// Everything is shown in the viewer's LOCAL time — we never print a raw UTC offset
// like "(UTC+05:30)". `timeAgo` gives the live "just now / 2 mins ago" feel; the
// tooltip helpers give the exact local date/time.

type TimeInput = string | number | Date | null | undefined;

function toMs(input: TimeInput): number | null {
  if (input === null || input === undefined || input === "") return null;
  const t = input instanceof Date ? input.getTime() : new Date(input).getTime();
  return Number.isNaN(t) ? null : t;
}

/** Relative, live-updating label: "just now", "1 min ago", "2 mins ago", "3 hours ago", "yesterday", "4 days ago". Older than a week falls back to the local date. */
export function timeAgo(input: TimeInput): string {
  const t = toMs(input);
  if (t === null) return "—";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 0) return "just now"; // small clock skew / future timestamp
  if (s < 10) return "just now";
  if (s < 60) return `${s} secs ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return "yesterday";
  if (d < 7) return `${d} days ago`;
  return localDateTime(t);
}

/** Exact local date + time, e.g. "2 Jul 2026, 12:05" — no timezone annotation. */
export function localDateTime(input: TimeInput): string {
  const t = toMs(input);
  if (t === null) return "—";
  return new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Exact local date only, e.g. "2 Jul 2026". */
export function localDate(input: TimeInput): string {
  const t = toMs(input);
  if (t === null) return "—";
  return new Date(t).toLocaleDateString(undefined, { dateStyle: "medium" });
}
