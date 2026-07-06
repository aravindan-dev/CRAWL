import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { repoRoot } from "@clg/shared";

/**
 * Full settings surface for the dashboard — every CLI/.env hyperparameter, with
 * plain-English notes, persisted to the repo .env. Crawl/parse settings take
 * effect when the worker (re)starts; the API reads them at start too.
 */
const ENV_PATH = resolve(repoRoot(), ".env");

export interface SettingField {
  key: string;
  group: string;
  label: string;
  type: "number" | "text" | "select" | "secret";
  note: string;
  options?: string[];
  min?: number;
  max?: number;
  float?: boolean;
  readOnly?: boolean;
  default?: string;
}

const MODELS = ["qwen3:8b", "qwen3:14b", "gemma3:12b", "llama3.1:latest", "mistral:latest", "llama3.2:3b", "phi3:mini"];

export const SETTINGS_SCHEMA: SettingField[] = [
  // ---- Crawl speed ----
  {
    key: "CRAWL_CONCURRENCY", group: "Crawl speed", label: "Browsers (parallel crawlers)", type: "number", min: 1, max: 12, default: "3",
    note: "How many university websites are crawled AT THE SAME TIME — like opening that many browser windows at once. More = faster overall, but uses more memory and CPU. 3–4 is safe on a normal laptop; 6–8 on a powerful machine; 10–12 on a high-end CPU with 32GB+ RAM.",
  },
  {
    key: "PER_DOMAIN_CONCURRENCY", group: "Crawl speed", label: "Pages at once per site", type: "number", min: 1, max: 4, default: "1",
    note: "How many pages to load simultaneously from ONE website. Keep at 1 to stay polite and avoid being blocked.",
  },
  {
    key: "CRAWL_DELAY_MS", group: "Crawl speed", label: "Delay between pages (ms)", type: "number", min: 0, max: 10000, default: "1500",
    note: "Pause between page loads on a site (1000 ms = 1 second). Higher is gentler on the website. 1000–2000 is a good range.",
  },
  // ---- Extraction scope ----
  {
    key: "AUDIENCE", group: "Extraction scope", label: "Find eligibility for…", type: "select", options: ["international", "all"], default: "international",
    note: "'international' = keep only INTERNATIONAL-student entry pages (international admissions, English/IELTS, visa, country-specific, entry requirements) for universities, plus every course's eligibility page. 'all' = keep ALL eligibility/admission pages (domestic + international). Applies on the next Validate & export.",
  },
  // ---- Crawl coverage ----
  {
    key: "MAX_PAGES_PER_UNIVERSITY", group: "Crawl coverage", label: "Max pages per university", type: "number", min: 10, max: 50000, default: "300",
    note: "Upper limit of pages to visit on each university site. Higher = more thorough (catches more course pages) but slower. For full course coverage on big universities, raise to several thousand.",
  },
  {
    key: "MAX_CRAWL_DEPTH", group: "Crawl coverage", label: "Max depth (link hops)", type: "number", min: 1, max: 12, default: "4",
    note: "How many clicks away from the homepage to follow links. 4 reaches most course pages; raise to 8–12 for deeply nested course finders.",
  },
  {
    key: "MIN_LINK_SCORE", group: "Crawl coverage", label: "Minimum link score", type: "number", min: 0, max: 100, default: "40",
    note: "Every link gets a relevance score; only links scoring at least this are crawled/kept. Lower = capture more (incl. less-relevant pages); higher = stricter, fewer pages.",
  },
  {
    key: "ENABLE_SITEMAP", group: "Crawl coverage", label: "Use sitemap.xml discovery", type: "select", options: ["true", "false"], default: "true",
    note: "Read each university's sitemap.xml (and robots.txt sitemaps) to capture the FULL course inventory up front, not just links reachable by clicking. Strongly recommended for course coverage.",
  },
  // ---- Parsing & AI ----
  {
    key: "PARSE_CONCURRENCY", group: "Parsing & AI", label: "Parse workers", type: "number", min: 1, max: 8, default: "2",
    note: "How many pages are parsed for criteria text at the same time.",
  },
  {
    key: "AI_PROVIDER", group: "Parsing & AI", label: "AI provider", type: "select", options: ["none", "ollama", "openai", "anthropic", "gemini"], default: "none",
    note: "Where page text is turned into structured criteria. 'none' = fast rule-based only (recommended when you just need the URLs). 'ollama' = local AI on your machine.",
  },
  {
    key: "OLLAMA_BASE_URL", group: "Parsing & AI", label: "Ollama URL", type: "text", default: "http://localhost:11434",
    note: "Address of your local Ollama server (used only when provider = ollama).",
  },
  {
    key: "OLLAMA_EXTRACTION_MODEL", group: "Parsing & AI", label: "Main model", type: "select", options: MODELS, default: "llama3.1:latest",
    note: "Primary local model used to extract criteria.",
  },
  {
    key: "OLLAMA_FALLBACK_MODEL", group: "Parsing & AI", label: "Fallback model", type: "select", options: MODELS, default: "mistral:latest",
    note: "Backup model used if the main one fails.",
  },
  {
    key: "OLLAMA_TEMPERATURE", group: "Parsing & AI", label: "Temperature", type: "number", min: 0, max: 1, float: true, default: "0",
    note: "Creativity of the model. 0 = most accurate/deterministic (best for extraction). Keep low.",
  },
  {
    key: "OLLAMA_NUM_CTX", group: "Parsing & AI", label: "Context size (tokens)", type: "number", min: 512, max: 32768, default: "8192",
    note: "How much text the model can read at once. 8192 is a good default.",
  },
  {
    key: "OLLAMA_MAX_INPUT_CHARS", group: "Parsing & AI", label: "Max input characters", type: "number", min: 1000, max: 60000, default: "12000",
    note: "Max characters sent to the model per page chunk.",
  },
  {
    key: "OLLAMA_TIMEOUT_MS", group: "Parsing & AI", label: "Model timeout (ms)", type: "number", min: 5000, max: 600000, default: "120000",
    note: "How long to wait for the model before giving up on a page.",
  },
  // ---- API keys ----
  { key: "OPENAI_API_KEY", group: "API keys (optional)", label: "OpenAI API key", type: "secret", note: "Only needed if AI provider = openai. Leave blank to keep the current value." },
  { key: "ANTHROPIC_API_KEY", group: "API keys (optional)", label: "Anthropic API key", type: "secret", note: "Only needed if AI provider = anthropic. For AWS Bedrock, use your Bedrock API key. Leave blank to keep the current value." },
  { key: "ANTHROPIC_BASE_URL", group: "API keys (optional)", label: "Anthropic Base URL", type: "text", default: "", note: "Optional. For AWS Bedrock, use: https://bedrock-runtime.{region}.amazonaws.com (e.g., us-east-1). Leave empty for standard Anthropic API." },
  { key: "ANTHROPIC_MODEL", group: "API keys (optional)", label: "Anthropic Model", type: "text", default: "", note: "Optional. For AWS Bedrock, use model ARN like: anthropic.claude-3-5-sonnet-20241022-v2:0. Leave empty for default Claude model." },
  { key: "GEMINI_API_KEY", group: "API keys (optional)", label: "Gemini API key", type: "secret", note: "Only needed if AI provider = gemini. Leave blank to keep the current value." },
  // ---- Advanced ----
  {
    key: "USER_AGENT", group: "Advanced", label: "Crawler identity (User-Agent)", type: "text", default: "CLGSearchBot/1.0 (+https://your-contact-page)",
    note: "How the crawler identifies itself to websites. Include a contact URL so site owners can reach you.",
  },
  // ---- Read-only connections ----
  { key: "DATABASE_URL", group: "Connections (read-only)", label: "Database URL", type: "text", readOnly: true, note: "Postgres connection. Change only in .env + docker-compose, then restart." },
  { key: "REDIS_URL", group: "Connections (read-only)", label: "Redis URL", type: "text", readOnly: true, note: "Job-queue connection. Change only in .env, then restart." },
  { key: "API_PORT", group: "Connections (read-only)", label: "API port", type: "text", readOnly: true, note: "Port the API runs on." },
  { key: "WEB_PORT", group: "Connections (read-only)", label: "Web (dashboard) port", type: "text", readOnly: true, note: "Port this dashboard runs on." },
];

function parseEnvFile(): Record<string, string> {
  const map: Record<string, string> = {};
  if (!existsSync(ENV_PATH)) return map;
  for (const line of readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) map[m[1]!] = m[2]!;
  }
  return map;
}

/** Read a single setting's current value from .env (fresh), or its default. */
export function readSetting(key: string): string {
  const e = parseEnvFile();
  const field = SETTINGS_SCHEMA.find((f) => f.key === key);
  return (e[key] ?? field?.default ?? "").trim();
}

export function getSettings() {
  const e = parseEnvFile();
  const groupMap = new Map<string, (SettingField & { value: string; isSet?: boolean })[]>();
  for (const f of SETTINGS_SCHEMA) {
    const raw = e[f.key] ?? f.default ?? "";
    const field = {
      ...f,
      value: f.type === "secret" ? "" : raw,
      isSet: f.type === "secret" ? Boolean(e[f.key] && e[f.key]!.trim()) : undefined,
    };
    if (!groupMap.has(f.group)) groupMap.set(f.group, []);
    groupMap.get(f.group)!.push(field);
  }
  return { groups: [...groupMap.entries()].map(([name, fields]) => ({ name, fields })) };
}

export function updateSettings(input: Record<string, unknown>) {
  const apply: Record<string, string> = {};
  for (const f of SETTINGS_SCHEMA) {
    if (f.readOnly || !(f.key in input)) continue;
    let v = String(input[f.key] ?? "").trim();
    if (f.type === "secret" && v === "") continue; // blank = keep existing secret
    if (f.type === "number") {
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      const clamped = Math.max(f.min ?? -Infinity, Math.min(f.max ?? Infinity, n));
      v = String(f.float ? clamped : Math.round(clamped));
    }
    if (f.type === "select" && f.options && !f.options.includes(v)) continue;
    apply[f.key] = v;
  }
  const lines = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8").split(/\r?\n/) : [];
  const seen = new Set<string>();
  const next = lines.map((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (m && apply[m[1]!] !== undefined) {
      seen.add(m[1]!);
      return `${m[1]}=${apply[m[1]!]}`;
    }
    return line;
  });
  for (const [k, val] of Object.entries(apply)) if (!seen.has(k)) next.push(`${k}=${val}`);
  writeFileSync(ENV_PATH, next.join("\n"), "utf8");
  return { updated: Object.keys(apply), ...getSettings() };
}
