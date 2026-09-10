/**
 * Splits occupation_raw ("00012-Senior managers - financial, communications
 * and other business services") into NOC code + title, and derives the
 * broad-category role family from the code's first digit.
 *
 * Split-on-first-hyphen is safe here: the code is immediately followed by
 * "-title" with no space, while any hyphens INSIDE the title text are
 * always surrounded by spaces (" - "). So the first raw "-" character in
 * the whole string is always the code/title delimiter, never a hyphen
 * that's part of the title itself. Verified against real occupation_raw
 * values from the live database, including titles containing their own
 * " - " separators (e.g. "Senior managers - financial, communications...").
 */

export type ParsedOccupation = {
  code: string;
  title: string;
};

export function parseOccupation(raw: string): ParsedOccupation | null {
  const hyphenIndex = raw.indexOf("-");
  if (hyphenIndex === -1) return null;

  const code = raw.slice(0, hyphenIndex).trim();
  const title = raw.slice(hyphenIndex + 1).trim();

  if (code.length === 0 || title.length === 0) return null;
  // NOC codes are numeric (4 digits for NOC 2011, 5 for NOC 2021).
  if (!/^\d+$/.test(code)) return null;

  return { code, title };
}

// NOC 2021's first digit is a broad occupational category — confirmed
// against ESDC's own NOC matrix documentation. This is Tier 1 of the role
// family design: every code gets bucketed here as a guaranteed fallback.
// Tier 2 (specific overrides for high-volume codes, e.g. "Software & IT"
// carved out of category 2) lives in the noc_role_family_map table and
// takes precedence over this fallback when present — see normalize.ts.
export const BROAD_CATEGORY_ROLE_FAMILIES: Record<string, string> = {
  "0": "Senior management",
  "1": "Business, finance & administration",
  "2": "Natural & applied sciences",
  "3": "Health",
  "4": "Education, law, social & community services",
  "5": "Art, culture, recreation & sport",
  "6": "Sales & service",
  "7": "Trades, transport & equipment operators",
  "8": "Natural resources & agriculture",
  "9": "Manufacturing & utilities",
};

export function getBroadCategoryRoleFamily(code: string): string | null {
  const digit = code[0];
  return BROAD_CATEGORY_ROLE_FAMILIES[digit] ?? null;
}

// The second digit is the TEER (training/education/experience/
// responsibility) level, 0-5. Not used for role family bucketing, but
// worth capturing at the noc_codes level later if useful — kept here as
// a documented derivation, not wired into anything yet (deliberately
// out of v1 scope; noted for future extensibility).
export function getTeerLevel(code: string): number | null {
  const digit = code[1];
  if (digit === undefined) return null;
  const n = Number(digit);
  return Number.isInteger(n) && n >= 0 && n <= 5 ? n : null;
}
