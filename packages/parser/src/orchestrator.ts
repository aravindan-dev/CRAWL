import {
  type ParserInput,
  type ParsedCourseCriteria,
  type ReviewStatus,
  type ParserType,
  logger,
} from "@clg/shared";
import { buildParserSet, type ParserSet } from "./factory.js";
import { detectCandidates } from "./candidate.js";
import { enforceUrlInvariant } from "./validation/urlInvariant.js";
import { validateSnippets } from "./validation/snippetValidator.js";
import { dedupeRecords } from "./dedup.js";
import { computeReviewStatus } from "./reviewStatus.js";

export interface StorableCriteria {
  record: ParsedCourseCriteria;
  canonical_course_key: string;
  review_status: ReviewStatus;
  is_duplicate: boolean;
}

export interface OrchestratorStats {
  total_chunks: number;
  candidate_chunks: number;
  filter_rate: number;
  parser_used: ParserType | "none";
  ai_failed: boolean;
  record_count: number;
}

export interface OrchestratorResult {
  records: StorableCriteria[];
  stats: OrchestratorStats;
}

/**
 * Two-pass parse orchestrator (Section 26):
 *  Pass 1 — rule-based candidate filter rejects the majority of chunks.
 *  Pass 2 — only candidate chunks go to the LLM; on any AI failure we fall back
 *           (secondary AI model → rule-based) so one bad page never blocks the run.
 * Then: URL invariant → snippet validation → dedup → review status.
 */
export class ParserOrchestrator {
  private readonly parsers: ParserSet;

  constructor(parsers?: ParserSet) {
    this.parsers = parsers ?? buildParserSet();
  }

  /** Build a reduced ParserInput containing only candidate-chunk text (fewer
   *  tokens, less hallucination). */
  private buildReducedInput(input: ParserInput): { reduced: ParserInput; candidateCount: number; total: number; filterRate: number } {
    const { candidates, totalChunks, filterRate } = detectCandidates(input.sections);
    const text = candidates
      .map((c) => `${c.heading ? `## ${c.heading}\n` : ""}${c.nearby_text}`)
      .join("\n\n");
    const tables = candidates.flatMap((c) => c.tables);
    const reduced: ParserInput = {
      ...input,
      cleaned_text: text || input.cleaned_text,
      sections: input.sections, // keep full sections for rule fallback context
      tables: tables.length ? tables : input.tables,
    };
    return { reduced, candidateCount: candidates.length, total: totalChunks, filterRate };
  }

  async parse(input: ParserInput): Promise<OrchestratorResult> {
    const { reduced, candidateCount, total, filterRate } = this.buildReducedInput(input);

    let records: ParsedCourseCriteria[] = [];
    let parserUsed: ParserType | "none" = "none";
    let aiFailed = false;

    if (candidateCount === 0) {
      // Nothing worth parsing — skip both rule + AI, return empty fast.
      return {
        records: [],
        stats: {
          total_chunks: total,
          candidate_chunks: 0,
          filter_rate: filterRate,
          parser_used: "none",
          ai_failed: false,
          record_count: 0,
        },
      };
    }

    if (this.parsers.primary) {
      try {
        records = await this.parsers.primary.parseEligibility(reduced);
        parserUsed = "ai";
      } catch (err) {
        aiFailed = true;
        logger.warn({ err: String(err) }, "primary AI parser failed; trying fallback");
        if (this.parsers.secondary) {
          try {
            records = await this.parsers.secondary.parseEligibility(reduced);
            parserUsed = "ai";
          } catch (err2) {
            logger.warn({ err: String(err2) }, "secondary AI parser failed; using rule parser");
            records = await this.parsers.rule.parseEligibility(reduced);
            parserUsed = "rule_based";
          }
        } else {
          records = await this.parsers.rule.parseEligibility(reduced);
          parserUsed = "rule_based";
        }
      }
    } else {
      records = await this.parsers.rule.parseEligibility(reduced);
      parserUsed = "rule_based";
    }

    // --- Invariants & post-processing -------------------------------------
    // 1. URL invariant: criteria_url := real page URL, always.
    records = enforceUrlInvariant(records, input.source_url);
    // 2. Snippet validation against the FULL cleaned text (not the reduced one).
    const validated = validateSnippets(records, input.cleaned_text);
    // 3. Dedup within this page's batch.
    const deduped = dedupeRecords(validated);

    const storable: StorableCriteria[] = deduped.map((d, i) => {
      const snippetInvalid = Boolean((validated[i] as { __snippet_invalid?: boolean }).__snippet_invalid);
      return {
        record: d.record,
        canonical_course_key: d.canonical_course_key,
        is_duplicate: d.isDuplicate,
        review_status: computeReviewStatus({
          record: d.record,
          snippetInvalid,
          isDuplicate: d.isDuplicate,
        }),
      };
    });

    return {
      records: storable,
      stats: {
        total_chunks: total,
        candidate_chunks: candidateCount,
        filter_rate: filterRate,
        parser_used: parserUsed,
        ai_failed: aiFailed,
        record_count: storable.length,
      },
    };
  }
}
