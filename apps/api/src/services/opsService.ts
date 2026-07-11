import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { resolve, extname } from "node:path";
import { repoRoot } from "@clg/shared";
import { HttpError } from "../lib/http.js";
import { formatDuration } from "./crawlAdminService.js";
import { readSetting } from "./settingsService.js";

/**
 * Operations runner: runs the pipeline steps (validate/export, Aliff transform,
 * Aliff auto-fill) as tracked child processes so the web dashboard can drive the
 * whole flow. One operation runs at a time (avoids DB/network/browser contention).
 *
 * The Aliff automation stays a SEPARATE module (tools/aliff-automation) — we only
 * INVOKE it here; credentials are passed through as env for the single run and are
 * never stored.
 */
export type OpsKind = "export-university" | "export-courses" | "export-by-university" | "transform" | "aliff";

interface Task {
  id: string;
  kind: OpsKind;
  label: string;
  status: "running" | "success" | "error";
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  log: string[];
}

const recent: Task[] = [];
let running: Task | null = null;

function pushLog(t: Task, chunk: string) {
  for (const line of chunk.split(/\r?\n/)) if (line.trim()) t.log.push(line);
  if (t.log.length > 500) t.log.splice(0, t.log.length - 500);
}

/** Find the latest "N/M" progress marker the scripts print (e.g. "500/5339"). */
function progressFromLog(log: string[]): { done: number; total: number } | null {
  for (let i = log.length - 1; i >= 0; i--) {
    const m = log[i]!.match(/\b(\d+)\s*\/\s*(\d+)\b/);
    if (m) {
      const done = Number(m[1]);
      const total = Number(m[2]);
      if (total > 0 && done <= total) return { done, total };
    }
  }
  return null;
}

function summary(t: Task) {
  let progress: { done: number; total: number; percent: number } | null = null;
  let etaSeconds: number | null = null;
  if (t.status === "running") {
    const p = progressFromLog(t.log);
    if (p) {
      progress = { ...p, percent: Math.round((p.done / p.total) * 100) };
      if (p.done > 0) {
        const elapsed = (Date.now() - new Date(t.startedAt).getTime()) / 1000;
        const rate = p.done / elapsed; // items per second
        if (rate > 0) etaSeconds = Math.round((p.total - p.done) / rate);
      }
    }
  }
  return {
    id: t.id,
    kind: t.kind,
    label: t.label,
    status: t.status,
    startedAt: t.startedAt,
    finishedAt: t.finishedAt ?? null,
    exitCode: t.exitCode ?? null,
    progress,
    etaSeconds,
    etaHuman: etaSeconds === null ? null : formatDuration(etaSeconds),
    log: t.log.slice(-60),
  };
}

function spawnTask(kind: OpsKind, label: string, cwdRel: string, script: string, extraEnv: Record<string, string>) {
  if (running) throw new HttpError(409, `Busy: "${running.label}" is still running. Wait for it to finish.`);
  const t: Task = { id: randomUUID(), kind, label, status: "running", startedAt: new Date().toISOString(), log: [] };
  running = t;
  recent.unshift(t);
  if (recent.length > 20) recent.pop();

  const cwd = resolve(repoRoot(), cwdRel);
  const child = spawn(`corepack pnpm@9.12.0 exec tsx ${script}`, {
    cwd,
    shell: true,
    env: { ...process.env, ...extraEnv },
  });

  // Never let secrets (Aliff password etc.) leak into the captured task log.
  const secrets = Object.entries(extraEnv)
    .filter(([k]) => /PASSWORD|SECRET|TOKEN|API_?KEY/i.test(k))
    .map(([, v]) => v)
    .filter((v) => typeof v === "string" && v.length >= 3);
  const redact = (s: string) => secrets.reduce((acc, sec) => acc.split(sec).join("••••••"), s);

  pushLog(t, `$ (${cwdRel}) tsx ${script}`);
  child.stdout?.on("data", (d) => pushLog(t, redact(d.toString())));
  child.stderr?.on("data", (d) => pushLog(t, redact(d.toString())));
  child.on("close", (code) => {
    t.status = code === 0 ? "success" : "error";
    t.exitCode = code ?? -1;
    t.finishedAt = new Date().toISOString();
    if (running === t) running = null;
  });
  child.on("error", (err) => {
    pushLog(t, `SPAWN ERROR: ${err.message}`);
    t.status = "error";
    t.finishedAt = new Date().toISOString();
    if (running === t) running = null;
  });
  return summary(t);
}

const HEAP = "--max-old-space-size=4096";

export function runExportUniversity() {
  // Audience = "international" → only international-entry university pages (INTL_ONLY).
  // Audience = "all" → all eligibility/admission university pages.
  const audience = readSetting("AUDIENCE") || "international";
  return spawnTask(
    "export-university",
    `Validate + export UNIVERSITY links (${audience})`,
    "apps/crawler",
    "src/recheck.ts",
    {
      INTL_ONLY: audience === "all" ? "" : "1",
      LEVEL: "university",
      AUDIENCE: audience,
      NODE_OPTIONS: HEAP,
    },
  );
}

export function runExportCourses() {
  // Audience steers which VARIANT of a course page ships when both exist:
  // "international" prefers …/international/courses/x, "all" the general page.
  const audience = readSetting("AUDIENCE") || "international";
  return spawnTask("export-courses", `Validate + export COURSE links (${audience})`, "apps/crawler", "src/recheck.ts", {
    INTL_ONLY: "",
    LEVEL: "course",
    AUDIENCE: audience,
    NODE_OPTIONS: HEAP,
  });
}

/**
 * Split the validated FINAL files into SEPARATE per-university files (+ one
 * combined "ALL" workbook), each stamped with the machine's local export time.
 * Additive only — the canonical *-FINAL files are untouched.
 */
export function runExportByUniversity() {
  return spawnTask("export-by-university", "Export per-university files (+ combined, timestamped)", "apps/crawler", "src/export-by-university.ts", {
    NODE_OPTIONS: HEAP,
  });
}

export function runTransform() {
  return spawnTask("transform", "Build Aliff input files (universities + courses)", "tools/aliff-automation", "src/transform-input.ts", {});
}

export interface AliffOpts {
  process: "universities" | "courses" | "both";
  dryRun: boolean;
  overwrite: boolean;
  limit: number;
  headless: boolean;
  email: string;
  password: string;
}

/** The Aliff input files produced by "Build Aliff input files" (Step 2). */
const ALIFF_DATA_DIR = resolve(repoRoot(), "tools", "aliff-automation", "data");
const ALIFF_INPUT = {
  universities: resolve(ALIFF_DATA_DIR, "aliff-input-universities-international.xlsx"),
  courses: resolve(ALIFF_DATA_DIR, "aliff-input-courses-international.xlsx"),
};

/** Which Aliff input files have been built — drives the dashboard readiness hint. */
export function aliffInputsStatus() {
  return {
    universities: existsSync(ALIFF_INPUT.universities),
    courses: existsSync(ALIFF_INPUT.courses),
  };
}

/** Friendly precondition: the required input file(s) for this run must exist. */
function assertAliffInputs(process: AliffOpts["process"]) {
  const needed: string[] = [];
  if (process !== "courses" && !existsSync(ALIFF_INPUT.universities)) needed.push("Universities");
  if (process !== "universities" && !existsSync(ALIFF_INPUT.courses)) needed.push("Courses");
  if (needed.length > 0) {
    throw new HttpError(
      400,
      `Input files not built yet (${needed.join(" + ")}). Run Step 1 “Validate & export links”, then Step 2 “Build Aliff input files”, then try again.`,
    );
  }
}

export function runAliff(o: AliffOpts) {
  assertAliffInputs(o.process);
  const mode = o.dryRun ? "DRY-RUN" : "LIVE";
  return spawnTask("aliff", `Aliff auto-fill · ${o.process} · ${mode} · limit ${o.limit || "all"}`, "tools/aliff-automation", "src/main.ts", {
    PROCESS: o.process,
    DRY_RUN: String(o.dryRun),
    OVERWRITE: String(o.overwrite),
    LIMIT: String(o.limit || 0),
    HEADLESS: String(o.headless),
    ALIFF_EMAIL: o.email,
    ALIFF_PASSWORD: o.password,
  });
}

/**
 * Save an uploaded file into the Aliff input slot (universities or courses).
 * Accepts .xlsx or .csv. Overwrites whatever was previously there so the
 * automation always picks up the freshly uploaded file.
 */
export function uploadAliffInput(
  target: "universities" | "courses",
  originalName: string,
  buffer: Buffer,
): { target: "universities" | "courses"; savedAs: string; bytes: number } {
  const ext = extname(originalName).toLowerCase();
  if (ext !== ".xlsx" && ext !== ".csv") {
    throw new HttpError(400, `Unsupported file type "${ext}". Upload an .xlsx or .csv file.`);
  }
  if (buffer.length === 0) throw new HttpError(400, "Uploaded file is empty.");
  if (buffer.length > 50 * 1024 * 1024) throw new HttpError(413, "File too large (max 50 MB).");

  mkdirSync(ALIFF_DATA_DIR, { recursive: true });

  const base =
    target === "universities"
      ? "aliff-input-universities-international"
      : "aliff-input-courses-international";

  // Always write to the exact extension the user uploaded so nothing is
  // silently converted. Also overwrite the xlsx slot (the canonical path the
  // automation reads) so aliffInputsStatus() immediately turns green.
  const dest = resolve(ALIFF_DATA_DIR, `${base}${ext}`);
  writeFileSync(dest, buffer);

  // If the user uploaded a csv, also write it as xlsx so the automation's
  // default xlsx lookup finds it immediately (it's still the raw csv bytes —
  // the automation's read-excel.ts handles both).
  if (ext === ".csv") {
    writeFileSync(resolve(ALIFF_DATA_DIR, `${base}.xlsx`), buffer);
  }

  return { target, savedAs: `${base}${ext}`, bytes: buffer.length };
}

/** Current state of both Aliff input slots (exists, size, last-modified). */
export function aliffInputsMeta() {
  const slot = (key: "universities" | "courses") => {
    const file = ALIFF_INPUT[key];
    // Also check the csv variant in case only that was uploaded.
    const csvFile = file.replace(/\.xlsx$/, ".csv");
    const found = existsSync(file) ? file : existsSync(csvFile) ? csvFile : null;
    if (!found) return { exists: false, bytes: 0, mtime: null as string | null, name: null as string | null };
    const s = statSync(found);
    return { exists: true, bytes: s.size, mtime: s.mtime.toISOString(), name: found.split("/").pop() ?? null };
  };
  return { universities: slot("universities"), courses: slot("courses") };
}

export function getStatus() {
  return { running: running ? summary(running) : null, recent: recent.map(summary) };
}
