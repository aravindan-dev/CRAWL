import {
  type EligibilityParser,
  type ParserInput,
  type ParsedCourseCriteria,
  ollamaCoursesEnvelopeSchema,
} from "@clg/shared";
import { ELIGIBILITY_SYSTEM_PROMPT, buildEligibilityUserPrompt } from "../prompts/eligibilityPrompt.js";
import { extractJson } from "./jsonRepair.js";

export interface AnthropicParserConfig {
  apiKey: string;
  /** Defaults to a current Claude model; override via env if desired. */
  model?: string;
  baseUrl?: string;
  temperature?: number;
  maxInputChars: number;
  timeoutMs: number;
}

/** Thin Anthropic (Claude) adapter. Optional v1 provider for re-running
 *  low-confidence records at higher accuracy. */
export class AnthropicEligibilityParser implements EligibilityParser {
  constructor(private readonly config: AnthropicParserConfig) {}

  async parseEligibility(input: ParserInput): Promise<ParsedCourseCriteria[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const res = await fetch(`${this.config.baseUrl ?? "https://api.anthropic.com"}/v1/messages`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": this.config.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.config.model ?? "claude-sonnet-4-6",
          max_tokens: 4096,
          temperature: this.config.temperature ?? 0,
          system: ELIGIBILITY_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: buildEligibilityUserPrompt(input, this.config.maxInputChars),
            },
          ],
        }),
      });
      if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as { content?: { type: string; text?: string }[] };
      const raw = data.content?.map((c) => c.text ?? "").join("") ?? "";
      const envelope = ollamaCoursesEnvelopeSchema.parse(extractJson(raw));
      return envelope.courses.map((c) => ({ ...c, parser_type: "ai" as const }));
    } finally {
      clearTimeout(timeout);
    }
  }
}
