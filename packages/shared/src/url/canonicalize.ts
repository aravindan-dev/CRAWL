import { createHash } from "node:crypto";

/** Query params stripped during canonicalization (tracking / session noise). */
const TRACKING_PARAM_PREFIXES = ["utm_"];
const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "session",
  "sid",
  "phpsessid",
  "jsessionid",
  "_ga",
  "ref",
  "ref_src",
]);

const DROPPED_FILE_EXTENSIONS = new Set([
  ".doc",
  ".docx",
  ".ppt",
  ".pptx",
  ".zip",
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".svg",
  ".mp4",
  ".mp3",
  ".avi",
  ".mov",
  ".css",
  ".js",
  ".ico",
  ".woff",
  ".woff2",
]);

export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Lowercased file extension including the dot, or "" if none. */
export function getUrlExtension(value: string): string {
  try {
    const { pathname } = new URL(value);
    const dot = pathname.lastIndexOf(".");
    const slash = pathname.lastIndexOf("/");
    if (dot === -1 || dot < slash) return "";
    return pathname.slice(dot).toLowerCase();
  } catch {
    return "";
  }
}

export function isPdfUrl(value: string): boolean {
  return getUrlExtension(value) === ".pdf";
}

/** True for non-PDF binary/asset extensions that should never be crawled. */
export function isDroppedFileType(value: string): boolean {
  return DROPPED_FILE_EXTENSIONS.has(getUrlExtension(value));
}

/**
 * Resolve a possibly-relative href against a base URL. Returns null for
 * unsupported schemes (mailto:, tel:, javascript:, #fragments-only, etc.).
 */
export function resolveUrl(href: string, base: string): string | null {
  const trimmed = href.trim();
  if (!trimmed) return null;
  if (/^(mailto:|tel:|javascript:|data:|#)/i.test(trimmed)) return null;
  try {
    const resolved = new URL(trimmed, base);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      return null;
    }
    return resolved.toString();
  } catch {
    return null;
  }
}

/**
 * Canonicalize a URL for storage + deduplication:
 *  - lowercase hostname
 *  - drop fragment
 *  - strip tracking / session params
 *  - sort remaining params for stable ordering
 *  - normalize trailing slash (remove, except root "/")
 */
export function canonicalizeUrl(value: string): string {
  const u = new URL(value);
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();

  const keep: [string, string][] = [];
  for (const [key, val] of u.searchParams.entries()) {
    const lower = key.toLowerCase();
    if (TRACKING_PARAMS.has(lower)) continue;
    if (TRACKING_PARAM_PREFIXES.some((p) => lower.startsWith(p))) continue;
    keep.push([key, val]);
  }
  keep.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  u.search = "";
  for (const [key, val] of keep) u.searchParams.append(key, val);

  // Normalize trailing slash on the path (keep root "/").
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
    u.pathname = u.pathname.replace(/\/+$/, "");
  }

  return u.toString();
}

/** SHA-256 hex hash of the canonical form of a URL. */
export function hashUrl(value: string): string {
  const canonical = canonicalizeUrl(value);
  return createHash("sha256").update(canonical).digest("hex");
}

/** Same registrable host? (simple same-hostname comparison). */
export function isSameDomain(a: string, b: string): boolean {
  try {
    return new URL(a).hostname.toLowerCase() === new URL(b).hostname.toLowerCase();
  } catch {
    return false;
  }
}

/** Path depth = number of non-empty path segments. */
export function urlDepth(value: string): number {
  try {
    return new URL(value).pathname.split("/").filter(Boolean).length;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}
