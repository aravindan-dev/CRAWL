import { z } from "zod";

/** Zod mirror of TableJSON. */
export const tableJsonSchema = z.object({
  caption: z.string().nullable(),
  headers: z.array(z.string()),
  rows: z.array(z.array(z.string())),
});

/**
 * Zod schema for a single parsed course-criteria record (the parser output).
 * This is also the source for the Ollama structured-output JSON Schema.
 *
 * Note: `criteria_url` is validated as a URL here, but the orchestrator
 * unconditionally overwrites it with `input.source_url` regardless of model
 * output (URL invariant — never trust the model's URL).
 */
export const parsedCourseCriteriaSchema = z.object({
  university_name: z.string().min(1),
  course_name: z.string().min(1),
  degree_level: z.enum(["Bachelor", "Diploma", "Other"]),
  criteria: z.string().nullable(),
  required_subjects: z.array(z.string()),
  minimum_marks: z.string().nullable(),
  entrance_exam: z.string().nullable(),
  english_requirement: z.string().nullable(),
  criteria_url: z.string(),
  source_snippet: z.string(),
  confidence_score: z.number().min(0).max(1),
  parser_type: z.enum(["ai", "rule_based"]),
  source_language: z.string(),
});

export type ParsedCourseCriteriaSchema = z.infer<typeof parsedCourseCriteriaSchema>;

/** Top-level array of parsed records. */
export const parserOutputSchema = z.array(parsedCourseCriteriaSchema);

/**
 * Object-wrapped variant used for Ollama structured output. Wrapping the array
 * in an object yields more reliable schema-constrained decoding from small
 * local models than a bare top-level array.
 */
export const ollamaCoursesEnvelopeSchema = z.object({
  courses: z.array(parsedCourseCriteriaSchema),
});

// --- University input -----------------------------------------------------
// Only the NAME is required. Country and website are optional — the website is
// auto-discovered from the name when left blank, so any input format works.
export const universityInputSchema = z.object({
  name: z.string().min(1),
  country: z.string().optional().default(""),
  base_url: z.string().optional().default(""),
  notes: z.string().optional().nullable(),
});
export type UniversityInput = z.infer<typeof universityInputSchema>;

export const universityBulkSchema = z.object({
  universities: z.array(universityInputSchema).min(1),
});

/** A single row as parsed from an uploaded CSV (header names normalized). */
export const universityCsvRowSchema = z.object({
  university_name: z.string().min(1),
  country: z.string().optional().default(""),
  base_url: z.string().optional().default(""),
  notes: z.string().optional().default(""),
});
export type UniversityCsvRow = z.infer<typeof universityCsvRowSchema>;
