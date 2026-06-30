/**
 * Re-validate + CONTENT-VERIFY the exported eligibility URLs.
 * For every URL we (1) drop non-page noise (PDF/xlsx/assets), (2) check it is
 * reachable, and (3) OPEN it and confirm the page actually contains eligibility /
 * entry-requirements content (not just a keyword in the URL). Outputs:
 *   *-VERIFIED.csv  → reachable AND has eligibility evidence (the real deliverable)
 *   *-REVIEW.csv    → reachable but no evidence, bot-blocked, or broken (with reason)
 *
 * Run: tsx src/verify-eligibility.ts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { repoRoot, getKeywords, keywordsToRegex } from "@clg/shared";

const DIR = join(repoRoot(), "storage", "exports");

const NOISE = /\.(pdf|xlsx?|docx?|pptx?|zip|jpe?g|png)(\?|$)|\/assets\/|\/file\/|\/files\/|\/media\/|\/_next\/|aphouse|\/housing|\/news\/|\/events?\/|enrollment|advisory|\/staff|\/people\//i;
// Evidence vocabulary from the central, editable keyword set.
const EVIDENCE = keywordsToRegex(getKeywords().evidence);

const HEADERS: Record<string, string> = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
};

interface Row { university: string; country: string; level: string; courseName: string; url: string; http: number | null; verdict: string; evidence: string }

async function getContent(url: string, timeout = 20000): Promise<{ status: number | null; text: string }> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeout);
  try {
    const res = await fetch(url, { method: "GET", redirect: "follow", signal: c.signal, headers: HEADERS });
    let text = "";
    if (res.status >= 200 && res.status < 300) {
      const html = await res.text();
      text = html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ");
    } else {
      try { await res.body?.cancel(); } catch { /* ignore */ }
    }
    return { status: res.status, text };
  } catch {
    return { status: null, text: "" };
  } finally {
    clearTimeout(t);
  }
}

async function pool<T>(items: T[], limit: number, fn: (t: T, i: number) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const cur = i++; await fn(items[cur]!, cur); }
  }));
}

async function readRows(file: string): Promise<Row[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(join(DIR, file));
  const ws = wb.getWorksheet("Valid URLs") ?? wb.worksheets[0];
  const rows: Row[] = [];
  ws?.eachRow((row, n) => {
    if (n === 1) return; // header
    const v = (i: number) => String(row.getCell(i).text ?? "").trim();
    const url = v(5);
    if (!url || !/^https?:\/\//i.test(url)) return;
    rows.push({ university: v(1), country: v(2), level: v(3), courseName: v(4), url, http: null, verdict: "", evidence: "" });
  });
  return rows;
}

function snippet(text: string): string {
  const m = text.match(EVIDENCE);
  if (!m || m.index === undefined) return "";
  return text.slice(Math.max(0, m.index - 50), m.index + 90).trim();
}

async function verifyFile(file: string, baseOut: string) {
  let rows: Row[];
  try { rows = await readRows(file); } catch { console.log(`[verify] skip ${file} (not found)`); return; }
  console.log(`[verify] ${file}: ${rows.length} URLs — re-validating + content-checking…`);
  let done = 0;
  await pool(rows, 12, async (r) => {
    if (NOISE.test(r.url.toLowerCase())) { r.verdict = "NOISE"; }
    else {
      const { status, text } = await getContent(r.url);
      r.http = status;
      if (status !== null && status >= 200 && status < 300) {
        if (EVIDENCE.test(text)) { r.verdict = "CONFIRMED"; r.evidence = snippet(text); }
        else r.verdict = "REACHABLE_NO_EVIDENCE";
      } else if (status === 403 || status === 429) r.verdict = "BOT_BLOCKED";
      else r.verdict = "BROKEN";
    }
    if (++done % 200 === 0) console.log(`[verify]   ${done}/${rows.length}`);
  });

  const confirmed = rows.filter((r) => r.verdict === "CONFIRMED");
  const review = rows.filter((r) => r.verdict !== "CONFIRMED");
  const cell = (v: string | number | null) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const head = ["university", "country", "level", "course_name", "eligibility_url", "http_status", "verdict", "evidence"];
  const toCsv = (rs: Row[]) => [head.map(cell).join(",")].concat(rs.map((r) => [r.university, r.country, r.level, r.courseName, r.url, r.http, r.verdict, r.evidence].map(cell).join(","))).join("\r\n");
  writeFileSync(join(DIR, `${baseOut}-VERIFIED.csv`), toCsv(confirmed), "utf8");
  writeFileSync(join(DIR, `${baseOut}-REVIEW.csv`), toCsv(review), "utf8");

  const by = (v: string) => rows.filter((r) => r.verdict === v).length;
  console.log(`[verify] ${file} → CONFIRMED=${confirmed.length}  no-evidence=${by("REACHABLE_NO_EVIDENCE")}  bot=${by("BOT_BLOCKED")}  broken=${by("BROKEN")}  noise=${by("NOISE")}`);
  console.log(`[verify]   wrote ${baseOut}-VERIFIED.csv (+ -REVIEW.csv)`);
}

async function main() {
  await verifyFile("eligibility-COURSES-INTERNATIONAL-FINAL.xlsx", "eligibility-COURSES-INTERNATIONAL");
  await verifyFile("eligibility-UNIVERSITY-INTERNATIONAL-FINAL.xlsx", "eligibility-UNIVERSITY-INTERNATIONAL");
  console.log("[verify] done.");
  process.exit(0);
}
main().catch((e) => { console.error("VERIFY_ERROR", e); process.exit(1); });
