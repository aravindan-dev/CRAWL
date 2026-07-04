/**
 * ADAPTIVE THROTTLE (redesign Step 2 — "remove unnecessary fixed waiting").
 *
 * The old crawler slept a FIXED `CRAWL_DELAY_MS` after every same-domain request
 * (Crawlee `sameDomainDelaySecs`), paying the politeness tax even when the server
 * was perfectly healthy. This replaces that with a signal-driven policy:
 *
 *   - healthy 2xx/3xx responses → delay decays toward 0 (no fixed sleep)
 *   - 429 / 503 (rate-limited) → immediate hard backoff + drop to min concurrency
 *   - repeated 5xx / timeouts   → gradual backoff + reduce concurrency
 *
 * It is a PURE state machine (no I/O, no timers) so it is fully unit-testable;
 * the crawler reads `delayMs` before each navigation and pushes `concurrency`
 * into Crawlee's autoscaled pool. Politeness is preserved (robots.txt is still
 * obeyed by the crawler, and any push-back instantly restores a delay), we just
 * stop sleeping when the server is clearly fine.
 */
export type ThrottleSignal = "ok" | "rateLimited" | "serverError" | "timeout";

export interface ThrottleConfig {
  /** Backoff step / initial backoff unit (from CRAWL_DELAY_MS). */
  baseDelayMs: number;
  /** Hard ceiling on the inter-request delay. */
  maxDelayMs: number;
  /** Healthy concurrency (PER_DOMAIN_CONCURRENCY). */
  maxConcurrency: number;
  /** Floor concurrency under pressure. */
  minConcurrency: number;
  /** Consecutive healthy responses before the delay decays one step. */
  decayAfter?: number;
  /** Consecutive healthy responses before concurrency recovers one step. */
  recoverAfter?: number;
  /** POLITENESS FLOOR: the delay never decays below this (default 0). Burst
   *  crawling at zero delay is what gets an IP flagged by CDN bot protection
   *  (observed live: Cloudflare challenged every route after a day of it) —
   *  a small floor keeps request pacing human-ish while staying fast. */
  minDelayMs?: number;
}

export interface Throttle {
  readonly delayMs: number;
  readonly concurrency: number;
  /** Feed one request outcome; returns the resulting {delayMs, concurrency}. */
  note(signal: ThrottleSignal): { delayMs: number; concurrency: number };
}

export function createThrottle(cfg: ThrottleConfig): Throttle {
  const base = Math.max(0, cfg.baseDelayMs);
  const maxDelay = Math.max(base, cfg.maxDelayMs);
  const maxConc = Math.max(1, cfg.maxConcurrency);
  const minConc = Math.max(1, Math.min(cfg.minConcurrency, maxConc));
  const decayAfter = cfg.decayAfter ?? 5;
  const recoverAfter = cfg.recoverAfter ?? 10;
  const minDelay = Math.max(0, Math.min(cfg.minDelayMs ?? 0, maxDelay));

  let delayMs = minDelay;
  let concurrency = maxConc;
  let healthy = 0;
  let errors = 0;

  const state = () => ({ delayMs, concurrency });

  return {
    get delayMs() {
      return delayMs;
    },
    get concurrency() {
      return concurrency;
    },
    note(signal: ThrottleSignal) {
      if (signal === "rateLimited") {
        // Explicit "slow down" — respond immediately and firmly.
        errors += 1;
        healthy = 0;
        delayMs = Math.min(maxDelay, Math.max(base || 1000, delayMs ? delayMs * 2 : base || 1000));
        concurrency = minConc;
      } else if (signal === "serverError" || signal === "timeout") {
        // Transient trouble — back off only once it's clearly repeated, so a
        // single dead page doesn't slow the whole crawl.
        errors += 1;
        healthy = 0;
        if (errors >= 3) {
          const step = base > 0 ? base / 2 : 250;
          delayMs = Math.min(maxDelay, Math.max(step, delayMs ? delayMs * 1.5 : step));
          concurrency = Math.max(minConc, concurrency - 1);
        }
      } else {
        // Healthy: decay the delay and recover concurrency after sustained
        // health. Decay is EXPONENTIAL (halving) so one burst of 429s doesn't
        // tax hundreds of later pages, but never below the politeness floor.
        errors = 0;
        healthy += 1;
        if (delayMs > minDelay && healthy >= decayAfter) {
          const halved = Math.floor(delayMs / 2);
          delayMs = halved <= Math.max(minDelay, 50) ? minDelay : halved;
          healthy = 0;
        } else if (concurrency < maxConc && healthy >= recoverAfter) {
          concurrency = Math.min(maxConc, concurrency + 1);
          healthy = 0;
        }
      }
      return state();
    },
  };
}

/** Map an HTTP status / failure into a throttle signal. */
export function signalFor(httpStatus: number | null, timedOut = false): ThrottleSignal {
  if (timedOut) return "timeout";
  if (httpStatus === 429 || httpStatus === 503) return "rateLimited";
  if (httpStatus !== null && httpStatus >= 500) return "serverError";
  return "ok";
}
