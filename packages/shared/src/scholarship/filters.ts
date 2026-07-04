/**
 * SCHOLARSHIP precision filters — the single source of truth for "is this URL a
 * real, individual scholarship record?". Used by the scholarship export
 * (scholarshipService), the live Validated-URLs feed (routes/links) AND the
 * crawler's pre-fetch URL classifier, so every stage agrees on what counts.
 */

// Files / news / events that mention scholarships but aren't scholarship pages.
export const SCH_NOISE = /\.(pdf|xlsx?|docx?|jpe?g|png)(\?|$)|\/news\/|\/blog\/|\/events?\/|\/staff\//i;

// BLOG / magazine articles ("Why apply for a scholarship: 5 students…", "Types of
// scholarship: a parent's guide", tag archives). These live on editorial subdomains
// (insight.*, blog.*, news.*) or under tag/category/author/archive paths — they are
// stories ABOUT scholarships, never a scholarship record.
export const SCH_BLOG_HOST = /^(insight|blog|blogs|news|stories|story|magazine|media|pulse)\./i;
export const SCH_BLOG_PATH = /\/(tag|category|author|archives?)\//i;

// FEE / tuition-cost pages. On some sites (CSU) the fees section lives under a
// "…/financial-and-scholarship/fees/…" path, so the word "scholarship" appears in
// the URL of pages that are purely about paying fees (Commonwealth supported
// places, full fee-paying, refunds…). Fees belong in a fees dataset — never here.
export const SCH_FEES =
  /\/fees?(\/|$)|fee[-_]?paying|course[-_]?fees?|tuition[-_]?fees?|commonwealth[-_]?supported|single[-_]?subject[-_]?study|fee[-_]?schedules?|refunds?[-_]|re[-_]?crediting|census[-_]?dates?|payment[-_]?(options?|plans?)|\/costs?(\/|$)/i;

// CATEGORY / LISTING container pages under a scholarship finder — NOT an individual
// scholarship. Real scholarships have a NAME segment after the category
// (…/find-scholarship/foundation/any-year/<name>), so a URL that ENDS at one of
// these container words is a listing page and must be dropped ("Foundation",
// "Continuing", "Commencing+Continuing" (any-year), "Equity", "Accom").
export const SCH_CONTAINER_END =
  /\/(scholarships?|scholarships?-grants|find-scholarship|foundation|continuing|commencing|any-year|accom|accommodation|equity|research|grants?|graduate-research|financial-assistance|scholarship-dashboard)\/?$/i;

// Login / auth / portal / search pages that sit under a scholarship path but are
// not a scholarship record (e.g. publicrequests.csu.edu.au/.../scholarship/login).
export const SCH_JUNK = /\/(login|signin|sign-in|logout|auth|dashboard|search|apply|application)\b|[?&]returnurl=/i;

/**
 * Why a URL is NOT a real scholarship record — or null if it passes every
 * precision filter. `uniReg` (the university's registrable domain, e.g.
 * "csu.edu.au") drops external aggregators; pass "" to skip the domain check.
 */
export function rejectScholarship(url: string, uniReg: string): string | null {
  const low = url.toLowerCase();
  if (SCH_NOISE.test(low)) return "file/news/event page";
  if (SCH_JUNK.test(low)) return "login/auth/search page";
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "malformed URL";
  }
  const host = u.hostname.toLowerCase();
  if (uniReg && registrable(host) !== uniReg) return "external site";
  if (SCH_BLOG_HOST.test(host) || SCH_BLOG_PATH.test(u.pathname)) return "blog/article page";
  if (SCH_FEES.test(u.pathname)) return "fees page";
  if (SCH_CONTAINER_END.test(u.pathname)) return "category/listing page";
  return null;
}

/** Registrable domain with multi-part TLD awareness (edu.au, ac.uk, …). */
export function registrable(host: string): string {
  const p = host.toLowerCase().split(".").filter(Boolean);
  if (p.length >= 3 && /^(edu|gov|ac|co|com|org|net)$/.test(p[p.length - 2]!)) return p.slice(-3).join(".");
  return p.slice(-2).join(".");
}
