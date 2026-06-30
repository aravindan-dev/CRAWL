import { linkRepository, LinkStatus } from "@clg/database";

/**
 * Live link validation for the Discovered Links page. Checks each URL over the
 * network (browser headers, follows redirects) and records a clear verdict so the
 * user can see which URLs are SURE (working), DOUBTFUL, or BOT-BLOCKED.
 */
const HEADERS: Record<string, string> = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
};

// Phrases that mean "this page doesn't really exist" even on a 200 response.
const NOT_FOUND_TEXT =
  /(page not found|404 error|error 404|page (you|you're|you are) looking for (can ?not|cannot|could not) be found|no longer available|does not exist|page unavailable|page has moved|sorry,?\s+(this|the) page|content not found|we can'?t find)/i;

interface Probe { status: number | null; finalUrl: string; softNotFound: boolean }

/**
 * GET-probe a URL: follows redirects, then detects SOFT-404s — a 200 response
 * that actually means "missing": either it redirected a deep page back to the
 * homepage/a much shallower page, or the body says "page not found". This is the
 * #1 accuracy gap for link validation (research: soft-404s look 'OK' but aren't).
 */
async function probe(url: string, timeout = 18000): Promise<Probe> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeout);
  try {
    const res = await fetch(url, { method: "GET", redirect: "follow", signal: c.signal, headers: HEADERS });
    const finalUrl = res.url || url;
    let softNotFound = false;
    if (res.status >= 200 && res.status < 300) {
      // (a) redirected a deep page to the homepage / a much shallower path
      try {
        const o = new URL(url);
        const f = new URL(finalUrl);
        const oDepth = o.pathname.split("/").filter(Boolean).length;
        const fDepth = f.pathname.split("/").filter(Boolean).length;
        if ((oDepth >= 2 && fDepth === 0) || (oDepth >= 3 && fDepth <= 1 && o.pathname !== f.pathname)) softNotFound = true;
      } catch { /* ignore */ }
      // (b) the body explicitly says "not found"
      if (!softNotFound) {
        const html = (await res.text()).slice(0, 60000);
        const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ");
        const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").toLowerCase();
        if (NOT_FOUND_TEXT.test(title) || NOT_FOUND_TEXT.test(text.slice(0, 4000))) softNotFound = true;
      } else {
        try { await res.body?.cancel(); } catch { /* ignore */ }
      }
    } else {
      try { await res.body?.cancel(); } catch { /* ignore */ }
    }
    return { status: res.status, finalUrl, softNotFound };
  } catch {
    return { status: null, finalUrl: url, softNotFound: false };
  } finally {
    clearTimeout(t);
  }
}

/** Map a probe result to a stored link status (only definitive cases). */
function linkStatusFor(p: Probe): LinkStatus | undefined {
  if (p.status === null) return undefined;
  if (p.status === 403 || p.status === 429) return LinkStatus.BLOCKED;
  if (p.status === 404 || p.status === 410) return LinkStatus.BROKEN_LINK;
  if (p.softNotFound) return LinkStatus.BROKEN_LINK; // soft-404 → treat as broken
  return undefined;
}

export async function revalidateLink(id: string) {
  const link = await linkRepository.findById(id);
  if (!link) return null;
  const url = link.final_url ?? link.url;
  const p = await probe(url);
  const stored = linkStatusFor(p);
  await linkRepository.update(id, {
    http_status: p.status,
    final_url: p.finalUrl,
    ...(stored ? { status: stored } : {}),
  });
  return { id, http_status: p.status, final_url: p.finalUrl, softNotFound: p.softNotFound };
}

// ---- Batch re-validation (the "Re-validate all" button) --------------------
interface BatchProgress { running: boolean; done: number; total: number; startedAt: string | null }
let batch: BatchProgress = { running: false, done: 0, total: 0, startedAt: null };

export function getRevalidateProgress(): BatchProgress {
  return batch;
}

/** Re-validate the eligibility-relevant links (course/admission/requirement/low-conf). */
export async function revalidateAll(): Promise<{ started: boolean; total: number }> {
  if (batch.running) return { started: false, total: batch.total };
  const links = await linkRepository.list({
    take: 5000,
    status: undefined,
  });
  // Only the links worth validating (skip PDFs / pure-navigation).
  const RELEVANT = new Set(["VALID_COURSE_PAGE", "VALID_ADMISSION_PAGE", "POSSIBLE_REQUIREMENT_PAGE", "LOW_CONFIDENCE_PAGE", "BLOCKED", "BROKEN_LINK", "QUEUED"]);
  const targets = links.items.filter((l) => RELEVANT.has(l.status));
  batch = { running: true, done: 0, total: targets.length, startedAt: new Date().toISOString() };

  // Run in the background with a small concurrency pool; update progress as we go.
  void (async () => {
    const CONC = 10;
    let i = 0;
    await Promise.all(
      Array.from({ length: Math.min(CONC, targets.length) }, async () => {
        while (i < targets.length) {
          const cur = targets[i++]!;
          try {
            await revalidateLink(cur.id);
          } catch { /* keep going */ }
          batch.done += 1;
        }
      }),
    );
    batch = { ...batch, running: false };
  })();

  return { started: true, total: targets.length };
}
