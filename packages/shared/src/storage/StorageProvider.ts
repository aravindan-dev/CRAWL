/**
 * Storage abstraction. v1 ships LocalStorageProvider; S3/R2 providers can be
 * added later without touching call sites.
 */
export interface StorageProvider {
  /** Write UTF-8 text. Returns the stored path/key. */
  saveText(path: string, content: string): Promise<string>;
  /** Write a JSON-serialized value. Returns the stored path/key. */
  saveJson(path: string, data: unknown): Promise<string>;
  /** Write raw bytes (e.g. screenshots). Returns the stored path/key. */
  saveBuffer(path: string, buffer: Buffer): Promise<string>;
  /** Read UTF-8 text previously stored at `path`. */
  readText(path: string): Promise<string>;
  /** True if an artifact exists at `path`. */
  exists(path: string): Promise<boolean>;
}
