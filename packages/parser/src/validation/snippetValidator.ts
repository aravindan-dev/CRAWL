import type { ParsedCourseCriteria } from "@clg/shared";

/** Normalize whitespace + case for fuzzy comparison. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Dice coefficient over character bigrams. Cheap, dependency-free, robust to
 *  small edits — good enough to confirm a snippet actually came from the page. */
export function diceSimilarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  if (na.length < 2 || nb.length < 2) return 0;

  const bigrams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };

  const ma = bigrams(na);
  const mb = bigrams(nb);
  let intersection = 0;
  for (const [g, countA] of ma) {
    const countB = mb.get(g);
    if (countB) intersection += Math.min(countA, countB);
  }
  return (2 * intersection) / (na.length - 1 + (nb.length - 1));
}

export interface SnippetCheckResult {
  valid: boolean;
  similarity: number;
}

/**
 * Confirm a source_snippet actually traces back to the cleaned page text.
 * Exact substring match → valid. Otherwise slide a same-length window and take
 * the best Dice similarity; ≥ threshold (default 0.85) is accepted.
 */
export function checkSnippet(
  snippet: string,
  cleanedText: string,
  threshold = 0.85,
): SnippetCheckResult {
  if (!snippet.trim()) return { valid: false, similarity: 0 };

  const haystack = normalize(cleanedText);
  const needle = normalize(snippet);

  if (haystack.includes(needle)) return { valid: true, similarity: 1 };

  // Best-window fuzzy match. Step the window to keep this O(n) for long pages.
  const winLen = needle.length;
  if (winLen < 2 || haystack.length < 2) return { valid: false, similarity: 0 };
  const step = Math.max(1, Math.floor(winLen / 4));
  let best = 0;
  for (let i = 0; i + winLen <= haystack.length; i += step) {
    const sim = diceSimilarity(needle, haystack.slice(i, i + winLen));
    if (sim > best) best = sim;
    if (best >= threshold) break;
  }
  return { valid: best >= threshold, similarity: best };
}

/**
 * Validate every record's snippet against the page text. Records whose snippet
 * cannot be traced get confidence forced down to 0.3 and are flagged for review
 * via a returned list (the orchestrator maps that to review_status=NEEDS_REVIEW).
 */
export interface ValidatedRecord extends ParsedCourseCriteria {
  __snippet_invalid?: boolean;
}

export function validateSnippets(
  records: ParsedCourseCriteria[],
  cleanedText: string,
  threshold = 0.85,
): ValidatedRecord[] {
  return records.map((r) => {
    const { valid } = checkSnippet(r.source_snippet, cleanedText, threshold);
    if (valid) return r;
    return {
      ...r,
      confidence_score: Math.min(r.confidence_score, 0.3),
      __snippet_invalid: true,
    };
  });
}
