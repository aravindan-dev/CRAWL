#!/usr/bin/env node
/**
 * CLG Search — bundle the local services into dist/CLG-Search/vendor/ so the
 * customer needs nothing pre-installed.
 *
 *   vendor/chromium/  ← Playwright browser (copied from this machine's cache)
 *   vendor/redis/     ← Redis for Windows  (downloaded)
 *   vendor/postgres/  ← PostgreSQL binaries (downloaded; data dir created on first run)
 *
 * Also writes runtime/prisma/schema.sql (full CREATE TABLE script) so the launcher
 * can initialize the database on first run without the Prisma CLI.
 *
 * Usage:
 *   node tools/package/bundle-vendor.mjs                 # all
 *   node tools/package/bundle-vendor.mjs --only=chromium,schema
 *   node tools/package/bundle-vendor.mjs --pg-url=<zip>  # override Postgres binaries URL
 */
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const DIST = resolve(ROOT, "dist", "CLG-Search");
const VENDOR = join(DIST, "vendor");
const PNPM = "corepack pnpm@9.12.0";

const argv = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v ?? "true"];
}));
const ALL = ["chromium", "redis", "postgres", "schema"];
const steps = argv.only ? argv.only.split(",") : ALL;
const want = (s) => steps.includes(s);
const log = (m) => console.log(`\n▶ ${m}`);

if (!existsSync(DIST)) throw new Error("dist/CLG-Search not found — run build-dist.mjs first.");
mkdirSync(VENDOR, { recursive: true });

// PowerShell helpers (reliable download + unzip on Windows).
const ps = (script) => execSync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${script.replace(/"/g, '\\"')}"`, { stdio: "inherit" });
function download(url, outFile) {
  console.log(`  downloading ${url}`);
  ps(`$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '${url}' -OutFile '${outFile}'`);
}
function unzip(zip, dest) {
  ps(`$ProgressPreference='SilentlyContinue'; Expand-Archive -Path '${zip}' -DestinationPath '${dest}' -Force`);
}
// If a zip extracts into a single nested folder, lift its contents up to `dir`.
function flatten(dir) {
  const entries = readdirSync(dir);
  if (entries.length === 1 && statSync(join(dir, entries[0])).isDirectory()) {
    const inner = join(dir, entries[0]);
    for (const e of readdirSync(inner)) renameSync(join(inner, e), join(dir, e));
    rmSync(inner, { recursive: true, force: true });
  }
}

// ───────────────────────── chromium (copy from local cache) ──────────────
if (want("chromium")) {
  log("chromium — copying Playwright browser from this machine's cache");
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), "AppData", "Local", "ms-playwright");
  if (!existsSync(cache)) throw new Error(`Playwright cache not found at ${cache}. Run: pnpm --filter @clg/crawler exec playwright install chromium`);
  // Read the exact revisions this Playwright build expects.
  let bj = null;
  const bjPath = readdirSync(resolve(ROOT, "node_modules/.pnpm")).map((d) => resolve(ROOT, "node_modules/.pnpm", d, "node_modules/playwright-core/browsers.json")).find((p) => existsSync(p));
  if (bjPath) bj = JSON.parse(readFileSync(bjPath, "utf8"));
  const rev = (name) => bj?.browsers?.find((b) => b.name === name)?.revision;
  const wanted = [
    `chromium-${rev("chromium") ?? ""}`,
    `chromium_headless_shell-${rev("chromium-headless-shell") ?? ""}`,
    `ffmpeg-${rev("ffmpeg") ?? ""}`,
    `winldd-${rev("winldd") ?? ""}`,
  ].filter((n) => !n.endsWith("-"));
  const out = join(VENDOR, "chromium");
  mkdirSync(out, { recursive: true });
  for (const name of wanted) {
    const src = join(cache, name);
    if (existsSync(src)) { console.log(`  • ${name}`); cpSync(src, join(out, name), { recursive: true }); }
    else console.warn(`  ! ${name} not in cache (skipping)`);
  }
  console.log("  ✓ chromium bundled");
}

// ───────────────────────── redis (download) ──────────────────────────────
if (want("redis")) {
  log("redis — downloading Redis for Windows");
  const tmp = join(tmpdir(), `clg-redis-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  // Resolve the latest .zip asset from redis-windows/redis-windows.
  const apiJson = execSync(`powershell -NoProfile -Command "$ProgressPreference='SilentlyContinue'; (Invoke-WebRequest -UseBasicParsing 'https://api.github.com/repos/redis-windows/redis-windows/releases/latest').Content"`, { encoding: "utf8" });
  const rel = JSON.parse(apiJson);
  const asset = (rel.assets || []).find((a) => /\.zip$/i.test(a.name) && /x64|win/i.test(a.name)) || (rel.assets || []).find((a) => /\.zip$/i.test(a.name));
  if (!asset) throw new Error("no redis .zip asset found in latest release");
  const zip = join(tmp, asset.name);
  download(asset.browser_download_url, zip);
  const out = join(VENDOR, "redis");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  unzip(zip, out);
  flatten(out);
  // Write a minimal redis.conf on our port.
  writeFileSync(join(out, "redis.conf"), `port 6380\r\nsave ""\r\nappendonly no\r\n`);
  rmSync(tmp, { recursive: true, force: true });
  console.log(existsSync(join(out, "redis-server.exe")) ? "  ✓ redis bundled (redis-server.exe present)" : "  ! redis-server.exe not found after extract — check vendor/redis");
}

// ───────────────────────── postgres (download) ───────────────────────────
if (want("postgres")) {
  log("postgres — downloading PostgreSQL binaries");
  const url = argv["pg-url"] || "https://get.enterprisedb.com/postgresql/postgresql-16.4-1-windows-x64-binaries.zip";
  const tmp = join(tmpdir(), `clg-pg-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const zip = join(tmp, "pg.zip");
  download(url, zip);
  const out = join(VENDOR, "postgres");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  unzip(zip, out);
  flatten(out); // EDB zips contain a top-level "pgsql" folder → lift it
  rmSync(tmp, { recursive: true, force: true });
  // Trim what we don't ship: pgAdmin GUI, docs, headers, symbols, installer builder.
  // The runtime only needs bin/, lib/, share/. This removes hundreds of MB (and
  // third-party .ts files from pgAdmin that would otherwise trip the verify step).
  for (const d of ["pgAdmin 4", "doc", "include", "symbols", "stackbuilder"]) {
    rmSync(join(out, d), { recursive: true, force: true });
  }
  console.log(existsSync(join(out, "bin", "initdb.exe")) ? "  ✓ postgres bundled (bin/initdb.exe present, pgAdmin/docs trimmed)" : "  ! initdb.exe not found — check the --pg-url or vendor/postgres layout");
}

// ───────────────────────── schema.sql (for first-run init) ───────────────
if (want("schema")) {
  log("schema — generating full CREATE TABLE script (prisma migrate diff)");
  const schema = resolve(ROOT, "packages/database/prisma/schema.prisma");
  const outSql = join(DIST, "runtime", "prisma", "schema.sql");
  mkdirSync(dirname(outSql), { recursive: true });
  const sql = execSync(`${PNPM} --filter @clg/database exec prisma migrate diff --from-empty --to-schema-datamodel "${schema}" --script`, { cwd: ROOT, encoding: "utf8" });
  writeFileSync(outSql, sql);
  console.log(`  ✓ schema.sql written (${sql.split("\n").length} lines)`);
}

console.log(`\n▶ vendor bundling done — steps: ${steps.join(", ")}`);
console.log(`  output: ${VENDOR}`);
