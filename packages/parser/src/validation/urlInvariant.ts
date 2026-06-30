import type { ParsedCourseCriteria } from "@clg/shared";
import { isHttpUrl } from "@clg/shared";

/**
 * THE non-negotiable URL invariant (spec Sections 3, 4, 49).
 *
 * After any parser runs, `criteria_url` is unconditionally overwritten with the
 * real page URL (`source_url`), regardless of what the model emitted. This is
 * the single most important guard in the system — never trust a model-produced
 * URL.
 */
export function enforceUrlInvariant(
  records: ParsedCourseCriteria[],
  sourceUrl: string,
): ParsedCourseCriteria[] {
  if (!isHttpUrl(sourceUrl)) {
    throw new Error(`enforceUrlInvariant: source_url is not a valid http(s) URL: ${sourceUrl}`);
  }
  return records.map((r) => ({ ...r, criteria_url: sourceUrl }));
}

/** True iff every record's criteria_url equals the expected source URL. */
export function assertUrlInvariant(
  records: ParsedCourseCriteria[],
  sourceUrl: string,
): boolean {
  return records.every((r) => r.criteria_url === sourceUrl);
}
