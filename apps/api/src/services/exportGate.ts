import { isHttpUrl, ExportScope } from "@clg/shared";
import type { CourseCriteria } from "@clg/database";

/**
 * Per-scope export validation (fix #5 — resolves the Section 36 contradiction).
 *
 *  - EVERY scope: criteria_url (valid http/https, non-empty) and source_snippet
 *    (non-empty) are mandatory. A row missing them is EXCLUDED with a warning
 *    (DB CHECK constraints make this rare).
 *  - approved_only scope: additionally requires non-null criteria AND a real
 *    course_name (not "Unknown Course"). Any failing selected row ABORTS the
 *    export, listing the offending record IDs.
 *  - other scopes (all / low_confidence / by_university / by_date): rows with
 *    null criteria or "Unknown Course" are INCLUDED but FLAGGED, never abort.
 */
export interface GateResult {
  ok: boolean;
  abort: boolean;
  included: CourseCriteria[];
  excluded: { id: string; reasons: string[] }[];
  flagged: { id: string; reasons: string[] }[];
  abortIds: string[];
  warnings: string[];
}

function baseFieldProblems(r: CourseCriteria): string[] {
  const problems: string[] = [];
  if (!r.criteria_url || !isHttpUrl(r.criteria_url)) problems.push("criteria_url missing/invalid");
  if (!r.source_snippet || r.source_snippet.trim().length === 0) problems.push("source_snippet empty");
  return problems;
}

function approvedFieldProblems(r: CourseCriteria): string[] {
  const problems: string[] = [];
  if (r.criteria === null || r.criteria.trim().length === 0) problems.push("criteria null/empty");
  if (!r.course_name || r.course_name === "Unknown Course") problems.push("course_name unclear");
  return problems;
}

export function validateExportRecords(records: CourseCriteria[], scope: string): GateResult {
  const included: CourseCriteria[] = [];
  const excluded: { id: string; reasons: string[] }[] = [];
  const flagged: { id: string; reasons: string[] }[] = [];
  const abortIds: string[] = [];
  const warnings: string[] = [];

  const isApprovedScope = scope === ExportScope.APPROVED_ONLY;

  for (const r of records) {
    const baseProblems = baseFieldProblems(r);
    if (baseProblems.length > 0) {
      // Mandatory in every scope → exclude with warning.
      excluded.push({ id: r.id, reasons: baseProblems });
      warnings.push(`Excluded ${r.id}: ${baseProblems.join(", ")}`);
      continue;
    }

    const approvedProblems = approvedFieldProblems(r);
    if (isApprovedScope) {
      if (approvedProblems.length > 0) {
        abortIds.push(r.id);
        continue;
      }
      included.push(r);
    } else {
      if (approvedProblems.length > 0) {
        flagged.push({ id: r.id, reasons: approvedProblems });
      }
      included.push(r);
    }
  }

  if (isApprovedScope && abortIds.length > 0) {
    return {
      ok: false,
      abort: true,
      included: [],
      excluded,
      flagged,
      abortIds,
      warnings: [
        `Export aborted: ${abortIds.length} approved-scope record(s) missing mandatory criteria/course_name.`,
        ...warnings,
      ],
    };
  }

  if (flagged.length > 0) {
    warnings.push(`${flagged.length} record(s) included but flagged (null criteria or Unknown Course).`);
  }

  return { ok: true, abort: false, included, excluded, flagged, abortIds, warnings };
}
