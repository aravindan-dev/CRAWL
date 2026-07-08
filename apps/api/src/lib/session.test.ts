import { describe, it, expect, beforeAll } from "vitest";

beforeAll(() => {
  // Must be set BEFORE session.ts's first call to getSessionSecret(), which
  // caches it — otherwise it would try to read/write the real repo .env.
  process.env.SESSION_SECRET = "test-secret-not-for-production";
});

describe("encodeSession / decodeSession", () => {
  it("round-trips a valid, unexpired session", async () => {
    const { encodeSession, decodeSession } = await import("./session.js");
    const token = encodeSession({ userId: "u1", role: "ADMIN", exp: Date.now() + 60_000 });
    const decoded = decodeSession(token);
    expect(decoded).toEqual({ userId: "u1", role: "ADMIN", exp: expect.any(Number) });
  });

  it("rejects an expired session", async () => {
    const { encodeSession, decodeSession } = await import("./session.js");
    const token = encodeSession({ userId: "u1", role: "ADMIN", exp: Date.now() - 1000 });
    expect(decodeSession(token)).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const { encodeSession, decodeSession } = await import("./session.js");
    const token = encodeSession({ userId: "u1", role: "VIEWER", exp: Date.now() + 60_000 });
    const [data, sig] = token.split(".");
    const tampered = `${data}x.${sig}`;
    expect(decodeSession(tampered)).toBeNull();
  });

  it("rejects garbage input without throwing", async () => {
    const { decodeSession } = await import("./session.js");
    expect(decodeSession("")).toBeNull();
    expect(decodeSession("not-a-session")).toBeNull();
    expect(decodeSession("a.b")).toBeNull();
  });
});
