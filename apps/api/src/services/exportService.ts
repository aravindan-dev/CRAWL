import { randomUUID } from "node:crypto";
import { storagePaths, ExportScope } from "@clg/shared";
import {
  criteriaRepository,
  exportRepository,
  type ListCriteriaParams,
  type CourseCriteria,
} from "@clg/database";
import { validateExportRecords } from "./exportGate.js";
import { writeCsv, writeXlsx } from "./exportWriter.js";

export interface ExportRequest {
  scope: string;
  format: "csv" | "excel";
  university_id?: string;
  createdAfter?: string;
  createdBefore?: string;
}

export class ExportAbortError extends Error {
  constructor(
    message: string,
    public readonly abortIds: string[],
    public readonly warnings: string[],
  ) {
    super(message);
    this.name = "ExportAbortError";
  }
}

/** Translate an export scope (+ optional narrowing) into a repository filter. */
function scopeToParams(req: ExportRequest): ListCriteriaParams {
  const params: ListCriteriaParams = {};
  if (req.university_id) params.university_id = req.university_id;
  if (req.createdAfter) params.createdAfter = new Date(req.createdAfter);
  if (req.createdBefore) params.createdBefore = new Date(req.createdBefore);

  switch (req.scope) {
    case ExportScope.APPROVED_ONLY:
      params.review_status = "APPROVED";
      break;
    case ExportScope.LOW_CONFIDENCE:
      params.maxConfidence = 0.6;
      break;
    case ExportScope.BY_UNIVERSITY:
    case ExportScope.BY_DATE:
    case ExportScope.ALL:
    default:
      break;
  }
  return params;
}

export interface ExportOutcome {
  exportId: string;
  filePath: string;
  totalRecords: number;
  warnings: string[];
  flaggedCount: number;
  excludedCount: number;
}

export async function runExport(req: ExportRequest): Promise<ExportOutcome> {
  const records = (await criteriaRepository.findAllForExport(scopeToParams(req))) as CourseCriteria[];
  const gate = validateExportRecords(records, req.scope);

  if (gate.abort) {
    throw new ExportAbortError(
      `Export blocked: ${gate.abortIds.length} record(s) missing mandatory fields.`,
      gate.abortIds,
      gate.warnings,
    );
  }

  const id = randomUUID();
  const isExcel = req.format === "excel";
  const filePath = isExcel ? storagePaths.exportXlsx(id) : storagePaths.exportCsv(id);

  if (isExcel) await writeXlsx(gate.included, filePath);
  else await writeCsv(gate.included, filePath);

  const row = await exportRepository.create({
    export_type: isExcel ? "EXCEL" : "CSV",
    file_path: filePath,
    total_records: gate.included.length,
    scope: req.scope,
  });

  return {
    exportId: row.id,
    filePath,
    totalRecords: gate.included.length,
    warnings: gate.warnings,
    flaggedCount: gate.flagged.length,
    excludedCount: gate.excluded.length,
  };
}
