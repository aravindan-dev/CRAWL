/**
 * CLG Search — runtime orchestrator (shipped to customers as runtime/launch.cjs).
 *
 * Plain Node, zero dependencies. Started by "CLG Search.exe". It boots the local
 * services in order, waits for the dashboard, then opens the browser. All product
 * logic lives in the bundled (minified) api/web — this file only orchestrates.
 *
 *   vendored Postgres ─┐
 *   vendored Redis  ───┼─▶ API ─▶ Web dashboard ─▶ open browser
 *                      ┘
 *
 * Licensing is no longer this script's concern: the API stays up even with an
 * invalid/missing license (it just 403s business routes), and the dashboard
 * itself shows the lock screen with the machine fingerprint + an activation
 * form (see packages/license/ + apps/web/app/license/). This only watches for
 * the API failing to start AT ALL (e.g. a genuine crash), which is unrelated.
 */
const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");

const RUNTIME = __dirname;
const ROOT = path.resolve(RUNTIME, "..");
const NODE = process.execPath; // the node.exe that launched us (portable or system)

// ---- config (env wins; sensible local defaults otherwise) -------------------
function readEnvFile(p) {
  const out = {};
  try {
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* no .env */ }
  return out;
}
const fileEnv = readEnvFile(path.join(RUNTIME, ".env"));
const cfg = { ...fileEnv, ...process.env };
const API_PORT = Number(cfg.API_PORT || 4100);
const WEB_PORT = Number(cfg.WEB_PORT || 3100);

const children = [];
function run(name, cmd, args, opts = {}) {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
  child.stdout?.on("data", (d) => process.stdout.write(`[${name}] ${d}`));
  child.stderr?.on("data", (d) => process.stderr.write(`[${name}] ${d}`));
  children.push({ name, child });
  return child;
}

function waitForHttp(port, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 1500 }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on("error", () => (Date.now() > deadline ? resolve(false) : setTimeout(tick, 800)));
      req.on("timeout", () => { req.destroy(); Date.now() > deadline ? resolve(false) : setTimeout(tick, 800); });
    };
    tick();
  });
}

function openBrowser(url) {
  if (process.platform === "win32") spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  else if (process.platform === "darwin") spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  else spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

function shutdown() {
  for (const { child } of children) {
    try {
      if (process.platform === "win32") spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
      else process.kill(-child.pid);
    } catch { /* gone */ }
  }
  stopPostgres(); // graceful DB shutdown so the data dir stays clean
  setTimeout(() => process.exit(0), 1200);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ---- optional vendored services --------------------------------------------
function startRedis() {
  const redisExe = path.join(ROOT, "vendor", "redis", "redis-server.exe");
  const redisConf = path.join(ROOT, "vendor", "redis", "redis.conf");
  if (!fs.existsSync(redisExe)) return;
  run("redis", redisExe, fs.existsSync(redisConf) ? [redisConf] : ["--port", String(cfg.REDIS_PORT || 6380)],
    { cwd: path.dirname(redisExe) });
}

const pgBin = (name) => path.join(ROOT, "vendor", "postgres", "bin", `${name}.exe`);
const PG_PORT = String(cfg.PG_PORT || 5433);

/** Initialize Postgres on first run (initdb + create DB + apply schema), then start it. */
async function setupPostgres() {
  if (!fs.existsSync(pgBin("pg_ctl"))) return false; // not vendored — assume external/Docker
  const base = path.join(ROOT, "vendor", "postgres");
  const data = path.join(base, "data");
  const env = { ...process.env, PGPASSWORD: "clg" };
  const firstRun = !fs.existsSync(data);

  if (firstRun) {
    console.log("  First run: initializing the local database (one-time)…");
    const pwfile = path.join(base, "pw.txt");
    fs.writeFileSync(pwfile, "clg");
    spawnSync(pgBin("initdb"), ["-D", data, "-U", "clg", "-A", "md5", "--pwfile", pwfile, "-E", "UTF8"], { stdio: "inherit" });
    fs.rmSync(pwfile, { force: true });
    fs.appendFileSync(path.join(data, "postgresql.conf"), `\nport = ${PG_PORT}\nlisten_addresses = '127.0.0.1'\n`);
  }

  spawnSync(pgBin("pg_ctl"), ["-D", data, "-w", "-l", path.join(base, "pg.log"), "start"], { stdio: "inherit" });
  await new Promise((r) => setTimeout(r, 1500));

  if (firstRun) {
    spawnSync(pgBin("createdb"), ["-h", "127.0.0.1", "-p", PG_PORT, "-U", "clg", "clg"], { stdio: "inherit", env });
    const schemaSql = path.join(RUNTIME, "prisma", "schema.sql");
    const constraints = path.join(RUNTIME, "prisma", "sql", "constraints.sql");
    const psql = (file) => spawnSync(pgBin("psql"), ["-h", "127.0.0.1", "-p", PG_PORT, "-U", "clg", "-d", "clg", "-v", "ON_ERROR_STOP=0", "-f", file], { stdio: "inherit", env });
    if (fs.existsSync(schemaSql)) psql(schemaSql);
    if (fs.existsSync(constraints)) psql(constraints);
    console.log("  Database ready.");
  }
  return true;
}

function stopPostgres() {
  if (!fs.existsSync(pgBin("pg_ctl"))) return;
  try { spawnSync(pgBin("pg_ctl"), ["-D", path.join(ROOT, "vendor", "postgres", "data"), "-m", "fast", "stop"], { stdio: "ignore" }); } catch { /* ignore */ }
}

async function main() {
  console.log("\n  CLG Search — starting local services…\n");
  const sharedEnv = {
    ...process.env,
    STORAGE_ROOT: RUNTIME,
    PACKAGED: "true", // tells the API to spawn the bundled crawler (crawler/main.cjs)
  };
  // Use the vendored Chromium for Playwright if present (so the customer needs no install).
  const chromium = path.join(ROOT, "vendor", "chromium");
  if (fs.existsSync(chromium)) sharedEnv.PLAYWRIGHT_BROWSERS_PATH = chromium;

  startRedis();
  await setupPostgres();
  await new Promise((r) => setTimeout(r, 500));

  // API — always starts even with an invalid/missing license (the dashboard's
  // lock screen handles that case). A fast, non-zero exit here means a real
  // startup failure (DB unreachable, port in use, etc.), not a license issue.
  const api = run("api", NODE, [path.join(RUNTIME, "api", "server.cjs")], {
    cwd: path.join(RUNTIME, "api"),
    env: sharedEnv,
  });
  let apiExited = null;
  api.on("exit", (code) => { apiExited = code; });

  await new Promise((r) => setTimeout(r, 4000));
  if (apiExited !== null && apiExited !== 0) {
    console.error("\n  ──────────────────────────────────────────────");
    console.error("  CLG Search could not start (the API exited unexpectedly).");
    console.error("  Check the [api] log lines above for the reason.");
    console.error("  ──────────────────────────────────────────────\n");
    await new Promise((r) => setTimeout(r, 60_000));
    process.exit(2);
  }

  // Web dashboard (Next.js standalone server).
  run("web", NODE, [path.join(RUNTIME, "web", "server.js")], {
    cwd: path.join(RUNTIME, "web"),
    env: { ...sharedEnv, PORT: String(WEB_PORT), HOSTNAME: "127.0.0.1" },
  });

  const url = `http://localhost:${WEB_PORT}`;
  console.log(`  Waiting for the dashboard at ${url} …`);
  const up = await waitForHttp(WEB_PORT, 90_000);
  if (up) { console.log("  Dashboard ready — opening your browser.\n"); openBrowser(url); }
  else console.log("  Dashboard is taking a while; open " + url + " manually.\n");

  console.log("  CLG Search is running. Close this window to stop.\n");
}

main().catch((err) => {
  console.error("Launcher error:", err);
  setTimeout(() => process.exit(1), 30_000);
});
