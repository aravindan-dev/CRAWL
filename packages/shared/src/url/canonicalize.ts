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
 * Derive the HTML course/web page a PDF "prospectus" URL belongs to, so the
 * crawler and exporter can prefer the real web page (where the entry requirements
 * live inline) over the downloadable PDF. The PDF is only a worst-case fallback.
 *
 * Strips the trailing PDF document segment — whether it's a year file or a named
 * file:
 *   /course/723AA/6/2024.pdf   -> /course/723AA/6
 *   /courses/x/prospectus.pdf  -> /courses/x
 *
 * Returns null when the URL is not a PDF (nothing to derive).
 */
export function htmlPageFromPdf(value: string): string | null {
  if (!isPdfUrl(value)) return null;
  try {
    const u = new URL(value);
    u.hash = "";
    u.search = "";
    const segs = u.pathname.split("/").filter(Boolean);
    if (segs.length === 0) return null;
    segs.pop(); // drop the "<…>.pdf" document segment
    if (segs.length === 0) return null;
    u.pathname = `/${segs.join("/")}`;
    return u.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
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

// Second-level public suffixes where the registrable domain is the THIRD label
// from the right (e.g. csu.edu.au, ox.ac.uk, du.ac.in). Curated for the academic
// TLDs universities use — enough to treat www./study./handbook. subdomains of ONE
// institution as the same site without over-matching every *.edu.au together.
const TWO_LABEL_SUFFIXES = new Set([
  "edu.au", "com.au", "org.au", "net.au", "gov.au", "ac.uk", "co.uk", "org.uk", "gov.uk", "sch.uk",
  "ac.nz", "edu.nz", "ac.in", "edu.in", "co.in", "org.in", "ac.jp", "ed.jp", "edu.sg", "edu.my", "edu.ph",
  "ac.th", "edu.hk", "edu.cn", "ac.kr", "edu.tw", "ac.id", "edu.pk", "ac.pk", "edu.bd", "ac.bd", "edu.np",
  "edu.lk", "ac.lk", "ac.za", "edu.eg", "ac.ir", "edu.sa", "ac.ae", "edu.qa", "edu.kw", "edu.jo", "edu.lb",
  "edu.tr", "edu.mx", "edu.br", "com.br", "edu.co", "edu.ar", "edu.pe", "edu.ua", "edu.pl", "edu.ng", "edu.gh",
  "ac.ke", "edu.vn", "ac.at", "edu.ro", "edu.gr", "edu.rs", "edu.ge", "edu.kz", "edu.ba", "edu.mt", "edu.cy",
]);

/**
 * Registrable domain (eTLD+1), subdomain-stripped — e.g. study.csu.edu.au → csu.edu.au,
 * www.ox.ac.uk → ox.ac.uk, handbook.unimelb.edu.au → unimelb.edu.au.
 */
export function registrableDomain(host: string): string {
  const parts = host.toLowerCase().replace(/^\.+|\.+$/g, "").split(".");
  if (parts.length <= 2) return parts.join(".");
  const last2 = parts.slice(-2).join(".");
  return (TWO_LABEL_SUFFIXES.has(last2) ? parts.slice(-3) : parts.slice(-2)).join(".");
}

/**
 * Same INSTITUTION site? True for an exact host match AND for sibling subdomains of
 * the same registrable domain — so a university's course catalog on
 * study./handbook./courses.<uni> is crawled together with www.<uni> (they are ONE
 * site). eTLD-aware, so it never treats every *.edu.au as a single domain. This is
 * what lets the crawler reach course pages that live on a separate subdomain.
 */
export function isSameDomain(a: string, b: string): boolean {
  try {
    const ha = new URL(a).hostname.toLowerCase();
    const hb = new URL(b).hostname.toLowerCase();
    if (ha === hb) return true;
    return registrableDomain(ha) === registrableDomain(hb);
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
