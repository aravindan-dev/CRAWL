import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

let cachedRoot: string | null = null;

/**
 * Resolve the monorepo root so every service (api, crawler) reads/writes the
 * SAME `storage/` directory regardless of its process cwd (pnpm filters set cwd
 * to each package). Honors STORAGE_ROOT, else walks up for pnpm-workspace.yaml,
 * else falls back to cwd. In Docker all services run with cwd `/app`, so this
 * resolves there naturally.
 */
export function repoRoot(): string {
  if (cachedRoot) return cachedRoot;
  if (process.env.STORAGE_ROOT) {
    cachedRoot = process.env.STORAGE_ROOT;
    return cachedRoot;
  }
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      cachedRoot = dir;
      return cachedRoot;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cachedRoot = process.cwd();
  return cachedRoot;
}
