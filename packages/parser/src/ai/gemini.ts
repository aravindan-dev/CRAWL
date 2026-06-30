import {
  type EligibilityParser,
  type ParserInput,
  type ParsedCourseCriteria,
  ollamaCoursesEnvelopeSchema,
} from "@clg/shared";
import { ELIGIBILITY_SYSTEM_PROMPT, buildEligibilityUserPrompt } from "../prompts/eligibilityPrompt.js";
import { extractJson } from "./jsonRepair.js";

export interface GeminiParserConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  temperature?: number;
  maxInputChars: number;
  timeoutMs: number;
}

/** Thin Google Gemini adapter (generateContent, JSON response). Optional. */
export class GeminiEligibilityParser implements EligibilityParser {
  constructor(private readonly config: GeminiParserConfig) {}

  async parseEligibility(input: ParserInput): Promise<ParsedCourseCriteria[]> {
    const model = this.config.model ?? "gemini-1.5-flash";
    const base = this.config.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const res = await fetch(
        `${base}/models/${model}:generateContent?key=${this.config.apiKey}`,
        {
          method: "POST",
          signal: controller.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: ELIGIBILITY_SYSTEM_PROMPT }] },
            generationConfig: {
              temperature: this.config.temperature ?? 0,
              responseMimeType: "application/json",
            },
            contents: [
              {
                role: "user",
                parts: [{ text: buildEligibilityUserPrompt(input, this.config.maxInputChars) }],
              },
            ],
          }),
        },
      );
      if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      const raw =
        data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      const envelope = ollamaCoursesEnvelopeSchema.parse(extractJson(raw));
      return envelope.courses.map((c) => ({ ...c, parser_type: "ai" as const }));
    } finally {
      clearTimeout(timeout);
    }
  }
}
