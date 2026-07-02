import { isPdfUrl, isDroppedFileType } from "@clg/shared";

/** Path/keyword patterns that are never relevant (Section 14 hard rejects). */
const REJECT_PATH_PATTERNS = [
  /\/login\b/i,
  /\/signin\b/i,
  /\/portal\b/i,
  /\/privacy\b/i,
  /\/terms\b/i,
  /\/news\b/i,
  /\/events?\b/i,
  /\/careers?\b/i,
  /\/jobs?\b/i,
  /\/contact\b/i,
  /\/alumni\b/i,
  /\/(donate|donation|giving)\b/i,
  /\/library\b/i,
  /\/calendar\b/i,
  /\/search\b/i,
  /\/cart\b/i,
  /\/account\b/i,
  // Broken CMS/JS links where a slug variable was never populated (…/undefined/…,
  // …/null/…). These 404 — never crawl or record them.
  /\/(undefined|null)(\/|$)/i,
  // SUBJECT / UNIT / MODULE catalog pages — course COMPONENTS, never courses.
  // Handbook-style sites (e.g. handbook.csu.edu.au) list THOUSANDS of
  // /subject/2026/HCS523 unit pages; crawling them was what stretched one
  // university to ~3 hours while adding zero deliverable rows. The deliverable is
  // the course page; its units/areas-of-study/timetables are hard-rejected.
  /\/subjects?\/(19|20)\d\d\//i,
  /\/subjects?\/[a-z]{2,6}\d{2,5}\b/i,
  /\/(units?|modules?)\/(19|20)\d\d\//i,
  /\/aos\/(19|20)\d\d\//i, // handbook "area of study" listings (subject groupings)
  /\/timetables?\b/i,
  /\/exams?\b/i,
];

/** Social / external link hosts to drop. */
const SOCIAL_HOSTS = [
  "facebook.com",
  "twitter.com",
  "x.com",
  "instagram.com",
  "linkedin.com",
  "youtube.com",
  "tiktok.com",
  "pinterest.com",
  "flickr.com",
  "weibo.com",
];

export type RejectReason =
  | "DROPPED_FILE"
  | "SOCIAL"
  | "REJECTED_PATH"
  | null;

export interface FilterResult {
  rejected: boolean;
  reason: RejectReason;
  /** PDFs are not crawled but are recorded as PDF_DEFERRED rather than dropped. */
  isPdf: boolean;
}

export function filterLink(url: string): FilterResult {
  if (isPdfUrl(url)) return { rejected: true, reason: null, isPdf: true };
  if (isDroppedFileType(url)) return { rejected: true, reason: "DROPPED_FILE", isPdf: false };

  let host = "";
  let path = "";
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    path = u.pathname.toLowerCase();
  } catch {
    return { rejected: true, reason: "REJECTED_PATH", isPdf: false };
  }

  if (SOCIAL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
    return { rejected: true, reason: "SOCIAL", isPdf: false };
  }
  if (REJECT_PATH_PATTERNS.some((re) => re.test(path))) {
    return { rejected: true, reason: "REJECTED_PATH", isPdf: false };
  }
  return { rejected: false, reason: null, isPdf: false };
}
