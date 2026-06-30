import { env, type AIProvider, type EligibilityParser } from "@clg/shared";
import { OllamaEligibilityParser } from "./ai/ollama.js";
import { OpenAIEligibilityParser } from "./ai/openai.js";
import { AnthropicEligibilityParser } from "./ai/anthropic.js";
import { GeminiEligibilityParser } from "./ai/gemini.js";
import { RuleBasedEligibilityParser } from "./rule-based/ruleParser.js";

export interface ParserSet {
  provider: AIProvider;
  /** Primary AI parser, or null when AI is disabled/unconfigured. */
  primary: EligibilityParser | null;
  /** Secondary AI parser (e.g. Ollama fallback model), tried before rule-based. */
  secondary: EligibilityParser | null;
  /** Always-available deterministic fallback. */
  rule: RuleBasedEligibilityParser;
}

/** qwen3 family emits reasoning tokens unless think:false is sent. */
function isThinkingModel(model: string): boolean {
  return /^qwen3/i.test(model) || /thinking/i.test(model);
}

/**
 * Build the configured parser set from environment. The orchestrator decides
 * routing/fallback order; this just constructs instances.
 */
export function buildParserSet(): ParserSet {
  const rule = new RuleBasedEligibilityParser();
  const provider = env.AI_PROVIDER as AIProvider;

  if (provider === "ollama") {
    const common = {
      baseUrl: env.OLLAMA_BASE_URL,
      numCtx: env.OLLAMA_NUM_CTX,
      temperature: env.OLLAMA_TEMPERATURE,
      timeoutMs: env.OLLAMA_TIMEOUT_MS,
      maxInputChars: env.OLLAMA_MAX_INPUT_CHARS,
    };
    return {
      provider,
      primary: new OllamaEligibilityParser({
        ...common,
        model: env.OLLAMA_EXTRACTION_MODEL,
        disableThinking: isThinkingModel(env.OLLAMA_EXTRACTION_MODEL),
      }),
      secondary: new OllamaEligibilityParser({
        ...common,
        model: env.OLLAMA_FALLBACK_MODEL,
        disableThinking: isThinkingModel(env.OLLAMA_FALLBACK_MODEL),
      }),
      rule,
    };
  }

  if (provider === "openai" && env.OPENAI_API_KEY) {
    return {
      provider,
      primary: new OpenAIEligibilityParser({
        apiKey: env.OPENAI_API_KEY,
        maxInputChars: env.OLLAMA_MAX_INPUT_CHARS,
        timeoutMs: env.OLLAMA_TIMEOUT_MS,
        temperature: env.OLLAMA_TEMPERATURE,
      }),
      secondary: null,
      rule,
    };
  }

  if (provider === "anthropic" && env.ANTHROPIC_API_KEY) {
    return {
      provider,
      primary: new AnthropicEligibilityParser({
        apiKey: env.ANTHROPIC_API_KEY,
        maxInputChars: env.OLLAMA_MAX_INPUT_CHARS,
        timeoutMs: env.OLLAMA_TIMEOUT_MS,
        temperature: env.OLLAMA_TEMPERATURE,
      }),
      secondary: null,
      rule,
    };
  }

  if (provider === "gemini" && env.GEMINI_API_KEY) {
    return {
      provider,
      primary: new GeminiEligibilityParser({
        apiKey: env.GEMINI_API_KEY,
        maxInputChars: env.OLLAMA_MAX_INPUT_CHARS,
        timeoutMs: env.OLLAMA_TIMEOUT_MS,
        temperature: env.OLLAMA_TEMPERATURE,
      }),
      secondary: null,
      rule,
    };
  }

  // provider === "none" or missing API key → rule-based only.
  return { provider: "none", primary: null, secondary: null, rule };
}
