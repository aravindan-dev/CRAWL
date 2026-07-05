/**
 * HTTP FAST LANE (redesign Step 3 — "make Playwright a fallback").
 *
 * The optimal-time algorithm for the crawl is two lanes over one frontier:
 *
 *   Lane F (default, this module): plain HTTP fetch + cheerio parse.
 *     ~0.2–0.5s per page, no browser, high parallelism. Serves discovery
 *     pages, rejected pages, and target CANDIDATE detection.
 *
 *   Lane B (fallback, the existing PlaywrightCrawler): full browser.
 *     Reserved for pages that genuinely need it — JS shells, bot challenges,
 *     dynamic finders needing expansion, and VALIDATED targets (which need
 *     the proof screenshot + parse-grade snapshot).
 *
 * Complexity: was  O(N)·T_browser        (T_browser ≈ 3–8s/page)
 *             now  O(N)·T_http ∥ high-concurrency  +  O(V)·T_browser
 * where V (validated + dynamic pages) is typically 10–15% of N. Every page
 * still passes the SAME classify → authorize → validate pipeline; only the
 * transport is cheaper. Nothing is skipped — pages the fast lane cannot serve
 * faithfully are escalated, never dropped.
 */
import * as cheerio from "cheerio";
import type { ContentBlock, ExtractedPage } from "@clg/shared";
import { resolveUrl } from "@clg/shared";
import { looksLikeBotChallenge } from "../validation/validatePage.js";

/** Same junk-title fallback the browser extractor uses (extractPage.ts). */
const JUNK_TITLE = /^(error|loading|untitled|redirecting|please wait|just a moment|forbidden|access denied|page not found|not found|\d{3})$/i;

export interface HttpFetchResult {
  ok: boolean;
  status: number | null;
  finalUrl: string;
  body: string;
}

/** Plain-HTTP fetch with a real-browser UA. Follows redirects (the final URL is
 *  re-authorized by the caller — post-redirect guard). Never throws. */
export async function httpFetchPage(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<HttpFetchResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { headers, redirect: "follow", signal: ctrl.signal });
    const body = await resp.text();
    return { ok: true, status: resp.status, finalUrl: resp.url || url, body };
  } catch {
    return { ok: false, status: null, finalUrl: url, body: "" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build an ExtractedPage from server-rendered HTML — the fast-lane counterpart
 * of extractPage(). Faithful where it matters for gating and validation:
 * title (with junk fallback), block-aware visible text, internal links, raw
 * html. Tables/blocks are captured leanly; validated targets are re-extracted
 * in the browser lane anyway (their artifacts must be parse-grade).
 */
export function extractFromHtml(html: string, requestedUrl: string, finalUrl: string): ExtractedPage {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, iframe").remove();

  const docTitle = ($("title").first().text() ?? "").replace(/\s+/g, " ").trim();
  const h1Text = ($("h1").first().text() ?? "").replace(/\s+/g, " ").trim();
  const page_title = docTitle && !JUNK_TITLE.test(docTitle) ? docTitle : h1Text || docTitle;

  const blocks: ContentBlock[] = [];
  const clean = (s: string) => s.replace(/\s+/g, " ").trim();
  $("h1, h2, h3").each((_, el) => {
    const text = clean($(el).text());
    if (text) blocks.push({ type: "heading", level: Number(el.tagName[1]) as 1 | 2 | 3, text });
  });
  $("p").each((_, el) => {
    const text = clean($(el).text());
    if (text) blocks.push({ type: "paragraph", text });
  });
  $("ul, ol").each((_, el) => {
    const items = $(el)
      .children("li")
      .map((_i, li) => clean($(li).text()))
      .get()
      .filter(Boolean);
    if (items.length) blocks.push({ type: "list", items });
  });

  // Block-aware text: join block-level elements with newlines so keyword/
  // evidence matching behaves like the browser's innerText, not one long line.
  const root = $("main").length ? $("main") : $("body");
  const textParts: string[] = [];
  root.find("h1, h2, h3, h4, h5, h6, p, li, td, th, dt, dd, figcaption, blockquote").each((_, el) => {
    const t = clean($(el).clone().children("ul, ol, table").remove().end().text());
    if (t) textParts.push(t);
  });
  const visible_text = textParts.join("\n");

  const internal_links = $("a[href]")
    .map((_, a) => {
      const href = $(a).attr("href") ?? "";
      const text = clean($(a).text());
      const url = resolveUrl(href, finalUrl);
      return url ? { url, text } : null;
    })
    .get()
    .filter((l): l is { url: string; text: string } => l !== null);

  const headings = blocks
    .filter((b): b is Extract<ContentBlock, { type: "heading" }> => b.type === "heading")
    .map((b) => ({ tag: `h${b.level}` as "h1" | "h2" | "h3", text: b.text }));

  return {
    requested_url: requestedUrl,
    final_url: finalUrl,
    page_title,
    lang: $("html").attr("lang") ?? null,
    visible_text,
    headings,
    paragraphs: blocks.filter((b): b is Extract<ContentBlock, { type: "paragraph" }> => b.type === "paragraph").map((b) => b.text),
    lists: blocks.filter((b): b is Extract<ContentBlock, { type: "list" }> => b.type === "list").map((b) => b.items),
    tables: [],
    internal_links,
    content_blocks: blocks,
    raw_html: html,
  };
}

export type FastAssessment =
  | { serveFast: true }
  | { serveFast: false; reason: "network" | "bot-challenge" | "blocked-status" | "thin-content" };

/**
 * Can the fast lane serve this fetch faithfully, or must the browser take it?
 * Pure and deliberately conservative: anything ambiguous goes to the browser —
 * the fast lane exists to save time, never to change outcomes.
 */
export function assessFastFetch(res: HttpFetchResult, visibleTextLength: number, minTextLength = 400): FastAssessment {
  if (!res.ok) return { serveFast: false, reason: "network" };
  if (res.body && looksLikeBotChallenge(res.body.slice(0, 8000))) return { serveFast: false, reason: "bot-challenge" };
  const s = res.status ?? 0;
  if (s === 401 || s === 403 || s === 429 || s === 503) return { serveFast: false, reason: "blocked-status" };
  // Plain 404/410 etc. ARE servable fast (dead page — no browser needed).
  if (s >= 400) return { serveFast: true };
  // 2xx/3xx with too little text = JS shell → needs a real browser render.
  if (visibleTextLength < minTextLength) return { serveFast: false, reason: "thin-content" };
  return { serveFast: true };
}

/** Dynamic-finder markers in raw HTML (mirror of the browser-lane heuristic). */
export function looksLikeDynamicFinder(html: string): boolean {
  return (
    /name=["'][^"']*_length["']|dataTables_length|class=["'][^"']*(datatable|finder)[^"']*["']/i.test(html) ||
    /load more|show more|view all|see all|more courses|load all/i.test(html)
  );
}

// ---------------------------------------------------------------------------
// robots.txt for the fast lane. The browser lane gets robots enforcement from
// Crawlee (respectRobotsTxtFile); the fast lane must obey the same rules
// itself. Standard longest-match semantics for the `User-agent: *` group,
// with * and $ wildcards supported.
// ---------------------------------------------------------------------------
export interface RobotsRules {
  disallow: string[];
  allow: string[];
}

export function parseRobotsTxt(txt: string): RobotsRules {
  const rules: RobotsRules = { disallow: [], allow: [] };
  let applies = false; // inside a group whose User-agent set includes *
  let inAgentRun = false; // consecutive User-agent lines share one group
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const val = m[2]!.trim();
    if (key === "user-agent") {
      if (!inAgentRun) applies = false; // a new group starts — reset membership
      inAgentRun = true;
      if (val === "*") applies = true;
      continue;
    }
    inAgentRun = false;
    if (!applies) continue;
    if (key === "disallow" && val) rules.disallow.push(val);
    else if (key === "allow" && val) rules.allow.push(val);
  }
  return rules;
}

const ruleToRegex = (rule: string): RegExp => {
  const escaped = rule.replace(/[.+?^{}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped.endsWith("\\$") ? escaped.slice(0, -2) + "$" : escaped}`);
};

/** Longest-match wins; Allow beats Disallow on equal length; no match = allowed. */
export function robotsAllows(rules: RobotsRules, path: string): boolean {
  let bestLen = -1;
  let allowed = true;
  for (const d of rules.disallow) {
    if (ruleToRegex(d).test(path) && d.length > bestLen) {
      bestLen = d.length;
      allowed = false;
    }
  }
  for (const a of rules.allow) {
    if (ruleToRegex(a).test(path) && a.length >= bestLen) {
      bestLen = a.length;
      allowed = true;
    }
  }
  return allowed;
}
