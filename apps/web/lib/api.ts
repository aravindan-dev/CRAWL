// Trim + strip any trailing slash so a stray space/slash in the env var can't
// corrupt request URLs (e.g. "http://localhost:4000 " + "/ops/transform").
// The fallback matches .env.example's documented API_PORT default; the real
// value is normally injected via apps/web/.env.local by scripts/preflight.ps1.
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000").trim().replace(/\/+$/, "");

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  /** Total rows matching the query (all pages), when the endpoint provides it. */
  total?: number;
}

/** Login/setup pages must not trigger the auth-required redirect on their own 401s. */
const AUTH_EVENT_EXEMPT_PATHS = new Set(["/auth/login", "/auth/setup", "/auth/me"]);

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-requested-with": "clg-web", ...(init?.headers ?? {}) },
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) {
    let detail: unknown;
    try {
      detail = await res.json();
    } catch {
      detail = await res.text();
    }
    // Surface the API's human-readable `error` message (not raw JSON).
    const rawMsg =
      detail && typeof detail === "object" && detail !== null && "error" in detail
        ? (detail as { error: unknown }).error
        : detail;
    const msg =
      typeof rawMsg === "string"
        ? rawMsg
        : rawMsg && typeof rawMsg === "object" && typeof (rawMsg as { message?: unknown }).message === "string"
          ? (rawMsg as { message: string }).message
          : `Request failed (${res.status}). Please try again.`;
    // A 404 on an action endpoint almost always means the API is running an older
    // build that predates this route. Replace the bare "Not Found" with a clear,
    // fixable message so the user knows to restart the API rather than guess.
    const friendly =
      res.status === 404 && (msg === "Not Found" || msg.startsWith("Request failed"))
        ? "This action isn’t available on the API yet — restart the API server to load the latest version, then try again."
        : msg;
    // Session expired/absent mid-use: tell the app shell to re-check auth state
    // immediately (it redirects to /login) instead of waiting for the next poll.
    if (res.status === 401 && typeof window !== "undefined" && !AUTH_EVENT_EXEMPT_PATHS.has(path)) {
      window.dispatchEvent(new Event("clg:auth-required"));
    }
    throw new ApiError(res.status, friendly, detail);
  }
  return (await res.json()) as T;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public detail?: unknown) {
    super(message);
  }
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PUT", body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

export type UserRole = "ADMIN" | "OPERATOR" | "VIEWER";

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
}

// --- Shared view types (kept independent of server packages) ---------------
export interface University {
  id: string;
  name: string;
  country: string;
  base_url: string;
  crawl_status: string;
  total_links_found: number;
  total_valid_links: number;
  total_courses_extracted: number;
  // Verified counts from the validated export files (null until exported). When
  // present these are the authoritative numbers the UI should show.
  verified_courses?: number | null;
  verified_university_urls?: number | null;
  verified_valid_links?: number | null;
  sort_order?: number;
  notes: string | null;
}

/** One verified URL that shipped for a university (from the validated export). */
export interface VerifiedUrl {
  level: "university" | "course" | "scholarship";
  course_name: string;
  url: string;
  http_status: string;
  validity: string;
}

export interface UniversityUrls {
  university: { id: string; name: string; crawl_status: string };
  counts: { courseUrls: number; universityUrls: number; scholarshipUrls?: number; validUrls: number };
  items: VerifiedUrl[];
}

/**
 * One link the engine content-validated DURING the crawl (single pass) — straight
 * from the DB, so it appears live in the "Validated URLs" feed before any export.
 */
export interface ValidatedUrl {
  id: string;
  university: string;
  country: string;
  university_id: string;
  level: "university" | "course" | "scholarship";
  course_name: string;
  url: string;
  /** SECONDARY entry-requirements anchor deep-link (…#entry-requirements) —
   *  same-page section pointer; the primary/exported URL stays `url`. */
  anchor_url: string | null;
  http_status: number | null;
  verdict: string;
  evidence: string;
  updated_at: string;
}

export interface CourseCriteria {
  id: string;
  university_name: string;
  course_name: string;
  degree_level: string;
  criteria: string | null;
  criteria_url: string;
  source_snippet: string;
  required_subjects: string[];
  minimum_marks: string | null;
  entrance_exam: string | null;
  english_requirement: string | null;
  confidence_score: number;
  parser_type: string;
  source_language: string;
  review_status: string;
  created_at: string;
  discovered_link?: { screenshot_path: string | null } | null;
}

/** Build a browser URL for a stored artifact path like "storage/screenshots/…". */
export function artifactUrl(storagePath: string | null | undefined): string | null {
  if (!storagePath) return null;
  return `${API_URL}/artifacts/${storagePath.replace(/^storage\//, "")}`;
}

export interface DiscoveredLink {
  id: string;
  university_id: string;
  url: string;
  final_url: string | null;
  page_title: string | null;
  link_score: number;
  status: string;
  http_status: number | null;
  screenshot_path: string | null;
  /** Best extracted course/programme name(s) for this page (highest confidence first). */
  course_criteria?: { course_name: string; degree_level: string }[];
}

/** A bot-protected / blocked attempt, with the exact university + course tried. */
export interface BlockedLink {
  id: string;
  url: string;
  final_url: string | null;
  page_title: string | null;
  http_status: number | null;
  error_message: string | null;
  retry_count: number;
  link_score: number;
  updated_at: string;
  university: { name: string; country: string; base_url: string } | null;
  course_criteria: { course_name: string; degree_level: string }[];
}

export interface CrawlLog {
  id: string;
  action: string;
  status: string;
  message: string | null;
  duration_ms: number | null;
  error_stack: string | null;
  created_at: string;
}

export interface LicenseStatus {
  state: "valid" | "grace" | "invalid";
  code?: string;
  message?: string;
  customerName?: string;
  edition?: string;
  expiresAt?: string;
  maxUsers?: number | null;
  maxUniversities?: number | null;
  licenseId?: string;
  fingerprint?: string;
  daysLeft?: number;
  graceDaysLeft?: number;
}

export interface Stats {
  total_universities: number;
  total_links_discovered: number;
  total_valid_links: number;
  failed_links: number;
  total_courses_extracted: number;
  pending_review: number;
  approved: number;
  rejected: number;
}
