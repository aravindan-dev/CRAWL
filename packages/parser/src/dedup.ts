import type { ParsedCourseCriteria } from "@clg/shared";

/**
 * Canonical course key (Section 32): lowercase, strip punctuation, collapse
 * whitespace. Used as part of the dedup key and the DB unique constraint.
 */
export function canonicalCourseKey(courseName: string): string {
  return courseName
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface DedupedRecord {
  record: ParsedCourseCriteria;
  canonical_course_key: string;
  isDuplicate: boolean;
}

/**
 * Deduplicate a batch of parsed records.
 *
 * Duplicate := same (canonical_course_key, criteria_url). The higher-confidence
 * record wins; the loser is flagged isDuplicate (kept for audit). Records that
 * share a course name but have a DIFFERENT criteria_url are NOT duplicates —
 * they are cross-URL variants, kept and grouped downstream in the dashboard.
 */
export function dedupeRecords(records: ParsedCourseCriteria[]): DedupedRecord[] {
  const best = new Map<string, number>(); // key -> index of current best
  const out: DedupedRecord[] = records.map((record) => ({
    record,
    canonical_course_key: canonicalCourseKey(record.course_name),
    isDuplicate: false,
  }));

  out.forEach((item, idx) => {
    const key = `${item.canonical_course_key}::${item.record.criteria_url}`;
    const existingIdx = best.get(key);
    if (existingIdx === undefined) {
      best.set(key, idx);
      return;
    }
    const existing = out[existingIdx]!;
    if (item.record.confidence_score > existing.record.confidence_score) {
      existing.isDuplicate = true;
      best.set(key, idx);
    } else {
      item.isDuplicate = true;
    }
  });

  return out;
}
