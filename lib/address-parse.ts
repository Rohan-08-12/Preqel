/**
 * Parses address_raw ("Boucherville, QC J4B 8P4") into city + postal
 * code. Deliberately discards the 2-letter province abbreviation embedded
 * in the string — lmia_filings already has a full province name from the
 * separately forward-filled province_territory column, so keeping a
 * second, redundant, abbreviated copy here would just be a source of
 * drift between the two if they ever disagreed.
 *
 * Canadian postal code format: letter-digit-letter, space, digit-letter-
 * digit (e.g. "J4B 8P4"). The regex requires that exact shape at the end
 * of the string, which is what lets us reliably split off the city even
 * when the city name itself contains commas or hyphens.
 */

export type ParsedAddress = {
  city: string;
  postalCode: string;
};

const ADDRESS_PATTERN = /^(.*),\s*[A-Za-z]{2}\s+([A-Za-z]\d[A-Za-z]\s?\d[A-Za-z]\d)\s*$/;

// Source city text arrives inconsistently cased — "Kelowna", "KELOWNA",
// and "kelowna" all appear in real data for what is unambiguously the
// same city. Title-casing on word boundaries (space, hyphen) collapses
// these to one consistent grouping key, which matters for both
// aggregation (mv_hiring_trends groups by city) and the search/filter UI
// (a location filter needs one canonical spelling per city to match
// against). Verified against real city strings from the live database,
// including hyphenated and apostrophe-containing names.
function titleCaseCity(city: string): string {
  // Word boundaries are start-of-string, space, and hyphen — deliberately
  // NOT apostrophe, so "St. John's" capitalizes "John" but leaves the "s"
  // in "John's" alone. Known simplification: French linking particles
  // ("de", "du", "la") still get capitalized (e.g. "Ste-Clotilde-De-
  // Chateauguay") rather than kept lowercase per formal French convention
  // — accepted for v1 rather than building full French title-case rules.
  return city
    .toLowerCase()
    .replace(/(^|[\s-])([a-zà-ÿ])/g, (_match, boundary, letter) => boundary + letter.toUpperCase());
}

export function parseAddress(raw: string): ParsedAddress | null {
  const match = raw.trim().match(ADDRESS_PATTERN);
  if (!match) return null;

  const city = titleCaseCity(match[1].trim());
  const postalCode = match[2].toUpperCase().replace(/\s+/, " ");

  if (city.length === 0) return null;

  return { city, postalCode };
}
