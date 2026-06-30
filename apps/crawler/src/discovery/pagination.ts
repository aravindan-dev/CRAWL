/**
 * Pagination detection (Section 16). One university can list 100+ courses across
 * paginated catalog pages, so links that look like "next / load more / ?page=N"
 * are always worth following for discovery even if their keyword score is low.
 */
const PAGINATION_PATTERNS = [
  /[?&]page=\d+/i,
  /[?&]p=\d+/i,
  /\/page\/\d+/i,
  /[?&]start=\d+/i,
  /[?&]offset=\d+/i,
];

const PAGINATION_ANCHORS = [/next/i, /load\s*more/i, /show\s*more/i, /more\s*results/i, /^\d+$/];

export function isPaginationLink(url: string, anchorText = ""): boolean {
  if (PAGINATION_PATTERNS.some((re) => re.test(url))) return true;
  const a = anchorText.trim();
  return a.length > 0 && a.length <= 16 && PAGINATION_ANCHORS.some((re) => re.test(a));
}
