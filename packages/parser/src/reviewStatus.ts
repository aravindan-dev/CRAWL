import { ReviewStatus, type ParsedCourseCriteria } from "@clg/shared";

export interface ReviewStatusInput {
  record: ParsedCourseCriteria;
  snippetInvalid?: boolean;
  isDuplicate?: boolean;
}

/**
 * Map a parsed record to its review status (Section 31). Order matters:
 * duplicate / structural problems take precedence over raw confidence.
 */
export function computeReviewStatus(input: ReviewStatusInput): ReviewStatus {
  const { record, snippetInvalid, isDuplicate } = input;

  if (isDuplicate) return ReviewStatus.DUPLICATE;
  if (snippetInvalid) return ReviewStatus.NEEDS_REVIEW;
  if (record.criteria === null) return ReviewStatus.NEEDS_REVIEW;
  if (record.course_name === "Unknown Course") return ReviewStatus.NEEDS_REVIEW;

  if (record.confidence_score < 0.6) return ReviewStatus.LOW_CONFIDENCE;
  // 0.6..0.8 and >=0.8 both land in the review queue as PENDING; the dashboard
  // renders a low-confidence badge for the 0.6..0.8 band.
  return ReviewStatus.PENDING;
}

/** True for the 0.6..0.8 band that should show a low-confidence badge. */
export function isLowConfidenceBadge(confidence: number): boolean {
  return confidence >= 0.6 && confidence < 0.8;
}
