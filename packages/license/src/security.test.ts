import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function walk(dir: string, skipDirs: Set<string>, onFile: (path: string) => void): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (!skipDirs.has(name)) walk(p, skipDirs, onFile);
    } else {
      onFile(p);
    }
  }
}

describe("license signing key never leaks", () => {
  it(".dockerignore excludes tools/license-admin and private.pem from every Docker build context", () => {
    const ignore = readFileSync(join(REPO_ROOT, ".dockerignore"), "utf8");
    expect(ignore).toMatch(/tools\/license-admin/);
    expect(ignore).toMatch(/\*\*\/private\.pem|private\.pem/);
  });

  it('no PEM private key material ("PRIVATE KEY") appears anywhere under apps/ or packages/', () => {
    const offenders: string[] = [];
    const skip = new Set(["node_modules", "dist", ".next", ".turbo", "coverage", ".git"]);
    for (const top of ["apps", "packages"]) {
      walk(join(REPO_ROOT, top), skip, (path) => {
        if (path.endsWith(".test.ts") || path.endsWith(".test.tsx")) return; // fixtures may legitimately name the string
        if (!/\.(ts|tsx|js|mjs|cjs|json)$/.test(path)) return;
        const content = readFileSync(path, "utf8");
        if (content.includes("PRIVATE KEY")) offenders.push(path);
      });
    }
    expect(offenders).toEqual([]);
  });
});
