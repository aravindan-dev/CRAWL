import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { repoRoot, getKeywords, keywordsToRegex } from "@clg/shared";
import { prisma } from "@clg/database";

/**
 * Coverage Reconciliation Engine.
 * For every official course we discovered, map it to an eligibility URL and give
 * it a FINAL status — so nothing is silently missed. Uncertain courses become a
 * review queue; a university is COMPLETE only when every course is mapped or
 * reviewed. Manual decisions persist to storage/coverage-overrides.json.
 */
export type CourseStatus = "FOUND" | "SHARED" | "NEEDS_REVIEW" | "NOT_FOUND";

const OVERRIDES_PATH = resolve(repoRoot(), "storage", "coverage-overrides.json");

const COURSE_RE = /(\/courses?\/|\/programmes?\/|\/programs?\/|\/degrees?\/|\/undergraduate\/[^/]+|\/study\/[^/]+|bachelor|-bsc\b|-bs\b|-ba\b|-beng\b|-bba\b|-llb\b|-msc\b|-ma\b)/i;
const COURSE_DENY = /(\?|\/abroad\b|study[-_]?abroad|\/search\b|\/compare\b|\/clearing\b|\/open[-_]?days?\b|\/course[-_]?enquiry)/i;
const ELIG_RE = /(international[-_]?students?|\/international\/|english[-_]?language|\bielts\b|\btoefl\b|\/visa\b|entry[-_]?requirements?|entry[-_]?criteria|eligibility|admission)/i;
const INSIDE_RE = /(entry[-_]?requirements?|entry[-_]?criteria|eligib|admission|how[-_]?to[-_]?apply|requirements?)/i;

interface Override { status: CourseStatus; eligibilityUrl?: string; by?: "manual" | "ai" }
function loadOverrides(): Record<string, Override> {
  try {
    if (!existsSync(OVERRIDES_PATH)) return {};
    const raw = JSON.parse(readFileSync(OVERRIDES_PATH, "utf8")) as Record<string, Override | CourseStatus>;
    // Migrate any legacy string entries to objects.
    return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, typeof v === "string" ? { status: v } : v]));
  } catch { return {}; }
}
function saveOverrides(o: Record<string, Override>) {
  mkdirSync(resolve(repoRoot(), "storage"), { recursive: true });
  writeFileSync(OVERRIDES_PATH, JSON.stringify(o, null, 2), "utf8");
}

const isWorking = (status: string, http: number | null) =>
  http !== null ? http >= 200 && http < 400 : ["VALID_COURSE_PAGE", "VALID_ADMISSION_PAGE", "POSSIBLE_REQUIREMENT_PAGE"].includes(status);
const isDead = (status: string, http: number | null) => status === "BROKEN_LINK" || http === 404 || http === 410;

function courseName(url: string, title: string | null): string {
  if (title && title.trim()) return title.split("|")[0]!.split(" - ")[0]!.trim().slice(0, 90);
  try {
    const segs = new URL(url).pathname.split("/").filter(Boolean);
    const seg = [...segs].reverse().find((s) => /[a-z]{4,}/i.test(s)) ?? segs[segs.length - 1] ?? "";
    return seg.replace(/\.(html?|php)$/i, "").replace(/[-_]+/g, " ").replace(/\b\w/g, (m) => m.toUpperCase()).trim();
  } catch { return url; }
}

export interface CoverageCourse {
  linkId: string;
  courseName: string;
  courseUrl: string;
  eligibilityUrl: string;
  eligibilityType: string;
  status: CourseStatus;
  confidence: number;
  evidenceText: string;
  suggested: string[];
  overridden: boolean;
}
export interface CoverageUniversity {
  id: string; name: string; country: string;
  total: number; found: number; shared: number; needsReview: number; notFound: number;
  status: "COMPLETE" | "INCOMPLETE" | "NO_DATA";
  courses: CoverageCourse[];
}

export async function computeCoverage(filterUniId?: string): Promise<CoverageUniversity[]> {
  const overrides = loadOverrides();
  const unis = await prisma.university.findMany({
    where: filterUniId ? { id: filterUniId } : undefined,
    select: { id: true, name: true, country: true },
    orderBy: { name: "asc" },
  });

  const out: CoverageUniversity[] = [];
  for (const u of unis) {
    const links = await prisma.discoveredLink.findMany({
      where: { university_id: u.id },
      select: { id: true, url: true, final_url: true, page_title: true, status: true, http_status: true, link_score: true },
    });

    // University-level eligibility pages → used as the SHARED target + suggestions.
    const uniElig = links
      .filter((l) => { const low = (l.final_url ?? l.url).toLowerCase(); return !COURSE_RE.test(low) && ELIG_RE.test(low) && isWorking(l.status, l.http_status); })
      .sort((a, b) => (b.link_score ?? 0) - (a.link_score ?? 0));
    const sharedUrl = uniElig[0] ? uniElig[0].final_url ?? uniElig[0].url : "";
    const suggestedUni = uniElig.slice(0, 3).map((l) => l.final_url ?? l.url);

    // Map of every working discovered URL (normalized) → actual URL, so a course
    // can be linked to its OWN dedicated requirements page if one was crawled
    // (e.g. Seneca: /programs/fulltime/AIG.html → /programs/fulltime/AIG/admission-requirements.html).
    const norm = (u: string) => u.replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
    const workingUrls = new Map<string, string>();
    for (const l of links) {
      if (isWorking(l.status, l.http_status)) workingUrls.set(norm(l.final_url ?? l.url), l.final_url ?? l.url);
    }
    const requirementsChild = (courseUrl: string): string => {
      const self = norm(courseUrl);
      for (const cand of candidateEligibilityUrls(courseUrl)) {
        const hit = workingUrls.get(norm(cand));
        if (hit && norm(hit) !== self) return hit;
      }
      return "";
    };

    // A page that IS a dedicated requirements page (don't list it as its own
    // course — it's the eligibility TARGET of a course).
    const REQ_PAGE_RE = /((admission|entry|course)[-_]?(requirements?|criteria))|\/eligibility(\/|\.|$)/i;
    const courseLinks = links.filter((l) => {
      const low = (l.final_url ?? l.url).toLowerCase();
      return COURSE_RE.test(low) && !COURSE_DENY.test(low) && !REQ_PAGE_RE.test(low);
    });

    const courses: CoverageCourse[] = courseLinks.map((c) => {
      const url = c.final_url ?? c.url;
      const low = url.toLowerCase();
      let status: CourseStatus;
      let eligibilityUrl = "";
      let eligibilityType = "";
      let confidence = 0.3;
      let evidence = c.page_title ?? "";

      const child = requirementsChild(url);
      if (isDead(c.status, c.http_status)) {
        status = "NOT_FOUND";
        evidence = `course page dead (HTTP ${c.http_status ?? "unreachable"})`;
      } else if (child) {
        // The course's OWN dedicated admission/entry-requirements page — the most
        // accurate course-level eligibility URL.
        status = "FOUND"; eligibilityUrl = child; eligibilityType = "requirements_page"; confidence = 0.97;
        evidence = "dedicated admission/entry-requirements page for this course";
      } else if (["VALID_COURSE_PAGE", "POSSIBLE_REQUIREMENT_PAGE"].includes(c.status) || INSIDE_RE.test(low)) {
        status = "FOUND"; eligibilityUrl = url; eligibilityType = "inside_course_page"; confidence = 0.9;
        evidence = c.page_title || "entry-requirements on the course page";
      } else if (sharedUrl) {
        status = "SHARED"; eligibilityUrl = sharedUrl; eligibilityType = "shared_admissions_page"; confidence = 0.7;
        evidence = "mapped to the university's admissions / international page";
      } else {
        status = "NEEDS_REVIEW"; confidence = 0.3;
      }

      const ov = overrides[c.id];
      const overridden = Boolean(ov);
      if (ov) {
        status = ov.status;
        if (ov.eligibilityUrl) {
          eligibilityUrl = ov.eligibilityUrl;
          eligibilityType = ov.eligibilityUrl === url ? "inside_course_page" : "shared_admissions_page";
        } else if (ov.status === "FOUND" && !eligibilityUrl) { eligibilityUrl = url; eligibilityType = "inside_course_page"; }
        else if (ov.status === "SHARED" && !eligibilityUrl && sharedUrl) { eligibilityUrl = sharedUrl; eligibilityType = "shared_admissions_page"; }
        if (ov.by === "ai") { eligibilityType = (eligibilityType || "ai_mapped") + " · AI"; confidence = 0.85; }
        else confidence = 1;
      }

      return {
        linkId: c.id, courseName: courseName(url, c.page_title), courseUrl: url,
        eligibilityUrl, eligibilityType, status, confidence, evidenceText: evidence,
        suggested: status === "NEEDS_REVIEW" ? Array.from(new Set([candidateEligibilityUrls(url)[0] ?? url, url, ...suggestedUni])).slice(0, 4) : [],
        overridden,
      };
    });

    const by = (s: CourseStatus) => courses.filter((c) => c.status === s).length;
    out.push({
      id: u.id, name: u.name, country: u.country,
      total: courses.length, found: by("FOUND"), shared: by("SHARED"), needsReview: by("NEEDS_REVIEW"), notFound: by("NOT_FOUND"),
      status: courses.length === 0 ? "NO_DATA" : by("NEEDS_REVIEW") === 0 ? "COMPLETE" : "INCOMPLETE",
      courses,
    });
  }
  return out;
}

/** Summary only (no per-course rows) — for the coverage report cards. */
export async function coverageSummary() {
  const cov = await computeCoverage();
  const universities = cov.map((u) => ({
    id: u.id, name: u.name, country: u.country,
    total: u.total, found: u.found, shared: u.shared, needsReview: u.needsReview, notFound: u.notFound, status: u.status,
  }));
  const totals = universities.reduce(
    (a, u) => ({ total: a.total + u.total, found: a.found + u.found, shared: a.shared + u.shared, needsReview: a.needsReview + u.needsReview, notFound: a.notFound + u.notFound }),
    { total: 0, found: 0, shared: 0, needsReview: 0, notFound: 0 },
  );
  return { universities, totals };
}

/** All NEEDS_REVIEW courses across universities — the review queue. */
export async function reviewQueue() {
  const cov = await computeCoverage();
  const items: (CoverageCourse & { university: string })[] = [];
  for (const u of cov) for (const c of u.courses) if (c.status === "NEEDS_REVIEW") items.push({ university: u.name, ...c });
  return { total: items.length, items: items.slice(0, 500) };
}

export function setCourseStatus(linkId: string, status: CourseStatus) {
  const o = loadOverrides();
  o[linkId] = { status, by: "manual" };
  saveOverrides(o);
  return { linkId, status };
}

/** Rule-based auto-resolve of NEEDS_REVIEW → SHARED where a shared page exists. */
export async function autoResolve() {
  const cov = await computeCoverage();
  const o = loadOverrides();
  let resolved = 0;
  for (const u of cov) {
    const shared = u.courses.find((c) => c.eligibilityType.startsWith("shared"))?.eligibilityUrl;
    for (const c of u.courses) {
      if (c.status === "NEEDS_REVIEW" && shared) { o[c.linkId] = { status: "SHARED", eligibilityUrl: shared, by: "manual" }; resolved += 1; }
    }
  }
  saveOverrides(o);
  return { resolved };
}

// ---- Stage 3: AI auto-review ------------------------------------------------
interface AiProgress { running: boolean; done: number; total: number; mapped: number; provider: string; error?: string }
let aiState: AiProgress = { running: false, done: 0, total: 0, mapped: 0, provider: "none" };
export const getAiProgress = (): AiProgress => aiState;

/** Ask the configured model to pick the best eligibility URL for a course. */
async function aiPick(course: { courseName: string; courseUrl: string }, candidates: string[]): Promise<{ url: string; confidence: number } | null> {
  const provider = (process.env.AI_PROVIDER ?? "none").toLowerCase();
  const prompt =
    `You map a university course to its INTERNATIONAL-student entry-requirements / eligibility page.\n` +
    `Course name: "${course.courseName}"\nCourse URL: ${course.courseUrl}\n` +
    `Candidate eligibility URLs:\n${candidates.map((u, i) => `${i + 1}. ${u}`).join("\n")}\n` +
    `Pick the ONE URL most likely to be the entry-requirements/eligibility page for international applicants ` +
    `(the course page itself counts if it holds the requirements). ` +
    `Reply ONLY as JSON: {"url":"<best url, or empty if none fit>","confidence":<0..1>}.`;
  try {
    let content = "";
    if (provider === "ollama") {
      const res = await fetch(`${process.env.OLLAMA_BASE_URL ?? "http://localhost:11434"}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: process.env.OLLAMA_EXTRACTION_MODEL ?? "llama3.1:latest", stream: false, format: "json", options: { temperature: 0 }, messages: [{ role: "user", content: prompt }] }),
      });
      content = ((await res.json()) as { message?: { content?: string } }).message?.content ?? "";
    } else if (provider === "openai") {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ""}` },
        body: JSON.stringify({ model: "gpt-4o-mini", temperature: 0, response_format: { type: "json_object" }, messages: [{ role: "user", content: prompt }] }),
      });
      content = ((await res.json()) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? "";
    } else {
      return null;
    }
    const parsed = JSON.parse(content) as { url?: string; confidence?: number };
    if (parsed.url && candidates.includes(parsed.url)) return { url: parsed.url, confidence: Number(parsed.confidence) || 0.7 };
    return null;
  } catch {
    return null;
  }
}

/** Run AI over every NEEDS_REVIEW course, mapping each to a confirmed eligibility URL. */
export async function aiAutoReview(): Promise<{ started: boolean; total: number; provider: string }> {
  const provider = (process.env.AI_PROVIDER ?? "none").toLowerCase();
  if (aiState.running) return { started: false, total: aiState.total, provider };
  if (provider === "none") { aiState = { running: false, done: 0, total: 0, mapped: 0, provider, error: "No AI provider configured. Set AI_PROVIDER (ollama / openai) in Settings." }; return { started: false, total: 0, provider }; }

  const queue = (await reviewQueue()).items;
  aiState = { running: true, done: 0, total: queue.length, mapped: 0, provider };

  void (async () => {
    const o = loadOverrides();
    for (const item of queue) {
      const pick = await aiPick({ courseName: item.courseName, courseUrl: item.courseUrl }, item.suggested);
      if (pick && pick.confidence >= 0.55) {
        const status: CourseStatus = pick.url === item.courseUrl ? "FOUND" : "SHARED";
        o[item.linkId] = { status, eligibilityUrl: pick.url, by: "ai" };
        aiState.mapped += 1;
        saveOverrides(o); // persist incrementally so progress is visible/live
      }
      aiState.done += 1;
    }
    aiState = { ...aiState, running: false };
  })();

  return { started: true, total: queue.length, provider };
}

// ---- Stage 4b: URL-pattern prediction --------------------------------------
interface PredictProgress { running: boolean; done: number; total: number; mapped: number }
let predictState: PredictProgress = { running: false, done: 0, total: 0, mapped: 0 };
export const getPredictProgress = (): PredictProgress => predictState;

// Eligibility/requirements path segments universities use. "admission-requirements"
// is the common one for program pages (e.g. Seneca: /programs/fulltime/AIG/admission-requirements.html).
const ELIG_SEGMENTS = [
  "admission-requirements", "admissions-requirements", "entry-requirements", "entry-requirement",
  "admission-requirement", "requirements", "admission", "admissions", "eligibility",
  "entry", "how-to-apply", "international/entry-requirements", "international",
];

/**
 * Candidate eligibility URLs derived from a course/program URL. Handles pages
 * that end in .html/.php/.aspx by using the page STEM as a folder, so
 * "/programs/fulltime/AIG.html" → "/programs/fulltime/AIG/admission-requirements.html"
 * (the real Seneca pattern), and also tries the plain-folder forms.
 */
export function candidateEligibilityUrls(courseUrl: string): string[] {
  const clean = courseUrl.replace(/[?#].*$/, "");
  const stem = clean.replace(/\.(html?|php|aspx?)$/i, "").replace(/\/+$/, "");
  const ext = clean.match(/\.(html?|php|aspx?)$/i)?.[0] ?? "";
  const out = new Set<string>();
  for (const seg of ELIG_SEGMENTS) {
    if (ext) out.add(`${stem}/${seg}${ext}`); // mirror the site's extension first (most likely)
    out.add(`${stem}/${seg}`);
    out.add(`${stem}/${seg}/`);
  }
  return [...out];
}

async function headOk(url: string): Promise<boolean> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 6000);
  try {
    const r = await fetch(url, { method: "GET", redirect: "follow", signal: c.signal, headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36" } });
    try { await r.body?.cancel(); } catch { /* ignore */ }
    // A real page (not a soft-404 redirect to home/search). We accept 2xx and
    // require the final URL still contains the eligibility segment.
    return r.status >= 200 && r.status < 300 && /(admission|requirement|eligib|entry|how-to-apply|international)/i.test(r.url);
  } catch { return false; } finally { clearTimeout(t); }
}

/** Predict eligibility URLs for review-queue courses by testing common patterns. */
export async function predictUrls(): Promise<{ started: boolean; total: number }> {
  if (predictState.running) return { started: false, total: predictState.total };
  const queue = (await reviewQueue()).items;
  predictState = { running: true, done: 0, total: queue.length, mapped: 0 };
  void (async () => {
    const o = loadOverrides();
    for (const item of queue) {
      for (const candidate of candidateEligibilityUrls(item.courseUrl)) {
        if (await headOk(candidate)) {
          o[item.linkId] = { status: "FOUND", eligibilityUrl: candidate, by: "manual" };
          predictState.mapped += 1;
          saveOverrides(o);
          break;
        }
      }
      predictState.done += 1;
    }
    predictState = { ...predictState, running: false };
  })();
  return { started: true, total: queue.length };
}

// ---- Stage 4c: free / open-source web-search fallback ----------------------
// For courses still in the review queue, search a FREE engine (DuckDuckGo by
// default — no API key; or a self-hosted SearXNG if SEARX_URL is set) for the
// course's entry-requirements page, restrict hits to the university's OWN
// domain, then CONTENT-VERIFY each candidate before accepting it. Fully free,
// no keys, all open-source friendly.
interface SearchProgress { running: boolean; done: number; total: number; mapped: number; engine: string; error?: string }
let searchState: SearchProgress = { running: false, done: 0, total: 0, mapped: 0, engine: "none" };
export const getSearchProgress = (): SearchProgress => searchState;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const SEARCH_ELIG = keywordsToRegex(getKeywords().eligibility);
const SEARCH_EVIDENCE = keywordsToRegex(getKeywords().evidence);

/** Registrable-ish base domain (last two labels) of a URL. */
function baseDomain(url: string): string {
  try { const h = new URL(url).hostname.replace(/^www\./, ""); const p = h.split("."); return p.slice(-2).join("."); }
  catch { return ""; }
}

/** One search query → result URLs, via SearXNG (if configured) else DuckDuckGo HTML. No API key. */
async function searchWeb(query: string): Promise<string[]> {
  const searx = (process.env.SEARX_URL ?? "").trim().replace(/\/+$/, "");
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 12000);
  try {
    if (searx) {
      const res = await fetch(`${searx}/search?q=${encodeURIComponent(query)}&format=json&safesearch=0`, { signal: c.signal, headers: { "user-agent": UA, accept: "application/json" } });
      if (!res.ok) return [];
      const data = (await res.json()) as { results?: { url?: string }[] };
      return Array.from(new Set((data.results ?? []).map((r) => r.url ?? "").filter(Boolean))).slice(0, 12);
    }
    // DuckDuckGo HTML endpoint — free, no key. Results are wrapped in /l/?uddg=<encoded real url>.
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { signal: c.signal, headers: { "user-agent": UA, accept: "text/html", "accept-language": "en-US,en;q=0.9" } });
    if (!res.ok) return [];
    const html = await res.text();
    const urls = new Set<string>();
    const re = /uddg=([^&"']+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) && urls.size < 12) {
      try { const u = decodeURIComponent(m[1]!); if (/^https?:\/\//i.test(u)) urls.add(u); } catch { /* skip */ }
    }
    return Array.from(urls);
  } catch { return []; }
  finally { clearTimeout(t); }
}

/** Fetch + strip a page and confirm it really is an eligibility page. */
async function verifyEligibilityPage(url: string): Promise<boolean> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 15000);
  try {
    const res = await fetch(url, { method: "GET", redirect: "follow", signal: c.signal, headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml", "accept-language": "en-US,en;q=0.9" } });
    if (res.status < 200 || res.status >= 300) { try { await res.body?.cancel(); } catch { /* ignore */ } return false; }
    const text = (await res.text()).replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    return SEARCH_EVIDENCE.test(text);
  } catch { return false; }
  finally { clearTimeout(t); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Search the web (free) for an eligibility page for every review-queue course. */
export async function searchFallback(): Promise<{ started: boolean; total: number; engine: string }> {
  const engine = (process.env.SEARX_URL ?? "").trim() ? "searxng" : "duckduckgo";
  if (searchState.running) return { started: false, total: searchState.total, engine };
  const queue = (await reviewQueue()).items;
  searchState = { running: true, done: 0, total: queue.length, mapped: 0, engine };

  void (async () => {
    const o = loadOverrides();
    for (const item of queue) {
      const dom = baseDomain(item.courseUrl);
      if (dom) {
        const query = `${item.courseName} entry requirements international students site:${dom}`;
        const results = (await searchWeb(query)).filter((u) => baseDomain(u) === dom && SEARCH_ELIG.test(u.toLowerCase()));
        for (const candidate of results) {
          if (await verifyEligibilityPage(candidate)) {
            const status: CourseStatus = candidate.replace(/\/+$/, "") === item.courseUrl.replace(/\/+$/, "") ? "FOUND" : "SHARED";
            o[item.linkId] = { status, eligibilityUrl: candidate, by: "ai" };
            searchState.mapped += 1;
            saveOverrides(o); // persist incrementally so progress is live
            break;
          }
        }
        await sleep(1200); // be polite to the search engine
      }
      searchState.done += 1;
    }
    searchState = { ...searchState, running: false };
  })();

  return { started: true, total: queue.length, engine };
}

// ---- Stage 4d: resolve the EXACT eligibility URL (keyword-containing) -------
// Many course pages put entry requirements on a same-page tab (#entry-requirements,
// e.g. Solent) or a dedicated child page (/…/admission-requirements.html, e.g.
// Seneca). The crawl stores the bare course URL (fragments are stripped); this
// step inspects each page and upgrades it to the precise URL that CONTAINS the
// eligibility keyword — so the deliverable points exactly at the requirements.
interface ResolveProgress { running: boolean; done: number; total: number; upgraded: number }
let resolveState: ResolveProgress = { running: false, done: 0, total: 0, upgraded: 0 };
export const getResolveProgress = (): ResolveProgress => resolveState;

const RES_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const REQ_KW = /(admission|entry)[-_\s]?(requirements?|criteria)/i;
// A URL that already points precisely at the requirements (keyword in path or fragment).
const URL_HAS_KEYWORD = /(admission|entry)[-_]?(requirements?|criteria)|\/eligibility|#(entry|admission|eligib)/i;
const RES_EVIDENCE = keywordsToRegex(getKeywords().evidence);
const resSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchHtml(url: string): Promise<string> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 15000);
  try {
    const r = await fetch(url, { redirect: "follow", signal: c.signal, headers: { "user-agent": RES_UA, accept: "text/html,application/xhtml+xml" } });
    if (r.status < 200 || r.status >= 300) { try { await r.body?.cancel(); } catch { /* ignore */ } return ""; }
    return await r.text();
  } catch { return ""; } finally { clearTimeout(t); }
}

/** A requirements page the COURSE itself links to, under the course's own path (e.g. Seneca's /AIG/admission-requirements.html). */
function findCourseRequirementsLink(html: string, baseUrl: string): string {
  const stem = baseUrl.replace(/\.(html?|php|aspx?)$/i, "").replace(/\/+$/, "");
  let stemPath = "";
  let host = "";
  try { const b = new URL(stem); stemPath = b.pathname.replace(/\/$/, ""); host = b.host; } catch { return ""; }
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const href = m[1]!;
    const text = m[2]!.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (href.startsWith("#")) continue;
    if (!REQ_KW.test(href.replace(/#.*$/, "")) && !REQ_KW.test(text)) continue;
    try {
      const a = new URL(href, baseUrl);
      if (a.host !== host) continue;
      const aPath = a.pathname.replace(/\/$/, "");
      if (aPath === stemPath || !aPath.startsWith(stemPath)) continue; // must be the course's OWN requirements page
      return a.toString().replace(/#.*$/, "");
    } catch { continue; }
  }
  return "";
}

/** A same-page entry/admission-requirements anchor id → use it as a #fragment (e.g. Solent's #entry-requirements). */
function pickRequirementsFragment(html: string): string {
  const ids = [...html.matchAll(/(?:id|name)\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]!);
  const elig = ids.filter((id) => /(entry|admission)[-_]?(requirements?|criteria)|^eligibility$/i.test(id));
  if (!elig.length) return "";
  const rank = (id: string) => {
    let s = 0;
    if (/^(tab|panel|accordion|section|collapse|heading)[-_]/i.test(id)) s -= 5; // prefer the clean anchor over its tab/panel wrapper
    if (/requirement/i.test(id)) s += 3;
    if (/^(entry|admission)-requirements?$/i.test(id)) s += 5;
    return s - id.length * 0.01;
  };
  return elig.sort((a, b) => rank(b) - rank(a))[0]!;
}

async function statusOk(url: string): Promise<boolean> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 8000);
  try {
    const r = await fetch(url, { redirect: "follow", signal: c.signal, headers: { "user-agent": RES_UA } });
    try { await r.body?.cancel(); } catch { /* ignore */ }
    return r.status >= 200 && r.status < 300;
  } catch { return false; } finally { clearTimeout(t); }
}

/** Best precise eligibility URL for a course: course-own child page → #fragment → page itself. */
export async function resolveBestEligibilityUrl(courseUrl: string): Promise<string> {
  const clean = courseUrl.replace(/#.*$/, "");
  const html = await fetchHtml(clean);
  if (!html) return "";
  const link = findCourseRequirementsLink(html, clean);
  if (link && (await statusOk(link))) return link;
  const frag = pickRequirementsFragment(html);
  if (frag) return `${clean}#${frag}`;
  if (RES_EVIDENCE.test(html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " "))) return clean;
  return "";
}

/** Upgrade every course whose eligibility URL isn't yet keyword-precise to the exact URL. */
export async function resolveExactUrls(): Promise<{ started: boolean; total: number }> {
  if (resolveState.running) return { started: false, total: resolveState.total };
  const cov = await computeCoverage();
  const targets: { linkId: string; courseUrl: string }[] = [];
  for (const u of cov) for (const c of u.courses) {
    if (c.status === "NOT_FOUND") continue;
    if (URL_HAS_KEYWORD.test(c.eligibilityUrl)) continue; // already precise
    targets.push({ linkId: c.linkId, courseUrl: c.courseUrl });
  }
  resolveState = { running: true, done: 0, total: targets.length, upgraded: 0 };
  void (async () => {
    const o = loadOverrides();
    for (const t of targets) {
      try {
        const best = await resolveBestEligibilityUrl(t.courseUrl);
        if (best && URL_HAS_KEYWORD.test(best)) {
          o[t.linkId] = { status: "FOUND", eligibilityUrl: best, by: "manual" };
          resolveState.upgraded += 1;
          saveOverrides(o);
        }
      } catch { /* skip */ }
      resolveState.done += 1;
      await resSleep(250);
    }
    resolveState = { ...resolveState, running: false };
  })();
  return { started: true, total: targets.length };
}

/** Course-based export (the honest deliverable): one row per official course. */
export async function exportCoverage() {
  const cov = await computeCoverage();
  const header = ["university_name", "course_name", "course_url", "eligibility_url", "eligibility_type", "status", "confidence", "evidence_text", "last_checked"];
  const now = new Date().toISOString();
  const cell = (v: string | number) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [header.map(cell).join(",")];
  let n = 0;
  for (const u of cov) for (const c of u.courses) {
    lines.push([u.name, c.courseName, c.courseUrl, c.eligibilityUrl, c.eligibilityType, c.status, c.confidence, c.evidenceText, now].map(cell).join(","));
    n += 1;
  }
  const dir = resolve(repoRoot(), "storage", "exports");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "coverage-FINAL.csv"), lines.join("\r\n"), "utf8");
  return { file: "coverage-FINAL.csv", courses: n };
}
