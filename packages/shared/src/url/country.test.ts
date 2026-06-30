import { describe, it, expect } from "vitest";
import { countryFromUrl } from "./country.js";

describe("countryFromUrl", () => {
  it("infers country from the ccTLD", () => {
    expect(countryFromUrl("https://www.canberra.edu.au")).toBe("Australia");
    expect(countryFromUrl("https://www.solent.ac.uk")).toBe("United Kingdom");
    expect(countryFromUrl("https://harvard.edu")).toBe("United States");
    expect(countryFromUrl("https://www.tum.de/en")).toBe("Germany");
    expect(countryFromUrl("www.uoft.ca")).toBe("Canada"); // scheme optional
  });
  it("returns '' for unknown / unparseable input", () => {
    expect(countryFromUrl("")).toBe("");
    expect(countryFromUrl(null)).toBe("");
    expect(countryFromUrl("not a url")).toBe("");
    expect(countryFromUrl("https://example.xyz")).toBe("");
  });
});
