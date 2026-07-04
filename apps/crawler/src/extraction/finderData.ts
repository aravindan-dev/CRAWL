/**
 * FINDER DATA EXTRACTION (redesign Step 5 — "optimize dynamic finders").
 *
 * Course/scholarship finders usually render their full result set from a
 * first-party data payload that is ALREADY in the delivered HTML:
 *   - Next.js       → <script id="__NEXT_DATA__" type="application/json">…</script>
 *   - islands/SSR   → <script type="application/json">…</script>
 *   - schema.org    → <script type="application/ld+json">…</script>
 *
 * Rather than click "Load more" and infinite-scroll a headless browser (seconds
 * per finder), we parse those JSON blobs and pull every URL/slug out of them.
 * This is a PURE string→string[] function (no browser, no network) so it is
 * unit-testable; the crawler uses browser expansion only when this yields too
 * few links. Extracted URLs still pass the normal classify→authorize→filter gate.
 */
import { resolveUrl } from "@clg/shared";

/** All <script> JSON islands worth mining, in priority order. */
const JSON_SCRIPT_RE =
  /<script\b[^>]*\btype\s*=\s*["'](?:application\/json|application\/ld\+json)["'][^>]*>([\s\S]*?)<\/script>/gi;
const NEXT_DATA_RE = /<script\b[^>]*\bid\s*=\s*["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i;

/** Keys whose string values are treated as link candidates. */
const URL_KEY = /^(url|href|link|slug|path|permalink|canonical(?:Url)?|pageUrl|detailUrl|to)$/i;

/** Recursively collect URL-ish strings from a parsed JSON value. */
function harvest(node: unknown, into: Set<string>, depth = 0): void {
  if (depth > 12 || node == null) return;
  if (typeof node === "string") {
    // Absolute or root-relative path that plausibly points at a page (not an
    // asset). Bare slugs are captured via their key below, not here.
    if (/^https?:\/\//i.test(node) || /^\/[^\s"']*$/.test(node)) into.add(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const v of node) harvest(v, into, depth + 1);
    return;
  }
  if (typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (typeof v === "string" && URL_KEY.test(k) && v && !/^https?:\/\//i.test(v) && !v.startsWith("/")) {
        // A bare slug under a url-ish key (e.g. slug:"bsc-nursing") — keep it as a
        // relative candidate so resolveUrl can join it to the finder's URL.
        into.add(v);
      }
      harvest(v, into, depth + 1);
    }
  }
}

function parseJsonLoose(raw: string): unknown {
  const t = raw.trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

/**
 * Pull candidate link URLs out of a finder page's embedded JSON, resolved
 * against the page URL. Returns absolute URLs, de-duplicated. Best-effort: any
 * blob that fails to parse is simply skipped.
 */
export function extractLinksFromJson(html: string, pageUrl: string): string[] {
  if (!html) return [];
  const raw = new Set<string>();

  const next = NEXT_DATA_RE.exec(html);
  if (next?.[1]) harvest(parseJsonLoose(next[1]), raw);

  let m: RegExpExecArray | null;
  JSON_SCRIPT_RE.lastIndex = 0;
  let scanned = 0;
  while ((m = JSON_SCRIPT_RE.exec(html)) !== null && scanned < 40) {
    scanned += 1;
    if (m[1]) harvest(parseJsonLoose(m[1]), raw);
  }

  const out = new Set<string>();
  for (const candidate of raw) {
    const abs = resolveUrl(candidate, pageUrl);
    if (abs) out.add(abs);
  }
  return [...out];
}
