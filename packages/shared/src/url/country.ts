/**
 * Infer a university's COUNTRY from its website domain (the ccTLD), used to fill the
 * export's country column when a university was imported without one (e.g. a name-
 * only import). A `.edu.au` site is Australian, `.ac.uk` British, and so on. This is
 * a best-effort fallback — an explicitly-provided country always wins.
 */
const TLD_COUNTRY: Record<string, string> = {
  au: "Australia",
  uk: "United Kingdom",
  us: "United States",
  edu: "United States", // bare .edu is overwhelmingly US (harvard.edu, mit.edu …)
  ca: "Canada",
  in: "India",
  nz: "New Zealand",
  ie: "Ireland",
  de: "Germany",
  fr: "France",
  nl: "Netherlands",
  es: "Spain",
  it: "Italy",
  se: "Sweden",
  ch: "Switzerland",
  at: "Austria",
  be: "Belgium",
  dk: "Denmark",
  fi: "Finland",
  no: "Norway",
  pt: "Portugal",
  pl: "Poland",
  cz: "Czechia",
  cn: "China",
  jp: "Japan",
  kr: "South Korea",
  hk: "Hong Kong",
  sg: "Singapore",
  my: "Malaysia",
  za: "South Africa",
  ae: "United Arab Emirates",
  sa: "Saudi Arabia",
  qa: "Qatar",
  br: "Brazil",
  mx: "Mexico",
  ar: "Argentina",
  ru: "Russia",
  tr: "Türkiye",
  gr: "Greece",
  il: "Israel",
  th: "Thailand",
  id: "Indonesia",
  ph: "Philippines",
  vn: "Vietnam",
};

/** Country name inferred from a URL/host's top-level domain, or "" if unknown. */
export function countryFromUrl(url: string | null | undefined): string {
  if (!url) return "";
  let host = "";
  try {
    host = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase();
  } catch {
    return "";
  }
  const parts = host.split(".").filter(Boolean);
  if (parts.length < 2) return "";
  const tld = parts[parts.length - 1]!; // au, uk, edu, de …
  return TLD_COUNTRY[tld] ?? "";
}
