import {
  type EligibilityParser,
  type ParserInput,
  type ParsedCourseCriteria,
  ollamaCoursesEnvelopeSchema,
} from "@clg/shared";
import { ELIGIBILITY_SYSTEM_PROMPT, buildEligibilityUserPrompt } from "../prompts/eligibilityPrompt.js";
import { extractJson } from "./jsonRepair.js";

export interface OpenAIParserConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  temperature?: number;
  maxInputChars: number;
  timeoutMs: number;
}

/** Thin OpenAI adapter (Chat Completions, JSON mode). Optional v1 provider. */
export class OpenAIEligibilityParser implements EligibilityParser {
  constructor(private readonly config: OpenAIParserConfig) {}

  async parseEligibility(input: ParserInput): Promise<ParsedCourseCriteria[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const res = await fetch(`${this.config.baseUrl ?? "https://api.openai.com/v1"}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model ?? "gpt-4o-mini",
          temperature: this.config.temperature ?? 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: ELIGIBILITY_SYSTEM_PROMPT },
            { role: "user", content: buildEligibilityUserPrompt(input, this.config.maxInputChars) },
          ],
        }),
      });
      if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const raw = data.choices?.[0]?.message?.content ?? "";
      const envelope = ollamaCoursesEnvelopeSchema.parse(extractJson(raw));
      return envelope.courses.map((c) => ({ ...c, parser_type: "ai" as const }));
    } finally {
      clearTimeout(timeout);
    }
  }
}
