#!/usr/bin/env node
/**
 * CLG Search — commercial packaging pipeline.
 *
 * Produces a SOURCE-FREE distribution at dist/CLG-Search/ that a customer can run
 * locally but cannot read or modify:
 *
 *   dist/CLG-Search/
 *   ├── CLG Search.exe        ← one-click launcher (compiled C#)
 *   ├── license.dat            ← per-company license (placeholder until issued)
 *   ├── LICENSE.txt            ← license agreement
 *   ├── README.txt             ← customer guide
 *   ├── Machine ID.cmd         ← prints this PC's Machine ID for activation
 *   ├── runtime/
 *   │   ├── launch.cjs         ← orchestrator (starts services, opens browser)
 *   │   ├── node/              ← portable Node runtime  (step: node)
 *   │   ├── api/server.cjs     ← OUR backend, bundled + minified (no .ts)
 *   │   ├── crawler/main.cjs   ← OUR crawler, bundled + minified (no .ts)
 *   │   ├── web/               ← Next.js standalone (compiled, no source)
 *   │   ├── prisma/            ← schema + sql for first-run DB setup
 *   │   └── .env               ← runtime config (ports, enforcement on)
 *   └── vendor/                ← (optional) portable postgres/ and redis/
 *
 * Why this hides the source: esbuild INLINES every @clg/* workspace package into a
 * single minified .cjs per app, and keeps only third-party npm packages external.
 * The customer never receives any .ts, src/, .git, or readable application logic.
 *
 * Usage:
 *   node tools/package/build-dist.mjs                 # all steps
 *   node tools/package/build-dist.mjs --only=bundle,launcher,assets
 *   node tools/package/build-dist.mjs --skip=web,deps,node
 *
 * Steps: clean, bundle, web, deps, prisma, node, launcher, assets, verify
 */
import { execSync, spawnSync } from "node:child_process";
import { rmSync, mkdirSync, cpSync, existsSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const DIST = resolve(ROOT, "dist", "CLG-Search");
const RUNTIME = join(DIST, "runtime");
const PNPM = "corepack pnpm@9.12.0";

const argv = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v ?? "true"];
}));
const ALL = ["clean", "bundle", "web", "deps", "prisma", "node", "launcher", "assets", "verify"];
const only = argv.only ? argv.only.split(",") : null;
const skip = argv.skip ? argv.skip.split(",") : [];
const steps = (only ?? ALL).filter((s) => !skip.includes(s));
const want = (s) => steps.includes(s);

const log = (m) => console.log(`\n▶ ${m}`);
const sh = (cmd, opts = {}) => execSync(cmd, { stdio: "inherit", cwd: ROOT, ...opts });

/** Locate Prisma's generated client (.prisma dir) — top-level or in the pnpm store. */
function findGeneratedPrisma() {
  const top = resolve(ROOT, "node_modules/.prisma");
  if (existsSync(join(top, "client"))) return top;
  const store = resolve(ROOT, "node_modules/.pnpm");
  if (existsSync(store)) {
    for (const d of readdirSync(store)) {
      if (d.startsWith("@prisma+client@")) {
        const cand = join(store, d, "node_modules", ".prisma");
        if (existsSync(join(cand, "client"))) return cand;
      }
    }
  }
  return null;
}

// ───────────────────────────── doc bodies ────────────────────────
const LICENSE_TXT = `CLG SEARCH — END USER LICENSE AGREEMENT
(Template — have a lawyer review and finalize before any commercial sale.)

1. LICENSE, NOT SALE. This software ("CLG Search") is licensed, not sold. The
   vendor retains all ownership, copyright, and intellectual property rights.

2. GRANT. Subject to payment and these terms, the vendor grants the purchasing
   company a non-exclusive, non-transferable license to install and use CLG Search
   on the agreed number of computers for its internal business purposes.

3. RESTRICTIONS. The customer shall NOT: (a) copy, resell, sublicense, rent, lease,
   distribute, or share the software; (b) reverse engineer, decompile, or attempt to
   derive source code, except to the extent this restriction is prohibited by
   applicable law; (c) remove or alter any proprietary notices; (d) use the software
   beyond the licensed number of machines or after license expiry.

4. NO SOURCE CODE. No source code, build tooling, or repository is provided. The
   customer receives compiled/bundled executables only.

5. LICENSE KEY & ACTIVATION. The software is activated by a vendor-issued license
   file (license.dat) which may be bound to a specific machine. Copying the software
   to an unlicensed machine will not activate.

6. TERM & EXPIRY. If the license has an expiry date, the software stops operating on
   expiry. Renewal is available from the vendor. Updates and support are provided per
   the purchased plan.

7. WARRANTY DISCLAIMER. The software is provided "AS IS" without warranty of any kind.

8. LIMITATION OF LIABILITY. To the maximum extent permitted by law, the vendor is not
   liable for any indirect or consequential damages arising from use of the software.

9. GOVERNING LAW. [Specify jurisdiction with your lawyer.]

By installing or using CLG Search, the customer agrees to these terms.
`;

const README_TXT = `CLG SEARCH — Quick Start
========================

WHAT YOU RECEIVED
  • CLG Search.exe   — double-click to start the application
  • license.dat      — your license (provided by your vendor)
  • Machine ID.cmd   — shows this PC's Machine ID (needed for activation)

FIRST-TIME ACTIVATION
  1. Double-click "Machine ID.cmd" and copy the Machine ID shown.
  2. Email that Machine ID to your vendor.
  3. The vendor sends you a license.dat file.
  4. Put license.dat in this folder, next to "CLG Search.exe" (replace the
     placeholder file already there).

REQUIREMENTS
  • Windows 10/11, 64-bit. Nothing else to install — the database, cache, browser
    and runtime are all included in this folder.
  • (Optional) Ollama for AI-assisted extraction. Without it, a built-in rule-based
    extractor is used automatically.

RUNNING
  • Double-click "CLG Search.exe". The first start takes a minute while it sets up
    the local database. A window opens and the dashboard launches in your browser at
    http://localhost:3100.
  • To stop, close that window.

SUPPORT
  • Contact your vendor for support, updates, and additional licenses.

This software is licensed, not sold. See LICENSE.txt.
`;

// ───────────────────────────── clean ─────────────────────────────
if (want("clean")) {
  log("clean — removing previous dist");
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(RUNTIME, { recursive: true });
}

// ───────────────────────────── bundle (the IP-hiding step) ────────
if (want("bundle")) {
  log("bundle — esbuild: inline @clg/* source, minify, keep npm deps external");
  const esbuild = await import("esbuild");
  // Inline our workspace packages (hides source); externalize everything else.
  const externalizeNpm = {
    name: "externalize-npm",
    setup(build) {
      build.onResolve({ filter: /^[^./]/ }, (args) => {
        if (args.kind === "entry-point") return null;    // never externalize the entry
        if (isAbsolute(args.path)) return null;          // absolute paths (Windows drive) → bundle
        if (args.path.startsWith("@clg/")) return null;  // bundle our code
        return { path: args.path, external: true };      // npm + node builtins stay external
      });
    },
  };
  const common = {
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    minify: true,
    legalComments: "none",
    sourcemap: false,
    plugins: [externalizeNpm],
    logLevel: "warning",
    banner: { js: "/* CLG Search — proprietary. Licensed, not sold. (c) CLG Search */" },
  };
  mkdirSync(join(RUNTIME, "api"), { recursive: true });
  mkdirSync(join(RUNTIME, "crawler"), { recursive: true });
  await esbuild.build({ ...common, entryPoints: [resolve(ROOT, "apps/api/src/server.ts")], outfile: join(RUNTIME, "api", "server.cjs") });
  await esbuild.build({ ...common, entryPoints: [resolve(ROOT, "apps/crawler/src/main.ts")], outfile: join(RUNTIME, "crawler", "main.cjs") });
  console.log("  ✓ api/server.cjs and crawler/main.cjs written (minified, no .ts)");
}

// ───────────────────────────── web (Next.js standalone) ──────────
if (want("web")) {
  log("web — next build (standalone) then copy compiled output");
  // Bake the correct local API URL into the compiled dashboard (matches API_PORT).
  sh(`${PNPM} --filter @clg/web build`, { env: { ...process.env, NEXT_PUBLIC_API_URL: "http://localhost:4100" } });
  const std = resolve(ROOT, "apps/web/.next/standalone");
  if (!existsSync(std)) throw new Error("next standalone output missing — is output:'standalone' set?");
  const webOut = join(RUNTIME, "web");
  mkdirSync(webOut, { recursive: true });
  // standalone server + its trimmed node_modules + package.json
  cpSync(std, webOut, { recursive: true });
  // static assets + public are not in standalone; copy alongside server
  const apps = join(webOut, "apps", "web");
  const target = existsSync(apps) ? apps : webOut; // monorepo standalone nests under apps/web
  cpSync(resolve(ROOT, "apps/web/.next/static"), join(target, ".next", "static"), { recursive: true });
  if (existsSync(resolve(ROOT, "apps/web/public"))) cpSync(resolve(ROOT, "apps/web/public"), join(target, "public"), { recursive: true });
  console.log("  ✓ web standalone copied (compiled, no page source)");
}

// ───────────────────────────── deps (production node_modules) ─────
if (want("deps")) {
  log("deps — assembling production node_modules for api & crawler (pnpm deploy)");
  for (const app of [["api", "@clg/api"], ["crawler", "@clg/crawler"]]) {
    const [dir, pkg] = app;
    // Deploy OUTSIDE OneDrive — pnpm's atomic renames hit ERR_PNPM_EBUSY when the
    // target is a synced folder. Build in the OS temp dir, then copy the result in.
    //
    // node-linker=hoisted makes a FLAT node_modules (every package at top level).
    // This is essential: we strip our inlined @clg/* packages, so the bundle must be
    // able to resolve their former transitive deps (@prisma/client, bullmq, ioredis)
    // directly from the app's node_modules root.
    const tmp = join(tmpdir(), `clg-deploy-${dir}-${process.pid}`);
    rmSync(tmp, { recursive: true, force: true });
    sh(`${PNPM} --filter ${pkg} deploy --prod "${tmp}"`, {
      env: { ...process.env, npm_config_node_linker: "hoisted" },
    });
    const nm = join(tmp, "node_modules");
    if (!existsSync(nm)) throw new Error(`deploy produced no node_modules for ${pkg}`);
    // Drop our workspace packages from node_modules — they are already inlined in the .cjs.
    rmSync(join(nm, "@clg"), { recursive: true, force: true });
    // Prisma's generated client + native query engine must be present. With pnpm it
    // lives in the store under .pnpm/@prisma+client*/node_modules/.prisma — find and copy.
    const genPrisma = findGeneratedPrisma();
    if (!genPrisma) throw new Error("generated Prisma client not found — run `pnpm --filter @clg/database exec prisma generate` first");
    cpSync(genPrisma, join(nm, ".prisma"), { recursive: true });
    console.log(`    prisma client copied from ${genPrisma}`);
    cpSync(nm, join(RUNTIME, dir, "node_modules"), { recursive: true });
    rmSync(tmp, { recursive: true, force: true });
    console.log(`  ✓ ${dir}/node_modules ready (workspace source stripped, prisma client included)`);
  }
}

// ───────────────────────────── prisma (schema for first run) ──────
if (want("prisma")) {
  log("prisma — copying schema + constraints for first-run DB setup");
  const out = join(RUNTIME, "prisma");
  mkdirSync(out, { recursive: true });
  // Copy only what first-run DB setup needs (schema + raw SQL + migrations); never
  // ship .ts source such as seed.ts.
  cpSync(resolve(ROOT, "packages/database/prisma"), out, {
    recursive: true,
    filter: (src) => !/\.(ts|tsx)$/.test(src),
  });
  console.log("  ✓ prisma schema + sql copied (no .ts)");
}

// ───────────────────────────── node (portable runtime) ───────────
if (want("node")) {
  log("node — copying a portable Node runtime");
  const nodeExe = process.execPath; // C:\Program Files\nodejs\node.exe
  const nodeDir = dirname(nodeExe);
  const out = join(RUNTIME, "node");
  mkdirSync(out, { recursive: true });
  cpSync(nodeExe, join(out, "node.exe"));
  // node.exe is self-contained on Windows; copy ICU/other dll siblings if present.
  for (const f of readdirSync(nodeDir)) {
    if (/\.(dll)$/i.test(f)) cpSync(join(nodeDir, f), join(out, f));
  }
  console.log("  ✓ portable node.exe copied");
}

// ───────────────────────────── launcher (compile C# .exe) ────────
if (want("launcher")) {
  log("launcher — compiling 'CLG Search.exe' (csc.exe) + copying orchestrator");
  cpSync(resolve(HERE, "launcher", "launch.cjs"), join(RUNTIME, "launch.cjs"));
  const csc = "C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe";
  const exeOut = join(DIST, "CLG Search.exe");
  if (existsSync(csc)) {
    const r = spawnSync(csc, ["/nologo", "/target:exe", "/platform:anycpu", `/out:${exeOut}`, resolve(HERE, "launcher", "Launcher.cs")], { stdio: "inherit" });
    if (r.status !== 0) throw new Error("csc failed to compile the launcher");
    console.log("  ✓ 'CLG Search.exe' compiled");
  } else {
    console.warn("  ! csc.exe not found — writing a .cmd launcher fallback");
    writeFileSync(join(DIST, "CLG Search.cmd"), `@echo off\r\ntitle CLG Search\r\n"%~dp0runtime\\node\\node.exe" "%~dp0runtime\\launch.cjs"\r\npause\r\n`);
  }
}

// ───────────────────────────── assets (config, license, docs) ────
if (want("assets")) {
  log("assets — .env, license placeholder, agreement, README, Machine ID tool");
  writeFileSync(join(RUNTIME, ".env"), [
    "# CLG Search runtime configuration (safe to edit ports only).",
    "NODE_ENV=production",
    "LICENSE_ENFORCE=true",
    "AUTO_START_CRAWLER=false",
    "API_PORT=4100",
    "WEB_PORT=3100",
    "DATABASE_URL=postgresql://clg:clg@127.0.0.1:5433/clg?schema=public",
    "REDIS_URL=redis://127.0.0.1:6380",
    "OLLAMA_BASE_URL=http://127.0.0.1:11434",
    "CRAWL_CONCURRENCY=2",
    "PARSE_CONCURRENCY=1",
    "",
  ].join("\r\n"));

  writeFileSync(join(DIST, "license.dat"), "PLACEHOLDER — replace with the license.dat issued by your vendor.\r\n");

  // Machine ID helper for the customer (uses the bundled node). Keep the .mjs
  // extension — the file uses ESM import syntax and must not be run as CommonJS.
  writeFileSync(join(DIST, "Machine ID.cmd"),
    `@echo off\r\n"%~dp0runtime\\node\\node.exe" "%~dp0runtime\\machine-id.mjs"\r\npause\r\n`);
  cpSync(resolve(ROOT, "tools/licensing/machine-id.mjs"), join(RUNTIME, "machine-id.mjs"));

  // Docs (written by writeDocs() below to keep this file readable).
  writeFileSync(join(DIST, "LICENSE.txt"), LICENSE_TXT);
  writeFileSync(join(DIST, "README.txt"), README_TXT);
  console.log("  ✓ assets written");
}

// ───────────────────────────── verify (no source leaked) ─────────
if (want("verify")) {
  log("verify — scanning dist for leaked source");
  const bad = [];
  // Skip third-party trees: our npm deps (node_modules) and bundled service
  // binaries (vendor/) are not CLG Search source — only OUR code must be source-free.
  const skipDirs = new Set(["node_modules", "vendor"]);
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const s = statSync(p);
      if (s.isDirectory()) { if (!skipDirs.has(name)) walk(p); continue; }
      if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) bad.push(p);
      if (name === ".git" || name === ".gitignore") bad.push(p);
    }
  };
  if (existsSync(DIST)) walk(DIST);
  if (bad.length) {
    console.error("  ✗ source-like files found in dist:\n" + bad.map((b) => "    " + b).join("\n"));
    process.exitCode = 1;
  } else {
    console.log("  ✓ no .ts/source/.git found outside node_modules — distribution is source-free");
  }
}

log(`done — steps run: ${steps.join(", ")}`);
console.log(`  output: ${DIST}`);
