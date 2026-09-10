/**
 * Rule-based employer name normalization — the first, deterministic pass
 * before any fuzzy matching happens. Resolves the bulk of the noise
 * ("Shopify Inc." / "Shopify Inc" / "SHOPIFY INC." -> "SHOPIFY").
 *
 * This intentionally does NOT do fuzzy/similarity matching — that's a
 * separate step (see normalize.ts) that runs only on names this function
 * can't collapse together, plus a manual alias override table for the
 * big, obvious cases you'll find once you look at real data.
 */

const LEGAL_SUFFIXES = [
  "INCORPORATED",
  "INC",
  "LIMITED",
  "LTD",
  "LTEE",
  "LTÉE",
  "CORPORATION",
  "CORP",
  "COMPANY",
  "CO",
  "LLC",
  "LLP",
  "LP",
  "SENC",
  "SEC",
  "ULC",
];

export function normalizeEmployerName(raw: string): string {
  let name = raw.trim().toUpperCase();

  // Normalize punctuation/whitespace before touching suffixes.
  name = name.replace(/[.,]/g, "");
  name = name.replace(/\s+/g, " ").trim();

  // Strip a trailing legal suffix (only one — "ACME CO INC" keeps "ACME CO"
  // after one pass; re-run if you want to strip chained suffixes).
  const suffixPattern = new RegExp(`\\s+(${LEGAL_SUFFIXES.join("|")})$`);
  name = name.replace(suffixPattern, "");

  return name.trim();
}
