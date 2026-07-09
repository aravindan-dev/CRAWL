import { parseString } from "fast-csv";
import ExcelJS from "exceljs";
import { universityCsvRowSchema, type UniversityInput } from "@clg/shared";
import { prisma, universityRepository } from "@clg/database";
import { discoverUniversityUrl, normalizeUrl } from "./urlDiscovery.js";
import { getLicenseStatus } from "../plugins/license.js";
import { HttpError } from "../lib/http.js";

/** Enforces the license's maxUniversities seat cap (null = unlimited). */
export async function assertUniversityCapNotExceeded(additional: number): Promise<void> {
  const status = getLicenseStatus();
  const cap = status.state === "valid" || status.state === "grace" ? status.payload.maxUniversities : null;
  if (cap == null || additional <= 0) return;
  const current = await prisma.university.count();
  if (current + additional > cap) {
    throw new HttpError(403, `Your license covers up to ${cap} universities. Contact your vendor to upgrade.`);
  }
}

export interface CsvParseResult {
  valid: UniversityInput[];
  errors: { row: number; message: string }[];
}
export interface ImportResult {
  inserted: number;
  parsed: number;
  discovering: number; // universities whose website is being auto-found in the background
  errors: { row: number; message: string }[];
}

type Role = "" | "university_name" | "country" | "base_url" | "notes";

/**
 * Map ANY header cell to a canonical role. Tolerant of real-world spreadsheets:
 * "College Name", "Institution", "University Name", "Web Site", "Home Page",
 * "Remarks", etc. Unknown columns (serial no., dates) are ignored.
 */
function roleOf(header: string): Role {
  const k = (header ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!k) return "";
  if (k.includes("country") || k === "nation") return "country";
  if (
    k.includes("url") || k.includes("website") || k.includes("weblink") || k.includes("webaddress") ||
    k.includes("homepage") || k.includes("domain") || k === "web" || k === "site" || k === "link" || k === "siteurl"
  )
    return "base_url";
  if (k.includes("note") || k.includes("remark") || k.includes("comment")) return "notes";
  if (k.includes("name") || k.includes("university") || k.includes("college") || k.includes("institution") || k.includes("school") || k === "uni")
    return "university_name";
  return "";
}

/** When no name header is recognised, pick the most "name-like" text column. */
function guessNameColumn(data: string[][], exclude: number[]): number {
  const ex = new Set(exclude.filter((i) => i >= 0));
  const cols = Math.max(0, ...data.slice(0, 30).map((r) => r.length));
  let best = -1;
  let bestScore = 0;
  for (let c = 0; c < cols; c++) {
    if (ex.has(c)) continue;
    let total = 0;
    let n = 0;
    let alpha = 0;
    for (const row of data.slice(0, 30)) {
      const v = (row[c] ?? "").trim();
      if (!v) continue;
      n += 1;
      total += v.length;
      if (/[a-z]{3,}/i.test(v) && !/^\d+([/.\-]\d+)*$/.test(v)) alpha += 1; // not a number/date
    }
    if (n === 0) continue;
    const score = (total / n) * (alpha / n); // long, mostly-alphabetic column wins
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best;
}

/** Turn a raw cell matrix (header + rows) into validated university rows. */
function buildRowsFromMatrix(matrix: string[][]): CsvParseResult {
  const valid: UniversityInput[] = [];
  const errors: { row: number; message: string }[] = [];
  if (matrix.length === 0) return { valid, errors };

  const header = matrix[0]!;
  let nameI = -1;
  let countryI = -1;
  let urlI = -1;
  let notesI = -1;
  header.forEach((h, i) => {
    const r = roleOf(h);
    if (r === "country" && countryI < 0) countryI = i;
    else if (r === "base_url" && urlI < 0) urlI = i;
    else if (r === "notes" && notesI < 0) notesI = i;
    else if (r === "university_name" && nameI < 0) nameI = i;
  });

  // If nothing was recognised, the file may have no header row → treat row 0 as data.
  const anyRole = nameI >= 0 || countryI >= 0 || urlI >= 0;
  const dataStart = anyRole ? 1 : 0;
  const data = matrix.slice(dataStart);

  if (nameI < 0) nameI = guessNameColumn(data, [countryI, urlI, notesI]);
  if (nameI < 0) {
    errors.push({ row: 0, message: "Couldn't find a university-name column. Add a column like 'Name' / 'University' / 'College Name'." });
    return { valid, errors };
  }

  data.forEach((cells, idx) => {
    const rowNum = idx + dataStart + 1;
    const name = (cells[nameI] ?? "").trim();
    if (!name) return; // skip blank lines silently
    const row = {
      university_name: name,
      country: countryI >= 0 ? (cells[countryI] ?? "").trim() : "",
      base_url: urlI >= 0 ? (cells[urlI] ?? "").trim() : "",
      notes: notesI >= 0 ? (cells[notesI] ?? "").trim() : "",
    };
    const parsed = universityCsvRowSchema.safeParse(row);
    if (parsed.success) {
      valid.push({
        name: parsed.data.university_name,
        country: parsed.data.country,
        base_url: normalizeUrl(parsed.data.base_url),
        notes: parsed.data.notes || null,
      });
    } else {
      errors.push({ row: rowNum, message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    }
  });
  return { valid, errors };
}

/** Parse CSV text into a plain cell matrix (no header coupling). */
function parseCsvToRows(csv: string): Promise<string[][]> {
  return new Promise((resolve, reject) => {
    const rows: string[][] = [];
    parseString(csv, { headers: false, ignoreEmpty: true, trim: true })
      .on("error", reject)
      .on("data", (r: unknown) => rows.push((Array.isArray(r) ? r : Object.values(r as object)).map((c) => String(c ?? ""))))
      .on("end", () => resolve(rows));
  });
}

function cellText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object" && v !== null && "text" in (v as Record<string, unknown>)) return String((v as { text: unknown }).text);
  if (typeof v === "object" && v !== null && "hyperlink" in (v as Record<string, unknown>)) return String((v as { hyperlink: unknown }).hyperlink);
  if (typeof v === "object" && v !== null && "result" in (v as Record<string, unknown>)) return String((v as { result: unknown }).result);
  return String(v);
}

/** Read the first worksheet of an .xlsx buffer into a cell matrix. */
async function xlsxBufferToRows(buf: Buffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const rows: string[][] = [];
  ws.eachRow((row) => {
    const cells = (row.values as unknown[]).slice(1).map((v) => cellText(v).trim());
    rows.push(cells);
  });
  return rows;
}

const toCreate = (u: UniversityInput) => ({ name: u.name, country: u.country, base_url: u.base_url, notes: u.notes ?? null });

// ---- Background website auto-discovery -------------------------------------
interface DiscoverProgress { running: boolean; done: number; total: number; found: number }
let discoverState: DiscoverProgress = { running: false, done: 0, total: 0, found: 0 };
export const getDiscoverProgress = (): DiscoverProgress => discoverState;

/** Find the official website for every university that has none — in the background. */
export async function startDiscoverMissing(): Promise<{ started: boolean; total: number }> {
  if (discoverState.running) return { started: false, total: discoverState.total };
  const missing = await universityRepository.findManyMissingBaseUrl();
  if (missing.length === 0) return { started: false, total: 0 };
  discoverState = { running: true, done: 0, total: missing.length, found: 0 };
  void (async () => {
    // Sequential + polite delay so the free search engine doesn't rate-limit us
    // (a burst of concurrent queries gets throttled → empty results).
    for (const u of missing) {
      try {
        const url = await discoverUniversityUrl(u.name, u.country);
        if (url) { await universityRepository.updateBaseUrl(u.id, url); discoverState.found += 1; }
      } catch { /* leave blank; user can retry */ }
      discoverState.done += 1;
      await new Promise((r) => setTimeout(r, 200));
    }
    discoverState = { ...discoverState, running: false };
  })();
  return { started: true, total: missing.length };
}

/** Discover + save the website for a single university (the row "Find website" button). */
export async function discoverOne(id: string): Promise<{ base_url: string }> {
  const u = await universityRepository.findById(id);
  if (!u) throw new Error("University not found");
  const url = await discoverUniversityUrl(u.name, u.country);
  if (url) await universityRepository.updateBaseUrl(id, url);
  return { base_url: url };
}

/** Insert parsed rows, then kick off background discovery for any missing URLs. */
export async function importParsedUniversities(rows: UniversityInput[]): Promise<ImportResult> {
  await assertUniversityCapNotExceeded(rows.length);
  const inserted = rows.length ? await universityRepository.createMany(rows.map(toCreate)) : 0;
  const discovering = rows.filter((r) => !r.base_url).length;
  if (discovering > 0) void startDiscoverMissing();
  return { inserted, parsed: rows.length, discovering, errors: [] };
}

export async function bulkImportUniversities(csv: string): Promise<ImportResult> {
  const { valid, errors } = buildRowsFromMatrix(await parseCsvToRows(csv));
  const res = await importParsedUniversities(valid);
  return { ...res, errors };
}

/** Bulk import from an uploaded file buffer — auto-detects .xlsx (PK zip) vs CSV. */
export async function bulkImportUniversitiesFromBuffer(buf: Buffer): Promise<ImportResult> {
  const isXlsx = buf.length > 1 && buf[0] === 0x50 && buf[1] === 0x4b; // "PK" = zip/xlsx
  const matrix = isXlsx ? await xlsxBufferToRows(buf) : await parseCsvToRows(buf.toString("utf8"));
  const { valid, errors } = buildRowsFromMatrix(matrix);
  const res = await importParsedUniversities(valid);
  return { ...res, errors };
}
