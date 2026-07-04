import {
  hashUrl,
  CrawlAction,
  type Section,
  type TableJSON,
  type ParserInput,
} from "@clg/shared";
import { LocalStorageProvider } from "@clg/shared";
import {
  snapshotRepository,
  criteriaRepository,
  universityRepository,
} from "@clg/database";
import { ParserOrchestrator } from "@clg/parser";
import { logAction } from "../observability/log.js";

const storage = new LocalStorageProvider();
const orchestrator = new ParserOrchestrator();

interface StoredSections {
  cleaned_text: string;
  tables: TableJSON[];
  sections: Section[];
}

export interface ParseResult {
  stored: number;
  duplicates: number;
  filter_rate: number;
  parser_used: string;
}

/**
 * Parse one page snapshot: rebuild the ParserInput from persisted chunks, run
 * the two-pass orchestrator (which enforces the URL invariant + snippet
 * validation + dedup), then upsert the resulting CourseCriteria rows.
 */
export async function runParseSnapshot(snapshotId: string): Promise<ParseResult> {
  const snapshot = await snapshotRepository.findById(snapshotId);
  if (!snapshot) {
    return { stored: 0, duplicates: 0, filter_rate: 0, parser_used: "none" };
  }
  // CONTEXT GUARD (second layer, on the snapshot row itself): course criteria
  // are parsed only from ELIGIBILITY-context snapshots — validated individual
  // course pages. Scholarship snapshots must never create CourseCriteria.
  if (snapshot.crawl_context === "SCHOLARSHIP") {
    return { stored: 0, duplicates: 0, filter_rate: 0, parser_used: "none(cross-context)" };
  }

  const university = await universityRepository.findById(snapshot.university_id);
  const universityName = university?.name ?? "Unknown University";

  // Load the persisted section chunks (path is derivable from final_url hash).
  const urlHash = hashUrl(snapshot.final_url);
  let stored: StoredSections;
  try {
    const raw = await storage.readText(
      `storage/text/${snapshot.university_id}/${urlHash}.sections.json`,
    );
    stored = JSON.parse(raw) as StoredSections;
  } catch {
    // Fall back to the snapshot's flattened text with no section structure.
    stored = { cleaned_text: snapshot.extracted_text ?? "", tables: [], sections: [] };
  }

  const input: ParserInput = {
    university_name: universityName,
    source_url: snapshot.final_url, // the exact page URL — the invariant anchor
    page_title: snapshot.page_title ?? "",
    cleaned_text: stored.cleaned_text,
    sections: stored.sections,
    tables: stored.tables,
  };

  const start = Date.now();
  const { records, stats } = await orchestrator.parse(input);

  let storedCount = 0;
  let duplicateCount = 0;
  for (const item of records) {
    const r = item.record;
    // Guard the DB CHECK constraints: snippet must be non-empty.
    const snippet = r.source_snippet?.trim() ? r.source_snippet : stored.cleaned_text.slice(0, 200) || r.course_name;
    try {
      await criteriaRepository.upsertByDedupKey({
        university_id: snapshot.university_id,
        discovered_link_id: snapshot.discovered_link_id,
        university_name: r.university_name || universityName,
        course_name: r.course_name,
        canonical_course_key: item.canonical_course_key,
        degree_level: r.degree_level,
        criteria: r.criteria,
        criteria_url: r.criteria_url, // == snapshot.final_url (enforced)
        source_snippet: snippet,
        required_subjects: r.required_subjects,
        minimum_marks: r.minimum_marks,
        entrance_exam: r.entrance_exam,
        english_requirement: r.english_requirement,
        confidence_score: r.confidence_score,
        parser_type: r.parser_type,
        source_language: r.source_language,
        review_status: item.review_status,
      });
      if (item.is_duplicate) duplicateCount += 1;
      else storedCount += 1;
    } catch (err) {
      await logAction({
        university_id: snapshot.university_id,
        discovered_link_id: snapshot.discovered_link_id,
        action: CrawlAction.STORE_CRITERIA,
        status: "ERROR",
        message: `store failed for "${r.course_name}"`,
        error_stack: err instanceof Error ? err.stack : undefined,
      });
    }
  }

  if (storedCount > 0) {
    // Recompute authoritatively (DISTINCT criteria URLs) — NOT increment — so the
    // course count reflects real unique eligibility URLs and never inflates when a
    // page is re-parsed across resumes.
    await universityRepository.recomputeStats(snapshot.university_id).catch(() => {});
  }

  await logAction({
    university_id: snapshot.university_id,
    discovered_link_id: snapshot.discovered_link_id,
    action: CrawlAction.PARSE_CRITERIA,
    status: "OK",
    duration_ms: Date.now() - start,
    message: `parser=${stats.parser_used} filtered=${(stats.filter_rate * 100).toFixed(0)}% stored=${storedCount} dupes=${duplicateCount}`,
  });

  return {
    stored: storedCount,
    duplicates: duplicateCount,
    filter_rate: stats.filter_rate,
    parser_used: stats.parser_used,
  };
}
