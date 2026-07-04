/**
 * Shared domain types for CLG Search.
 *
 * Status enums are declared here as the single source of truth (const objects
 * + derived union types) and mirrored in the Prisma schema. Keep the two in
 * sync — the Prisma enum values must equal these string values.
 */

// --- AI provider ----------------------------------------------------------
export type AIProvider = "ollama" | "openai" | "anthropic" | "gemini" | "none";

// --- Enums (const-object pattern) ----------------------------------------
export const CrawlStatus = {
  IDLE: "IDLE",
  QUEUED: "QUEUED",
  DISCOVERING: "DISCOVERING",
  VALIDATING: "VALIDATING",
  EXTRACTING: "EXTRACTING",
  PARSING: "PARSING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  STOPPED: "STOPPED",
} as const;
export type CrawlStatus = (typeof CrawlStatus)[keyof typeof CrawlStatus];

export const LinkStatus = {
  PENDING: "PENDING",
  QUEUED: "QUEUED",
  VALID_COURSE_PAGE: "VALID_COURSE_PAGE",
  VALID_ADMISSION_PAGE: "VALID_ADMISSION_PAGE",
  POSSIBLE_REQUIREMENT_PAGE: "POSSIBLE_REQUIREMENT_PAGE",
  LOW_CONFIDENCE_PAGE: "LOW_CONFIDENCE_PAGE",
  BROKEN_LINK: "BROKEN_LINK",
  REDIRECTED: "REDIRECTED",
  BLOCKED: "BLOCKED",
  DUPLICATE: "DUPLICATE",
  NOT_RELEVANT: "NOT_RELEVANT",
  PDF_DEFERRED: "PDF_DEFERRED",
  /** Discovered + classified, then refused BEFORE any network request because the
   *  URL belongs to the other crawl context (eligibility URL in a scholarship
   *  crawl or vice versa). Never fetched, never validated, never exported. */
  REJECTED_CROSS_CONTEXT: "REJECTED_CROSS_CONTEXT",
} as const;
export type LinkStatus = (typeof LinkStatus)[keyof typeof LinkStatus];

// --- Crawl context (strict eligibility/scholarship isolation) ---------------
/**
 * The single objective of ONE crawl execution. Every crawl runs under exactly
 * one context, child links inherit it, and it can never switch mid-crawl:
 *  - ELIGIBILITY  → final targets are individual course/programme pages.
 *  - SCHOLARSHIP  → final targets are scholarship pages.
 * A URL classified as belonging to the other context is rejected BEFORE fetch.
 */
export const CrawlContext = {
  ELIGIBILITY: "ELIGIBILITY",
  SCHOLARSHIP: "SCHOLARSHIP",
} as const;
export type CrawlContext = (typeof CrawlContext)[keyof typeof CrawlContext];

/** The crawl executions implied by the CRAWL_TARGET setting: "both" runs TWO
 *  separate, fully-isolated crawls per university (one per context). */
export function contextsForTarget(target: string | undefined): CrawlContext[] {
  if (target === "eligibility") return [CrawlContext.ELIGIBILITY];
  if (target === "scholarship") return [CrawlContext.SCHOLARSHIP];
  return [CrawlContext.ELIGIBILITY, CrawlContext.SCHOLARSHIP];
}

/**
 * What kind of page a URL APPEARS to represent, decided deterministically
 * BEFORE fetching (URL structure + anchor text + vocabulary). This is separate
 * from link SCORING (relevance): a URL can score high yet belong to the wrong
 * crawl context — classification + authorization always outrank the score.
 */
export const PageClass = {
  COURSE_PAGE: "COURSE_PAGE", // one specific course/programme
  COURSE_LISTING: "COURSE_LISTING", // course/programme index, directory, finder
  ELIGIBILITY_PAGE: "ELIGIBILITY_PAGE", // general eligibility / entry requirements
  ADMISSIONS_PAGE: "ADMISSIONS_PAGE", // general admissions / how-to-apply
  INTERNATIONAL_ADMISSIONS_PAGE: "INTERNATIONAL_ADMISSIONS_PAGE",
  SCHOLARSHIP_PAGE: "SCHOLARSHIP_PAGE", // one specific scholarship
  SCHOLARSHIP_LISTING: "SCHOLARSHIP_LISTING", // scholarship index / finder
  FUNDING_PAGE: "FUNDING_PAGE", // funding / bursaries / financial aid
  NAVIGATION_PAGE: "NAVIGATION_PAGE", // generic navigation (faculties, study, …)
  DOCUMENT: "DOCUMENT", // pdf / binary document
  IRRELEVANT: "IRRELEVANT", // hard-filtered (social, news, login, …)
  UNKNOWN: "UNKNOWN",
} as const;
export type PageClass = (typeof PageClass)[keyof typeof PageClass];

export const ReviewStatus = {
  PENDING: "PENDING",
  LOW_CONFIDENCE: "LOW_CONFIDENCE",
  NEEDS_REVIEW: "NEEDS_REVIEW",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  DUPLICATE: "DUPLICATE",
} as const;
export type ReviewStatus = (typeof ReviewStatus)[keyof typeof ReviewStatus];

export const DegreeLevel = {
  Bachelor: "Bachelor",
  Diploma: "Diploma",
  Other: "Other",
} as const;
export type DegreeLevel = (typeof DegreeLevel)[keyof typeof DegreeLevel];

export const ParserType = {
  ai: "ai",
  rule_based: "rule_based",
} as const;
export type ParserType = (typeof ParserType)[keyof typeof ParserType];

export const JobType = {
  DISCOVER: "DISCOVER",
  VALIDATE: "VALIDATE",
  EXTRACT: "EXTRACT",
  PARSE: "PARSE",
  EXPORT: "EXPORT",
} as const;
export type JobType = (typeof JobType)[keyof typeof JobType];

export const JobStatus = {
  QUEUED: "QUEUED",
  RUNNING: "RUNNING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  DEAD_LETTER: "DEAD_LETTER",
} as const;
export type JobStatus = (typeof JobStatus)[keyof typeof JobStatus];

export const CrawlAction = {
  DISCOVER_LINKS: "DISCOVER_LINKS",
  SCORE_LINK: "SCORE_LINK",
  VALIDATE_LINK: "VALIDATE_LINK",
  EXTRACT_PAGE: "EXTRACT_PAGE",
  CLEAN_CONTENT: "CLEAN_CONTENT",
  CHUNK_CONTENT: "CHUNK_CONTENT",
  PARSE_CRITERIA: "PARSE_CRITERIA",
  VALIDATE_SNIPPET: "VALIDATE_SNIPPET",
  STORE_CRITERIA: "STORE_CRITERIA",
  EXPORT_DATA: "EXPORT_DATA",
} as const;
export type CrawlAction = (typeof CrawlAction)[keyof typeof CrawlAction];

export const LogStatus = {
  OK: "OK",
  WARN: "WARN",
  ERROR: "ERROR",
} as const;
export type LogStatus = (typeof LogStatus)[keyof typeof LogStatus];

export const ExportType = {
  CSV: "CSV",
  EXCEL: "EXCEL",
} as const;
export type ExportType = (typeof ExportType)[keyof typeof ExportType];

export const ExportScope = {
  APPROVED_ONLY: "approved_only",
  ALL: "all",
  LOW_CONFIDENCE: "low_confidence",
  BY_UNIVERSITY: "by_university",
  BY_DATE: "by_date",
} as const;
export type ExportScope = (typeof ExportScope)[keyof typeof ExportScope];

// --- Page content shapes --------------------------------------------------
export interface TableJSON {
  caption: string | null;
  headers: string[];
  rows: string[][];
}

export interface Section {
  heading: string | null;
  body: string;
  tables: TableJSON[];
  source_url: string;
  page_title: string;
  university_id: string;
  chunk_index: number;
}

/** A single content block captured in DOM order (drives heading-aware chunking). */
export type ContentBlock =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; items: string[] }
  | { type: "table"; table: TableJSON };

/** Result of Playwright page extraction (Phase 4). */
export interface ExtractedPage {
  requested_url: string;
  final_url: string;
  page_title: string;
  lang: string | null;
  visible_text: string;
  headings: { tag: "h1" | "h2" | "h3"; text: string }[];
  paragraphs: string[];
  lists: string[][];
  tables: TableJSON[];
  internal_links: { url: string; text: string }[];
  /** Ordered blocks (heading/paragraph/list/table) as they appear in the DOM. */
  content_blocks: ContentBlock[];
  raw_html: string;
}

// --- Parser contract (Section 25) ----------------------------------------
export interface ParserInput {
  university_name: string;
  source_url: string;
  page_title: string;
  cleaned_text: string;
  sections: Section[];
  tables: TableJSON[];
}

export interface ParsedCourseCriteria {
  university_name: string;
  course_name: string;
  degree_level: DegreeLevel;
  criteria: string | null;
  required_subjects: string[];
  minimum_marks: string | null;
  entrance_exam: string | null;
  english_requirement: string | null;
  criteria_url: string;
  source_snippet: string;
  confidence_score: number;
  parser_type: ParserType;
  source_language: string;
}

export interface EligibilityParser {
  parseEligibility(input: ParserInput): Promise<ParsedCourseCriteria[]>;
}

/** Pass-1 candidate chunk (Section 26). */
export interface CandidateChunk {
  possible_course_name: string | null;
  nearby_text: string;
  heading: string | null;
  tables: TableJSON[];
  source_url: string;
  page_title: string;
  university_id: string;
  confidence_hint: number;
}
