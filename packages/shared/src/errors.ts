/**
 * Translate a technical/program error into a clear, human-understandable message
 * the user can act on. Used across the API, crawler logs, and surfaced in the UI
 * so nobody sees raw stack traces or cryptic codes like ECONNREFUSED.
 */
export function humanizeError(err: unknown): string {
  const raw =
    err instanceof Error ? `${err.message}` :
    typeof err === "string" ? err :
    (() => { try { return JSON.stringify(err); } catch { return String(err); } })();
  const msg = (raw || "").trim();
  const low = msg.toLowerCase();
  const code = (err as { code?: string })?.code ?? "";

  const has = (...needles: string[]) => needles.some((n) => low.includes(n.toLowerCase()));

  // --- Database (Postgres / Prisma) ---
  if (has("ECONNREFUSED") && has("5432", "5433", "postgres")) return "Can't reach the database. Is Docker running? Start Docker Desktop, then `docker compose up -d postgres redis`.";
  if (has("can't reach database", "cannot reach database", "database server", "P1001")) return "The database isn't responding. Make sure the Postgres container is running (Docker), then try again.";
  if (has("P2002", "unique constraint")) return "That record already exists (duplicate) — it was skipped.";
  if (has("P2025", "record to update not found", "no record was found")) return "The item you're trying to update no longer exists (it may have been deleted).";
  if (has("P2003", "foreign key")) return "This item is still linked to other data, so it can't be changed/removed yet.";
  if (has("prismaclient", "prisma")) return "A database operation failed. If this persists, restart the API and make sure Docker (Postgres) is running.";

  // --- Redis / job queue ---
  if (has("ECONNREFUSED") && has("6379", "6380", "redis")) return "Can't reach the job queue (Redis). Start Docker, then `docker compose up -d redis`.";
  if (has("redis", "ioredis", "connection is closed", "stream isn't writeable")) return "The job queue (Redis) is unavailable. Make sure the Redis container is running.";

  // --- Network / fetch (reaching university sites) ---
  if (code === "ENOTFOUND" || has("enotfound", "getaddrinfo")) return "That website's address couldn't be found (DNS). The URL may be wrong, or you're offline.";
  if (code === "ECONNREFUSED" || has("econnrefused")) return "The connection was refused — the server isn't accepting requests right now.";
  if (code === "ECONNRESET" || has("econnreset", "socket hang up")) return "The connection dropped mid-request. The site may be unstable — a re-check usually fixes it.";
  if (code === "ETIMEDOUT" || has("etimedout", "timed out", "timeout") || has("aborterror", "the operation was aborted")) return "The page took too long to respond and timed out. It may be slow or temporarily down.";
  if (code === "EAI_AGAIN" || has("eai_again")) return "A temporary network/DNS hiccup. Check your internet connection and try again.";
  if (has("fetch failed", "network error", "und_err")) return "Couldn't reach the site over the network. Check your connection or try again later.";
  if (has("certificate", "self-signed", "cert_", "depth_zero_self_signed", "unable to verify the first certificate")) return "The site's security certificate couldn't be verified.";

  // --- Browser / Playwright (page rendering) ---
  if (has("navigation timeout", "timeout") && has("exceeded", "navigating to")) return "The page took too long to load fully and was skipped.";
  if (has("net::err_name_not_resolved")) return "That web address couldn't be resolved (DNS) — the site may not exist.";
  if (has("net::err_connection")) return "Couldn't connect to the page — the site refused or dropped the connection.";
  if (has("net::err_aborted", "target closed", "page.goto", "browser has been closed", "0xc0000409")) return "The browser tab closed before the page finished loading. The crawler retries these automatically.";
  if (has("err_too_many_redirects", "redirect")) return "The page redirected too many times (a redirect loop).";

  // --- HTTP status outcomes ---
  if (has("403", "forbidden") || has("429", "too many requests")) return "The site blocked automated access (bot protection / rate limit). It needs a manual check.";
  if (has("404", "not found")) return "The page wasn't found (404) — the link is broken or moved.";
  if (has("500", "502", "503", "504", "bad gateway", "service unavailable", "gateway timeout")) return "The website had a server error and couldn't serve the page. Try again later.";

  // --- App-specific ---
  if (has("aliff email and password")) return "Aliff email and password are required (used only for this run, never stored).";
  if (has("no website set", "find website")) return "This university has no website yet — use \"Find website\" or add a URL before crawling.";
  // Be specific — a bare "port" substring matches "export", "report", "transport"…
  if (has("eaddrinuse", "address already in use", "port already in use")) return "That port is already in use — another copy may be running. Stop it and retry.";
  if (has("enoent", "no such file")) return "A needed file wasn't found. It may not have been generated yet (run the earlier step first).";

  // --- Fallback: return a cleaned version of the original (never a raw stack) ---
  const firstLine = msg.split("\n")[0]!.replace(/\s+at\s+.*$/, "").trim();
  return firstLine.length > 4 ? firstLine : "Something went wrong. Please try again.";
}
