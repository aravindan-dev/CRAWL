#!/usr/bin/env node
/**
 * SELLER TOOL — build the three Server Edition images (source-free, see
 * Dockerfile.api/.crawler/.web) and push them to your private registry.
 * Run on YOUR machine only. The customer's server only ever runs `docker
 * compose pull` against docker-compose.server-edition.yml — it never sees
 * this script, the Dockerfiles, or the source they build from.
 *
 * Usage:
 *   node tools/package/docker/build-and-push.mjs \
 *     --registry ghcr.io/your-github-username \
 *     --tag v1.0.0 \
 *     --api-url http://203.0.113.10:4100
 *
 *   --registry   required. Where to push (e.g. ghcr.io/<user>, or docker.io/<user>).
 *                Run `docker login <registry>` yourself first.
 *   --tag        image tag (default: "latest"). Use a real version per release
 *                so you can roll a customer back if an update misbehaves.
 *   --api-url    required for the web image. The PUBLIC address the customer's
 *                browser will use to reach the API (their server's IP/domain +
 *                API_PORT). Next.js bakes this in at BUILD time — it cannot be
 *                changed later without rebuilding the web image.
 *   --push       actually push after building (default: build only, so you can
 *                smoke-test locally first with `docker run` before shipping).
 *   --skip-schema  don't regenerate pg-init/*.sql from the current Prisma schema.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..");

const argv = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1]?.startsWith("--") || arr[i + 1] === undefined ? "true" : arr[i + 1]]);
    return acc;
  }, []),
);

const registry = argv.registry;
if (!registry) { console.error("ERROR: --registry is required, e.g. --registry ghcr.io/your-github-username"); process.exit(1); }
const tag = argv.tag || "latest";
const apiUrl = argv["api-url"] || "http://localhost:4100";
const doPush = argv.push === "true";

const sh = (cmd) => execSync(cmd, { stdio: "inherit", cwd: ROOT });

console.log(`\nBuilding CLG Search — Server Edition images`);
console.log(`  registry : ${registry}`);
console.log(`  tag      : ${tag}`);
console.log(`  api-url  : ${apiUrl} (baked into the web image — must match where this customer will actually reach the API)`);
console.log(`  push     : ${doPush}\n`);

// ── Keep pg-init/*.sql in sync with the current Prisma schema (first-run DB
// init for the customer's Postgres container) ──────────────────────────────
if (argv["skip-schema"] !== "true") {
  console.log("▶ regenerating pg-init/*.sql from the current Prisma schema");
  sh(`corepack pnpm@9.12.0 --filter @clg/database run schema:sql`);
  const pgInit = resolve(HERE, "pg-init");
  mkdirSync(pgInit, { recursive: true });
  copyFileSync(resolve(ROOT, "packages/database/prisma/schema.sql"), resolve(pgInit, "01-schema.sql"));
  copyFileSync(resolve(ROOT, "packages/database/prisma/sql/constraints.sql"), resolve(pgInit, "02-constraints.sql"));
  console.log("  ✓ pg-init/01-schema.sql, pg-init/02-constraints.sql written\n");
}

// ── Build ────────────────────────────────────────────────────────────────
const images = [
  { name: "clg-api", dockerfile: "tools/package/docker/Dockerfile.api", extraArgs: "" },
  { name: "clg-crawler", dockerfile: "tools/package/docker/Dockerfile.crawler", extraArgs: "" },
  { name: "clg-web", dockerfile: "tools/package/docker/Dockerfile.web", extraArgs: `--build-arg NEXT_PUBLIC_API_URL=${apiUrl}` },
];

for (const img of images) {
  const ref = `${registry}/${img.name}:${tag}`;
  console.log(`▶ building ${ref}`);
  sh(`docker build -f ${img.dockerfile} ${img.extraArgs} -t ${ref} .`);
  console.log(`  ✓ ${ref} built\n`);
}

// ── Verify: no source leaked into any of the three images ─────────────────
console.log("▶ verifying no source leaked into the built images");
for (const img of images) {
  const ref = `${registry}/${img.name}:${tag}`;
  try {
    execSync(
      `docker run --rm --entrypoint sh ${ref} -c "find / -xdev \\( -name '*.ts' -o -name '*.tsx' -o -name '.git' \\) 2>/dev/null | grep -v node_modules"`,
      { stdio: "pipe" },
    );
    console.error(`  ✗ ${ref}: source-like files found — DO NOT SHIP THIS IMAGE`);
    process.exitCode = 1;
  } catch {
    // grep found nothing → non-zero exit → execSync throws → this IS the clean case.
    console.log(`  ✓ ${ref} is source-free`);
  }
}
if (process.exitCode === 1) { console.error("\nAborting — fix the leak before pushing."); process.exit(1); }

// ── Push ────────────────────────────────────────────────────────────────
if (doPush) {
  for (const img of images) {
    const ref = `${registry}/${img.name}:${tag}`;
    console.log(`\n▶ pushing ${ref}`);
    sh(`docker push ${ref}`);
  }
  console.log(`\n✓ Pushed. On the customer's server: set REGISTRY=${registry} and IMAGE_TAG=${tag} in .env, then\n  docker compose -f docker-compose.server-edition.yml pull && docker compose -f docker-compose.server-edition.yml up -d`);
} else {
  console.log(`\nBuilt locally, not pushed (pass --push to push). Smoke-test with:\n  docker run --rm ${registry}/clg-api:${tag}`);
}
