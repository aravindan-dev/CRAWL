import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "./passwords.js";

describe("hashPassword / verifyPassword", () => {
  it("round-trips a correct password", () => {
    const hash = hashPassword("correct horse battery staple");
    expect(verifyPassword("correct horse battery staple", hash)).toBe(true);
  });

  it("rejects an incorrect password", () => {
    const hash = hashPassword("correct horse battery staple");
    expect(verifyPassword("wrong password", hash)).toBe(false);
  });

  it("produces a different salt (and hash) each time", () => {
    const a = hashPassword("same password");
    const b = hashPassword("same password");
    expect(a).not.toBe(b);
    expect(verifyPassword("same password", a)).toBe(true);
    expect(verifyPassword("same password", b)).toBe(true);
  });

  it("rejects a malformed stored hash without throwing", () => {
    expect(verifyPassword("anything", "not-a-real-hash")).toBe(false);
    expect(verifyPassword("anything", "scrypt$onlytwoparts")).toBe(false);
    expect(verifyPassword("anything", "")).toBe(false);
  });
});
