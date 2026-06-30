export * from "./interface.js";
export { ParserOrchestrator } from "./orchestrator.js";
export type { OrchestratorResult, OrchestratorStats, StorableCriteria } from "./orchestrator.js";
export { buildParserSet } from "./factory.js";
export type { ParserSet } from "./factory.js";

export { RuleBasedEligibilityParser } from "./rule-based/ruleParser.js";
export { OllamaEligibilityParser } from "./ai/ollama.js";
export { OpenAIEligibilityParser } from "./ai/openai.js";
export { AnthropicEligibilityParser } from "./ai/anthropic.js";
export { GeminiEligibilityParser } from "./ai/gemini.js";

export { enforceUrlInvariant, assertUrlInvariant } from "./validation/urlInvariant.js";
export { checkSnippet, validateSnippets, diceSimilarity } from "./validation/snippetValidator.js";
export { dedupeRecords, canonicalCourseKey } from "./dedup.js";
export { computeReviewStatus, isLowConfidenceBadge } from "./reviewStatus.js";
export { detectCandidates, COURSE_REGEX, CRITERIA_SIGNALS } from "./candidate.js";
export {
  ELIGIBILITY_SYSTEM_PROMPT,
  buildEligibilityUserPrompt,
} from "./prompts/eligibilityPrompt.js";
