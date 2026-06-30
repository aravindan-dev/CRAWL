import { zodToJsonSchema } from "zod-to-json-schema";
import {
  type EligibilityParser,
  type ParserInput,
  type ParsedCourseCriteria,
  ollamaCoursesEnvelopeSchema,
  logger,
} from "@clg/shared";
import { ELIGIBILITY_SYSTEM_PROMPT, buildEligibilityUserPrompt } from "../prompts/eligibilityPrompt.js";
import { extractJson } from "./jsonRepair.js";

export interface OllamaParserConfig {
  baseUrl: string;
  model: string;
  numCtx: number;
  temperature: number;
  timeoutMs: number;
  maxInputChars: number;
  /** qwen3 etc. emit reasoning tokens unless disabled. */
  disableThinking?: boolean;
}

/** JSON Schema (draft-07) derived from the Zod envelope, for Ollama `format`. */
function buildFormatSchema(): Record<string, unknown> {
  const schema = zodToJsonSchema(ollamaCoursesEnvelopeSchema, {
    target: "jsonSchema7",
    $refStrategy: "none",
  }) as Record<string, unknown>;
  // Ollama wants a bare schema object; drop the meta key.
  delete schema["$schema"];
  return schema;
}

const FORMAT_SCHEMA = buildFormatSchema();

interface OllamaChatResponse {
  message?: { content?: string };
  error?: string;
}

/**
 * Ollama extraction parser. Uses POST /api/chat with a JSON-Schema `format`
 * (fix #2) so small local models return schema-valid JSON, and pins
 * `num_ctx` + low `temperature` (fix #3) so the 12k-char input is not silently
 * truncated mid-table.
 */
export class OllamaEligibilityParser implements EligibilityParser {
  constructor(private readonly config: OllamaParserConfig) {}

  async parseEligibility(input: ParserInput): Promise<ParsedCourseCriteria[]> {
    const started = Date.now();
    const userPrompt = buildEligibilityUserPrompt(input, this.config.maxInputChars);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    let raw: string;
    try {
      const res = await fetch(`${this.config.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.config.model,
          stream: false,
          format: FORMAT_SCHEMA,
          // think:false disables qwen3-style reasoning tokens for clean JSON.
          ...(this.config.disableThinking ? { think: false } : {}),
          options: {
            num_ctx: this.config.numCtx,
            temperature: this.config.temperature,
          },
          messages: [
            { role: "system", content: ELIGIBILITY_SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
        }),
      });

      if (!res.ok) {
        throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
      }
      const data = (await res.json()) as OllamaChatResponse;
      if (data.error) throw new Error(`Ollama error: ${data.error}`);
      raw = data.message?.content ?? "";
    } finally {
      clearTimeout(timeout);
    }

    const parsed = extractJson(raw);
    const envelope = ollamaCoursesEnvelopeSchema.parse(parsed);

    const durationMs = Date.now() - started;
    logger.debug(
      {
        model: this.config.model,
        durationMs,
        inputChars: userPrompt.length,
        records: envelope.courses.length,
      },
      "ollama extraction complete",
    );

    // Force parser_type=ai; criteria_url invariant is enforced by the orchestrator.
    return envelope.courses.map((c) => ({ ...c, parser_type: "ai" as const }));
  }
}
