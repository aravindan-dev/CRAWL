/**
 * Entry-requirements deep-linking — shared by the LIVE crawl (so the validated
 * feed shows the exact eligibility URL the moment a page is crawled) and the
 * exporter (so the final deliverable matches what was shown live).
 *
 * Most course pages keep their entry requirements in a same-page tab/section/modal
 * whose anchor id varies by university (#entry-requirements, #entry-criteria,
 * #admission-requirements, #academicentryrequirementsmodal, #international-entry-…).
 * Rather than hardcode them, we match the page's own anchor ids / jump-link labels
 * against the EDITABLE eligibility + international keyword vocabulary, so adding a
 * keyword in Settings widens detection. A preference order picks the most specific
 * (international entry) section when several match.
 */
import { getKeywords, keywordsToRegex } from "@clg/shared";

const KW = getKeywords();
const ELIG_ANCHOR_RE = keywordsToRegex(KW.eligibility);
const INTL_ANCHOR_RE = keywordsToRegex(KW.international);

const ANCHOR_PREF: RegExp[] = [
  /international.*(requirement|criteri|entry|eligib|qualif)/i, // international-specific entry section (best)
  /entry[-_ ]?requirement/i,
  /entry[-_ ]?criteri/i,
  /admission[-_ ]?requirement/i,
  /admission[-_ ]?criteri/i,
  /academic[-_ ]?requirement/i,
  /how[-_ ]?to[-_ ]?apply/i,
  /entry[-_ ]?profile/i,
  /\brequirement/i,
  /\beligib/i,
  /\badmission/i,
  /\bentry\b/i,
];
// UI-chrome prefixes: the deep-link target is the SECTION id (e.g.
// "entry-requirements"), not the tab BUTTON / panel wrapper id
// ("tab-entry-requirements", "panel-…"). Prefer the clean section id.
const CHROME_AFFIX =
  /^(tab|tabs|panel|pane|accordion|collapse|collapsible|btn|button|heading|header|hdr|title|nav|navtab|link|section|sect|content|target|jump|toggle|menu|item|trigger|control|aria)[-_]|[-_](tab|panel|pane|btn|button|link|heading|header|trigger|content)$/;

/**
 * Best entry-requirements anchor id on a page, chosen from the page's own anchor
 * ids / jump-link labels using the editable keyword vocabulary. Prefers the clean
 * section id over a tab/panel wrapper, and the most specific match
 * (international-entry > entry-requirements > … > entry). Returns null if none.
 */
export function entryRequirementAnchor(html: string): string | null {
  if (!html) return null;
  // (A) Prefer an explicit jump-link whose VISIBLE TEXT is about entry requirements.
  // Many templates use OPAQUE section ids (e.g. #c161699) with the label only in the
  // link text ("Fees and entry requirements"), so id-matching alone misses them.
  const labelPref: RegExp[] = [
    /international[^<]*(?:entry|requirement|criteri|eligib|qualif)/i,
    /entry[\s-]*requirements?/i,
    /entry[\s-]*criteri/i,
    /admission[\s-]*requirements?/i,
    /fees?\s*(?:and|&|\/)?\s*entry[\s-]*requirements?/i,
    /how[\s-]*to[\s-]*apply/i,
    /\bentry\b[^<]*requirement/i,
  ];
  const labelled: { target: string; text: string }[] = [];
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']#([A-Za-z0-9_-]{2,60})["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const text = m[2]!.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (/entry|admission|requirement|criteri|eligib|how to apply/i.test(text)) labelled.push({ target: m[1]!.toLowerCase(), text });
  }
  for (const pref of labelPref) {
    const hit = labelled.find((l) => pref.test(l.text));
    if (hit) return hit.target;
  }
  // (B) Fall back to matching anchor IDS against the eligibility vocabulary.
  const ids = new Set<string>();
  for (const m of html.matchAll(/(?:\bid|\bname)\s*=\s*["']([A-Za-z0-9_-]{3,60})["']/g)) ids.add(m[1]!.toLowerCase());
  for (const m of html.matchAll(/href\s*=\s*["']#([A-Za-z0-9_-]{3,60})["']/g)) ids.add(m[1]!.toLowerCase());
  // Candidates = anchor ids that match the eligibility vocabulary, OR an
  // international anchor clearly about entry/requirements/qualifications.
  const all = [...ids].filter(
    (id) => ELIG_ANCHOR_RE.test(id) || (INTL_ANCHOR_RE.test(id) && /requirement|criteri|entry|eligib|qualif|admission/i.test(id)),
  );
  if (!all.length) return null;
  const pick = (list: string[]): string | undefined => {
    for (const pref of ANCHOR_PREF) { const hit = list.find((id) => pref.test(id)); if (hit) return hit; }
    return [...list].sort((a, b) => a.length - b.length)[0]; // else the shortest (cleanest) match
  };
  const clean = all.filter((id) => !CHROME_AFFIX.test(id));
  return (clean.length ? pick(clean) : pick(all)) ?? null;
}

/**
 * Deep-link a page URL to its entry-requirements section: `<url>#<anchor>` when an
 * anchor is found on the page, else the URL unchanged. Strips any existing hash /
 * trailing slash first so the result is clean and idempotent.
 */
export function deepLinkEligibility(url: string, html: string): string {
  const anchor = entryRequirementAnchor(html);
  if (!anchor) return url;
  const base = url.replace(/#.*$/, "").replace(/\/$/, "");
  return `${base}#${anchor}`;
}
