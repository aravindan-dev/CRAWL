import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve, isAbsolute } from "node:path";
import type { StorageProvider } from "./StorageProvider.js";
import { repoRoot } from "./root.js";

/**
 * Filesystem-backed StorageProvider. All relative paths are resolved against a
 * configurable root (defaults to the process CWD), so the same logical paths
 * (e.g. `screenshots/{id}/{hash}.png`) work in dev and in Docker where the
 * `./storage` volume is mounted at `/app/storage`.
 */
export class LocalStorageProvider implements StorageProvider {
  private readonly root: string;

  constructor(root: string = repoRoot()) {
    this.root = root;
  }

  private full(path: string): string {
    return isAbsolute(path) ? path : resolve(this.root, path);
  }

  private async ensureDir(filePath: string): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
  }

  async saveText(path: string, content: string): Promise<string> {
    const full = this.full(path);
    await this.ensureDir(full);
    await writeFile(full, content, "utf8");
    return path;
  }

  async saveJson(path: string, data: unknown): Promise<string> {
    return this.saveText(path, JSON.stringify(data, null, 2));
  }

  async saveBuffer(path: string, buffer: Buffer): Promise<string> {
    const full = this.full(path);
    await this.ensureDir(full);
    await writeFile(full, buffer);
    return path;
  }

  async readText(path: string): Promise<string> {
    return readFile(this.full(path), "utf8");
  }

  async exists(path: string): Promise<boolean> {
    try {
      await access(this.full(path), constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}
