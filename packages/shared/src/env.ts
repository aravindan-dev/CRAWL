import { z } from "zod";
import { config as dotenvConfig } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Centralized, validated runtime configuration. Import `env` from here rather
 * than reading `process.env` directly so every service shares one source of
 * truth and fails fast on misconfiguration.
 *
 * On import we load the nearest `.env` walking up from the current working
 * directory (tsx does not auto-load .env). Existing process.env values win, so
 * Docker's injected env_file vars are never overridden.
 */
let dotenvLoaded = false;
function loadDotenvUpwards(): void {
  if (dotenvLoaded) return;
  dotenvLoaded = true;
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) {
      dotenvConfig({ path: candidate });
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}
// Side effect on module load: ensure .env is available before any consumer
// (e.g. PrismaClient) reads process.env.
loadDotenvUpwards();

const numeric = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : Number(v)))
    .pipe(z.number().finite());

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  AI_PROVIDER: z
    .enum(["ollama", "openai", "anthropic", "gemini", "none"])
    .default("ollama"),

  OLLAMA_BASE_URL: z.string().default("http://localhost:11434"),
  OLLAMA_EXTRACTION_MODEL: z.string().default("qwen3:8b"),
  OLLAMA_FALLBACK_MODEL: z.string().default("gemma3:12b"),
  OLLAMA_TIMEOUT_MS: numeric(120000),
  OLLAMA_MAX_INPUT_CHARS: numeric(12000),
  OLLAMA_NUM_CTX: numeric(8192),
  OLLAMA_TEMPERATURE: numeric(0),

  OPENAI_API_KEY: z.string().optional().default(""),
  ANTHROPIC_API_KEY: z.string().optional().default(""),
  GEMINI_API_KEY: z.string().optional().default(""),

  CRAWL_CONCURRENCY: numeric(2),
  PARSE_CONCURRENCY: numeric(1),
  PER_DOMAIN_CONCURRENCY: numeric(1),
  CRAWL_DELAY_MS: numeric(2000),
  MAX_CRAWL_DEPTH: numeric(4),
  MAX_PAGES_PER_UNIVERSITY: numeric(300),
  MIN_LINK_SCORE: numeric(40),
  // Hard wall-clock budget per university. High-value (eligibility/course/
  // admission) links are crawled FIRST, so when the budget is hit the engine has
  // already captured what matters and moves on. This is what makes N universities
  // crawled in parallel all finish within ~the budget instead of running for hours
  // on huge sites. 0 = no time limit (only page/depth caps apply).
  MAX_CRAWL_MINUTES: numeric(40),
  // What the crawl focuses on: "both" (eligibility + scholarship), "eligibility"
  // (course/admission entry-criteria only) or "scholarship" (funding only). The
  // scorer adds the chosen category's signals so the crawl follows the right
  // pages; exports stay separate either way. Restart the engine to apply.
  CRAWL_TARGET: z.enum(["both", "eligibility", "scholarship"]).default("both"),

  SCREENSHOT_STORAGE_PATH: z.string().default("./storage/screenshots"),
  HTML_STORAGE_PATH: z.string().default("./storage/html"),
  TEXT_STORAGE_PATH: z.string().default("./storage/text"),
  EXPORT_STORAGE_PATH: z.string().default("./storage/exports"),

  USER_AGENT: z
    .string()
    .default("CLGSearchBot/1.0 (+https://your-contact-page)"),

  API_PORT: numeric(4000),
  WEB_PORT: numeric(3000),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Lazily-validated env. Safe to import anywhere. */
export const env: Env = new Proxy({} as Env, {
  get(_t, prop: string) {
    return loadEnv()[prop as keyof Env];
  },
});
