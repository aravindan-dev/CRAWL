/**
 * CRAWL BENCHMARK RUNNER — measures fast-lane throughput per university and
 * writes a before/after comparison. Runs `runUniversityCrawl` DIRECTLY in this
 * process (no BullMQ worker) so a run is isolated and repeatable; each university
 * + context is timed while RAM and CPU are sampled.
 *
 * IMPORTANT: stop the main engine first (dashboard Stop, or kill the crawler
 * process) so it doesn't double-crawl the same universities. Redis + Postgres
 * must be up (validated targets enqueue a parse job).
 *
 * Usage (from apps/crawler):
 *   tsx src/benchmark.ts --label before
 *   # …change config (e.g. HOST_BROWSER_PROBE_BUDGET), then…
 *   tsx src/benchmark.ts --label after
 *   tsx src/benchmark.ts --compare storage/benchmarks/before-*.json storage/benchmarks/after-*.json
 *
 * Flags:
 *   --label <name>       tag for the output file (default "run")
 *   --target <t>         eligibility | scholarship | both (default = CRAWL_TARGET)
 *   --only <substr>      run just the universities whose name matches
 *   --compare <a> <b>    print a diff of two saved runs and exit (no crawl)
 */
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import os from "node:os";
import { prisma, jobRepository } from "@clg/database";
import { logger, repoRoot, env, contextsForTarget, CrawlContext, JobType } from "@clg/shared";
import { runUniversityCrawl } from "./crawl/runCrawl.js";

// The standard benchmark set: 4 structured research universities + 1 JS-heavy
// site whose course finder needs browser expansion (UTS). Override the base_url
// here if a site moves.
const TEST_UNIVERSITIES: { name: string; country: string; base_url: string; note?: string }[] = [
  { name: "University of Oxford", country: "United Kingdom", base_url: "https://www.ox.ac.uk" },
  { name: "University of Sydney", country: "Australia", base_url: "https://www.sydney.edu.au" },
  { name: "Massachusetts Institute of Technology", country: "United States", base_url: "https://www.mit.edu" },
  { name: "University of Melbourne", country: "Australia", base_url: "https://www.unimelb.edu.au" },
  { name: "University of Technology Sydney", country: "Australia", base_url: "https://www.uts.edu.au", note: "JS-heavy course finder" },
];

interface ContextMetric {
  context: string;
  durationSec: number;
  pages: number;
  pagesPerMin: number;
  discoveryPerMin: number;
  validationPerMin: number;
  validated: number;
  browserFallback: number;
  botBlocked: number;
  protectionBlocked: number;
  blockedInDb: number;
  avgQueueWaitMs: number;
  pendingRemaining: number;
  peakNodeRssMB: number;
  peakSystemUsedMB: number;
  nodeCpuPercent: number;
}
interface UniMetric { name: string; base_url: string; note?: string; totalSec: number; contexts: ContextMetric[] }
interface BenchmarkFile { label: string; timestamp: string; target: string; host: { cpus: number; totalMemMB: number }; env: Record<string, string | number | boolean>; universities: UniMetric[] }

const arg = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);

type UniRow = Awaited<ReturnType<typeof prisma.university.create>>;

async function ensureUniversity(u: { name: string; country: string; base_url: string }): Promise<UniRow> {
  const existing = await prisma.university.findFirst({ where: { name: u.name } });
  if (existing) {
    if (existing.base_url !== u.base_url) return prisma.university.update({ where: { id: existing.id }, data: { base_url: u.base_url } });
    return existing;
  }
  return prisma.university.create({ data: { name: u.name, country: u.country, base_url: u.base_url } });
}

/** Run one context, sampling RAM/CPU while it works. */
async function benchContext(university: UniRow, context: CrawlContext): Promise<ContextMetric> {
  const job = await jobRepository.create({ university_id: university.id, job_type: JobType.DISCOVER, crawl_context: context });
  let peakRss = process.memoryUsage().rss;
  let peakSystemUsed = os.totalmem() - os.freemem();
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    peakSystemUsed = Math.max(peakSystemUsed, os.totalmem() - os.freemem());
  }, 500);

  const cpu0 = process.cpuUsage();
  const t0 = Date.now();
  const result = await runUniversityCrawl(university, job.id, context).catch((e) => {
    logger.error({ err: String(e), university: university.name, context }, "benchmark crawl errored");
    return null;
  });
  const durationMs = Date.now() - t0;
  const cpu = process.cpuUsage(cpu0);
  clearInterval(sampler);

  const blockedInDb = await prisma.discoveredLink
    .count({ where: { university_id: university.id, crawl_context: context, status: "BLOCKED" } })
    .catch(() => 0);
  const min = durationMs / 60_000 || 1;
  const r = result;
  return {
    context,
    durationSec: Math.round(durationMs / 1000),
    pages: r?.pagesVisited ?? 0,
    pagesPerMin: Math.round((r?.pagesVisited ?? 0) / min),
    discoveryPerMin: Math.round((r?.linksFound ?? 0) / min),
    validationPerMin: Math.round((r?.validatedTargets ?? 0) / min),
    validated: r?.validatedTargets ?? 0,
    browserFallback: r?.browserFallbackCount ?? 0,
    botBlocked: r?.botBlockedCount ?? 0,
    protectionBlocked: r?.protectionBlockedCount ?? 0,
    blockedInDb,
    avgQueueWaitMs: r?.avgQueueWaitMs ?? 0,
    pendingRemaining: r?.pendingRemaining ?? 0,
    peakNodeRssMB: mb(peakRss),
    peakSystemUsedMB: mb(peakSystemUsed),
    nodeCpuPercent: Math.round(((cpu.user + cpu.system) / 1000 / durationMs) * 100),
  };
}

function printRun(file: BenchmarkFile): void {
  console.log(`\n=== BENCHMARK "${file.label}" @ ${file.timestamp} (target=${file.target}) ===`);
  console.log(`host: ${file.host.cpus} CPUs, ${file.host.totalMemMB} MB RAM | HOST_BROWSER_PROBE_BUDGET=${file.env.HOST_BROWSER_PROBE_BUDGET} ESCALATE_BOT_BLOCKS=${file.env.ESCALATE_BOT_BLOCKS} FAST_LANE_CONCURRENCY=${file.env.FAST_LANE_CONCURRENCY}`);
  for (const u of file.universities) {
    console.log(`\n${u.name}${u.note ? ` (${u.note})` : ""} — ${u.totalSec}s total`);
    for (const c of u.contexts) {
      console.log(
        `  [${c.context}] ${c.durationSec}s | ${c.pagesPerMin} pages/min (${c.pages}p) | disc ${c.discoveryPerMin}/min | valid ${c.validationPerMin}/min (${c.validated}) | ` +
          `browserFallback=${c.browserFallback} botBlocked=${c.botBlocked} protectionBlocked=${c.protectionBlocked} blockedDb=${c.blockedInDb} | ` +
          `queueWait=${c.avgQueueWaitMs}ms | nodeRSS ${c.peakNodeRssMB}MB sysUsed ${c.peakSystemUsedMB}MB nodeCPU ${c.nodeCpuPercent}% | pending=${c.pendingRemaining}`,
      );
    }
  }
}

function compare(aPath: string, bPath: string): void {
  const a = JSON.parse(readFileSync(aPath, "utf8")) as BenchmarkFile;
  const b = JSON.parse(readFileSync(bPath, "utf8")) as BenchmarkFile;
  const sum = (f: BenchmarkFile, pick: (c: ContextMetric) => number) => f.universities.flatMap((u) => u.contexts).reduce((s, c) => s + pick(c), 0);
  const avgPagesMin = (f: BenchmarkFile) => { const cs = f.universities.flatMap((u) => u.contexts); return cs.length ? Math.round(cs.reduce((s, c) => s + c.pagesPerMin, 0) / cs.length) : 0; };
  const totalTime = (f: BenchmarkFile) => f.universities.reduce((s, u) => s + u.totalSec, 0);
  const pct = (before: number, after: number) => (before === 0 ? "n/a" : `${after >= before ? "+" : ""}${Math.round(((after - before) / before) * 100)}%`);
  console.log(`\n=== COMPARE  "${a.label}"  →  "${b.label}" ===`);
  console.log(`avg pages/min:      ${avgPagesMin(a)}  →  ${avgPagesMin(b)}   (${pct(avgPagesMin(a), avgPagesMin(b))})`);
  console.log(`total crawl time:   ${totalTime(a)}s  →  ${totalTime(b)}s   (${pct(totalTime(a), totalTime(b))})`);
  console.log(`browser fallback:   ${sum(a, (c) => c.browserFallback)}  →  ${sum(b, (c) => c.browserFallback)}`);
  console.log(`protection-blocked: ${sum(a, (c) => c.protectionBlocked)}  →  ${sum(b, (c) => c.protectionBlocked)}`);
  console.log(`validated targets:  ${sum(a, (c) => c.validated)}  →  ${sum(b, (c) => c.validated)}   (accuracy proxy — should NOT drop)`);
  console.log(`peak node RSS (max):${Math.max(...a.universities.flatMap((u) => u.contexts).map((c) => c.peakNodeRssMB))}MB  →  ${Math.max(...b.universities.flatMap((u) => u.contexts).map((c) => c.peakNodeRssMB))}MB`);
}

async function main(): Promise<void> {
  const compareA = arg("--compare");
  if (compareA) {
    const compareB = process.argv[process.argv.indexOf("--compare") + 2];
    if (!compareB) { console.error("--compare needs TWO files"); process.exit(1); }
    compare(compareA, compareB);
    return;
  }

  const label = arg("--label") ?? "run";
  const targetArg = (arg("--target") ?? env.CRAWL_TARGET) as "eligibility" | "scholarship" | "both";
  const only = arg("--only");
  const contexts = contextsForTarget(targetArg);
  const set = only ? TEST_UNIVERSITIES.filter((u) => u.name.toLowerCase().includes(only.toLowerCase())) : TEST_UNIVERSITIES;
  if (!set.length) { console.error(`no test universities match --only "${only}"`); process.exit(1); }

  logger.info({ label, target: targetArg, universities: set.map((u) => u.name), contexts }, "benchmark starting");
  const out: BenchmarkFile = {
    label,
    timestamp: new Date().toISOString(),
    target: targetArg,
    host: { cpus: os.cpus().length, totalMemMB: mb(os.totalmem()) },
    env: {
      HOST_BROWSER_PROBE_BUDGET: env.HOST_BROWSER_PROBE_BUDGET,
      ESCALATE_BOT_BLOCKS: env.ESCALATE_BOT_BLOCKS,
      HTTP_FIRST_FETCH: env.HTTP_FIRST_FETCH,
      FAST_LANE_CONCURRENCY: env.FAST_LANE_CONCURRENCY,
      CRAWL_CONCURRENCY: env.CRAWL_CONCURRENCY,
      MAX_PAGES_PER_UNIVERSITY: env.MAX_PAGES_PER_UNIVERSITY,
    },
    universities: [],
  };

  for (const spec of set) {
    const uni = await ensureUniversity(spec);
    logger.info({ university: uni.name }, "benchmarking");
    const uniStart = Date.now();
    const cms: ContextMetric[] = [];
    for (const ctx of contexts) cms.push(await benchContext(uni, ctx));
    out.universities.push({ name: uni.name, base_url: uni.base_url, note: spec.note, totalSec: Math.round((Date.now() - uniStart) / 1000), contexts: cms });
  }

  const dir = resolve(repoRoot(), "storage", "benchmarks");
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${label}-${out.timestamp.replace(/[:.]/g, "-")}.json`);
  writeFileSync(path, JSON.stringify(out, null, 2), "utf8");
  printRun(out);
  console.log(`\nsaved → ${path}`);
}

main()
  .catch((e) => { logger.error({ err: String(e) }, "benchmark failed"); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
