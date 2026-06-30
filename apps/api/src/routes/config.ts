import type { FastifyInstance } from "fastify";
import { env } from "@clg/shared";

/** Models the dashboard picker may choose from (Section 9 + qwen3/gemma3 update). */
export const SUPPORTED_EXTRACTION_MODELS = [
  "qwen3:8b",
  "qwen3:14b",
  "gemma3:12b",
  "llama3.1:latest",
  "mistral:latest",
  "llama3.2:3b",
  "phi3:mini",
];

/**
 * Read-only configuration surface for the dashboard. Models/provider are
 * configured via .env (and consumed by the crawler/parse workers at job time),
 * so this endpoint reports the active config + the supported-model reference.
 */
export async function configRoutes(app: FastifyInstance) {
  app.get("/config", async () => {
    return {
      ai_provider: env.AI_PROVIDER,
      extraction_model: env.OLLAMA_EXTRACTION_MODEL,
      fallback_model: env.OLLAMA_FALLBACK_MODEL,
      temperature: env.OLLAMA_TEMPERATURE,
      num_ctx: env.OLLAMA_NUM_CTX,
      max_input_chars: env.OLLAMA_MAX_INPUT_CHARS,
      ollama_base_url: env.OLLAMA_BASE_URL,
      crawl_concurrency: env.CRAWL_CONCURRENCY,
      parse_concurrency: env.PARSE_CONCURRENCY,
      supported_extraction_models: SUPPORTED_EXTRACTION_MODELS,
    };
  });
}
