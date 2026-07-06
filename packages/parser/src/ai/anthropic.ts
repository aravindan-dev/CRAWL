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

/**
 * AWS Bedrock's Anthropic-model Invoke API is a DIFFERENT contract from native
 * Anthropic — different URL shape, different auth, and the API version lives
 * in the request BODY rather than an HTTP header:
 *   native:  POST {baseUrl}/v1/messages           x-api-key + anthropic-version header
 *   bedrock: POST {baseUrl}/model/{id}/invoke      Authorization: Bearer <key>
 *            body carries "anthropic_version": "bedrock-2023-05-31", no "model" field
 * (Bedrock "long-term API keys" — the AWS-issued bearer credential this project's
 * .env documents, format "BedrockAPIKey-…" — are exactly what makes calling
 * Bedrock's REST API from a plain fetch() possible without full SigV4 signing.)
 * The response shape (content: [{type:"text", text}]) is IDENTICAL either way,
 * so only the request needs to branch. Detected by baseUrl+model both being
 * set, matching how .env / settingsService.ts document Bedrock configuration
 * ("leave empty for standard Anthropic API").
 */
function isBedrockConfig(config: AnthropicParserConfig): boolean {
  return Boolean(config.baseUrl && config.model);
}

/** Thin Anthropic (Claude) adapter — native Anthropic API or AWS Bedrock,
 *  auto-detected from config. Optional provider for re-running low-confidence
 *  records at higher accuracy. */
export class AnthropicEligibilityParser implements EligibilityParser {
  constructor(private readonly config: AnthropicParserConfig) {}

  async parseEligibility(input: ParserInput): Promise<ParsedCourseCriteria[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const bedrock = isBedrockConfig(this.config);
      const model = this.config.model ?? "claude-sonnet-4-6";
      const url = bedrock
        ? `${this.config.baseUrl}/model/${encodeURIComponent(model)}/invoke`
        : `${this.config.baseUrl ?? "https://api.anthropic.com"}/v1/messages`;
      const headers: Record<string, string> = bedrock
        ? { "content-type": "application/json", authorization: `Bearer ${this.config.apiKey}` }
        : { "content-type": "application/json", "x-api-key": this.config.apiKey, "anthropic-version": "2023-06-01" };
      const body: Record<string, unknown> = {
        max_tokens: 4096,
        temperature: this.config.temperature ?? 0,
        system: ELIGIBILITY_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: buildEligibilityUserPrompt(input, this.config.maxInputChars),
          },
        ],
      };
      if (bedrock) body.anthropic_version = "bedrock-2023-05-31";
      else body.model = model;

      const res = await fetch(url, { method: "POST", signal: controller.signal, headers, body: JSON.stringify(body) });
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
