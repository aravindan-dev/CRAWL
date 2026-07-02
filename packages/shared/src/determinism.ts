import { createHash } from "node:crypto";

/**
 * Determinism utilities (redesign §1 G6, §13).
 *
 * The delivered dataset must be a pure function of (site content, config) — never
 * of the machine it ran on. `localeCompare` is ICU/locale dependent (different
 * order on different OS/node builds), so every DATA path sorts with codepoint
 * comparison instead; `datasetHash` is the reproducibility proof stamped on every
 * export (two runs on an unchanged site must produce the same hash).
 */

/** Locale-independent string comparison (UTF-16 code-unit order). */
export function codepointCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * Canonical hash of a dataset: rows are serialized field-by-field (unit-separator
 * joined), sorted by codepoint, newline-joined, sha256'd. Self-sorting makes the
 * hash independent of the order rows were produced in — only CONTENT changes it.
 */
export function datasetHash(rows: (string | number | null | undefined)[][]): string {
  const lines = rows.map((r) => r.map((v) => String(v ?? "")).join("")).sort(codepointCompare);
  return sha256Hex(lines.join("\n"));
}
