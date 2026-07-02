import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { repoRoot } from "./storage/index.js";

/**
 * Central, editable keyword vocabulary for eligibility/criteria detection.
 * DEFAULT_KEYWORDS are a comprehensive synonym set (English + common other
 * languages) so terms aren't missed. Users can ADD more from the dashboard
 * (Settings → Keywords); custom terms are merged on top and used everywhere
 * (link scorer, export filters, content verification).
 */
export interface KeywordSets {
  eligibility: string[]; // page/URL signals that a page is an eligibility/criteria page
  international: string[]; // international-student entry signals
  evidence: string[]; // words proving the PAGE CONTENT is about entry requirements
  scholarship: string[]; // page/URL signals that a page is about scholarships/funding
}

export const DEFAULT_KEYWORDS: KeywordSets = {
  eligibility: [
    "eligibility", "eligibility criteria", "eligibility requirements", "entry requirements", "entry requirement",
    "entry criteria", "entry criterion", "entry profile", "entry tariff", "entry standards", "admission requirements",
    "admissions requirements", "admission criteria", "academic requirements", "course requirements", "programme requirements",
    "program requirements", "minimum requirements", "minimum eligibility", "qualification requirements", "qualifications required",
    "required qualifications", "prerequisite", "prerequisites", "pre-requisite", "how to apply", "application requirements",
    "selection criteria", "ucas tariff", "tariff points", "points required", "grade requirements", "gpa requirement",
    "subject requirements", "required subjects", "who can apply", "applicant requirements", "admission", "admissions", "/entry",
    // other languages
    "zulassung", "zugangsvoraussetzung", "voraussetzungen", "conditions d'admission", "prérequis", "prerequis",
    "requisitos de admisión", "requisitos de admision", "requisitos de entrada", "requisiti di ammissione", "ammissione",
    "requisitos de admissão", "入学要求", "申请条件", "录取要求", "入学要件", "出願",
  ],
  international: [
    "international students", "international student", "international applicants", "international entry", "international admission",
    "international undergraduate", "international postgraduate", "your country", "country or territory", "country-specific",
    "by country", "english language", "english language requirements", "english language proficiency", "language requirements",
    "english proficiency", "ielts", "toefl", "pte", "duolingo", "student visa", "visa", "tier 4", "cas",
    "qualification equivalence", "international qualifications", "overseas students", "non-eu", "study abroad",
    // other languages
    "internationale studierende", "étudiants internationaux", "estudiantes internacionales", "studenti internazionali",
    "国际学生", "留学生",
  ],
  evidence: [
    "entry requirements", "entry criteria", "eligibility", "admission requirements", "academic requirements",
    "english language requirements", "language requirements", "ielts", "toefl", "minimum grade", "minimum gpa",
    "minimum score", "minimum points", "minimum marks", "qualifications required", "how to apply", "country specific",
    "international students", "required subjects", "grade requirements", "selection criteria", "tariff points",
    "what you need", "applicants must", "you will need", "you must have",
  ],
  scholarship: [
    "scholarship", "scholarships", "scholarship and funding", "scholarships and funding", "scholarship opportunities",
    "funding", "fees and funding", "tuition funding", "financial aid", "financial support", "financial assistance",
    "bursary", "bursaries", "grant", "grants", "fee waiver", "tuition fee waiver", "fee discount", "fee reduction",
    "merit scholarship", "merit-based scholarship", "need-based aid", "international scholarship", "international scholarships",
    "scholarship for international students", "global scholarship", "vice-chancellor scholarship", "dean's scholarship",
    "entrance scholarship", "award", "awards", "stipend", "fellowship", "fellowships", "studentship", "assistantship",
    "cost and funding", "ways to pay", "/scholarship", "/scholarships", "/funding", "/financial-aid", "/bursaries", "/awards",
    // other languages
    "stipendium", "stipendien", "bourse", "bourses", "beca", "becas", "borsa di studio", "borse di studio", "bolsa de estudos",
    "奖学金", "助学金", "奨学金", "장학금",
  ],
};

const CUSTOM_PATH = resolve(repoRoot(), "storage", "keywords.json");

export function loadCustomKeywords(): Partial<KeywordSets> {
  try { return existsSync(CUSTOM_PATH) ? (JSON.parse(readFileSync(CUSTOM_PATH, "utf8")) as Partial<KeywordSets>) : {}; } catch { return {}; }
}

const CATEGORIES = Object.keys(DEFAULT_KEYWORDS) as (keyof KeywordSets)[];

export function saveCustomKeywords(custom: Partial<KeywordSets>): void {
  const clean = (a: unknown): string[] => (Array.isArray(a) ? a.map((s) => String(s).trim()).filter(Boolean) : []);
  mkdirSync(resolve(repoRoot(), "storage"), { recursive: true });
  const out = {} as Record<keyof KeywordSets, string[]>;
  for (const k of CATEGORIES) out[k] = clean(custom[k]);
  writeFileSync(CUSTOM_PATH, JSON.stringify(out, null, 2), "utf8");
}

/** Defaults + user-added, deduped + lowercased (all categories). */
export function getKeywords(): KeywordSets {
  const c = loadCustomKeywords();
  const merge = (k: keyof KeywordSets) =>
    Array.from(new Set([...DEFAULT_KEYWORDS[k], ...((c[k] as string[]) ?? [])].map((s) => s.trim().toLowerCase()).filter(Boolean)));
  const out = {} as KeywordSets;
  for (const k of CATEGORIES) out[k] = merge(k);
  return out;
}

/**
 * VOCAB VERSION (redesign §1 G7): a short hash of the EFFECTIVE keyword sets
 * (defaults + user edits, post-merge). Stamped into every export/audit so a
 * dataset change caused by a vocabulary edit is traceable to its cause — two
 * exports are only comparable when their vocab hashes match.
 */
export function vocabHash(): string {
  const kw = getKeywords();
  const canonical = (Object.keys(kw) as (keyof KeywordSets)[])
    .sort()
    .map((k) => `${k}:${[...kw[k]].sort().join("|")}`)
    .join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 12);
}

/** Compile a keyword list into a case-insensitive regex (spaces ↔ - or _). */
export function keywordsToRegex(list: string[]): RegExp {
  if (!list.length) return /a^/; // matches nothing
  const esc = list.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "[\\s_-]?"));
  return new RegExp(`(${esc.join("|")})`, "i");
}
