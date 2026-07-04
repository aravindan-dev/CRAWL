import { LinkStatus, type ExtractedPage } from "@clg/shared";

const MIN_TEXT_LENGTH = 400;

const SOFT_404 = [/page not found/i, /404\s*(error)?/i, /no longer exists/i, /can't find the page/i];
const LOGIN_WALL = [/please (log|sign) ?in/i, /login required/i, /you must be logged in/i];
// Anti-bot interstitials (Cloudflare "managed challenge" & friends). These can
// arrive with HTTP 200, so status alone can't catch them — and their thin
// spinner text must NEVER be validated or mistaken for a real thin page.
// Observed live: a flagged CDN serves "Just a moment..." for EVERY route
// (even robots.txt) until the flag decays.
const BOT_CHALLENGE = [
  /just a moment/i,
  /checking your browser/i,
  /verify(ing)? you are (a )?human/i,
  /enable javascript and cookies to continue/i,
  /attention required!?\s*\|\s*cloudflare/i,
  /challenges\.cloudflare\.com/i,
  /request unsuccessful\. incapsula/i,
  /_cf_chl_opt/i,
];

const COURSE_KEYWORDS = /\b(course|programme?|degree|bachelor|b\.?sc|b\.?a|major)\b/i;
const ADMISSION_KEYWORDS = /\b(admission|apply|entry|how to apply)\b/i;
const REQUIREMENT_KEYWORDS = /\b(eligibility|requirements?|entry requirements?|prerequisite)\b/i;

export interface PageClassification {
  status: LinkStatus;
  reason: string;
  source_language: string;
}

/**
 * Classify a validated page (Section 17) into a LinkStatus. HTTP-level outcomes
 * (broken/blocked/redirect) are decided by the caller from the response; this
 * focuses on content-based classification once a page has loaded.
 */
export function classifyPage(params: {
  httpStatus: number | null;
  requestedUrl: string;
  page: ExtractedPage;
}): PageClassification {
  const { httpStatus, page } = params;
  const text = page.visible_text ?? "";
  const lang = (page.lang ?? "en").slice(0, 2).toLowerCase() || "en";
  const base = { source_language: lang };

  // Bot-challenge interstitial? Checked BEFORE the http-status branch: the
  // challenge is the page content regardless of status code (200/403/503), and
  // "bot-challenge" is the actionable reason (the crawler backs off on it).
  const title = page.page_title ?? "";
  const challengeHay = `${title}\n${text.slice(0, 1500)}\n${(page.raw_html ?? "").slice(0, 6000)}`;
  if (BOT_CHALLENGE.some((re) => re.test(challengeHay))) {
    return { status: LinkStatus.BLOCKED, reason: "bot-challenge", ...base };
  }

  if (httpStatus !== null && httpStatus >= 400) {
    const blocked = httpStatus === 401 || httpStatus === 403 || httpStatus === 429 || httpStatus === 503;
    return { status: blocked ? LinkStatus.BLOCKED : LinkStatus.BROKEN_LINK, reason: `http ${httpStatus}`, ...base };
  }
  if (SOFT_404.some((re) => re.test(title) || re.test(text.slice(0, 600)))) {
    return { status: LinkStatus.BROKEN_LINK, reason: "soft-404", ...base };
  }
  if (text.length < MIN_TEXT_LENGTH && LOGIN_WALL.some((re) => re.test(text))) {
    return { status: LinkStatus.BLOCKED, reason: "login-wall", ...base };
  }
  if (text.length < MIN_TEXT_LENGTH) {
    return { status: LinkStatus.LOW_CONFIDENCE_PAGE, reason: "thin-content", ...base };
  }

  const hasReq = REQUIREMENT_KEYWORDS.test(text);
  const hasCourse = COURSE_KEYWORDS.test(text);
  const hasAdmission = ADMISSION_KEYWORDS.test(text);

  if (hasReq && hasCourse) return { status: LinkStatus.VALID_COURSE_PAGE, reason: "course+requirements", ...base };
  if (hasReq) return { status: LinkStatus.POSSIBLE_REQUIREMENT_PAGE, reason: "requirements", ...base };
  if (hasAdmission) return { status: LinkStatus.VALID_ADMISSION_PAGE, reason: "admission", ...base };
  if (hasCourse) return { status: LinkStatus.VALID_COURSE_PAGE, reason: "course", ...base };

  return { status: LinkStatus.NOT_RELEVANT, reason: "no-keywords", ...base };
}

/** Whether a classified page warrants running the parser on it. */
export function isParseablePage(status: LinkStatus): boolean {
  return (
    status === LinkStatus.VALID_COURSE_PAGE ||
    status === LinkStatus.VALID_ADMISSION_PAGE ||
    status === LinkStatus.POSSIBLE_REQUIREMENT_PAGE
  );
}
