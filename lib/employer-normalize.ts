/**
 * Rule-based employer name normalization — the first, deterministic pass
 * before any fuzzy matching happens. Resolves the bulk of the noise
 * ("Shopify Inc." / "Shopify Inc" / "SHOPIFY INC." -> "SHOPIFY").
 *
 * This intentionally does NOT do fuzzy/similarity matching — that's a
 * separate step (see normalize.ts) that runs only on names this function
 * can't collapse together, plus a manual alias override table for the
 * big, obvious cases you'll find once you look at real data.
 *
 * What this deliberately does NOT try to fix (see normalize.ts design
 * notes / CLAUDE.md for the reasoning):
 *   - Numbered companies ("7043821 Canada Inc.") — no brand name exists
 *     to normalize toward. Use isNumberedCompany() to detect these and
 *     skip fuzzy matching entirely; they should go straight to
 *     "treat as a new employer" rather than waste cycles trying to
 *     match something unmatchable.
 *   - Cross-language aliases with zero string overlap (e.g. "CGI
 *     Information Systems & Management Consultants Inc." and
 *     "Conseillers en gestion et informatique CGI Inc." — same company,
 *     English vs. French registered name). No automated technique
 *     catches this; it needs a manual_override row in employer_aliases.
 *   - DBA ("doing business as") strings and parenthetical regional/year
 *     tags like "(Canada)" or "(2014)" — deliberately left alone, since
 *     stripping these risks merging genuinely distinct entities more
 *     than it helps collapse noise.
 */

// Trailing legal-structure suffixes, English and French/Québécois.
// Order doesn't matter — stripLegalSuffix() loops until nothing more
// matches, so chained suffixes ("... CORP ULC") get fully unwound.
const LEGAL_SUFFIXES = [
  "INCORPORATED",
  "INC",
  "LIMITED",
  "LIMITEE",
  "LIMITÉE",
  "LIMITE",
  "LIMITÉ",
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

// Leading corporate-structure descriptors that appear as a PREFIX rather
// than a suffix — a pattern the original suffix-only stripping couldn't
// touch at all, since it only ever checked the end of the string.
// "Société en commandite Airbus Canada" -> "Airbus Canada", so this
// normalizes toward the same form an English-registered equivalent
// ("Airbus Canada Inc.") would also collapse to.
const LEGAL_PREFIXES = ["SOCIETE EN COMMANDITE", "SOCIÉTÉ EN COMMANDITE"];

const suffixPattern = new RegExp(`\\s+(${LEGAL_SUFFIXES.join("|")})$`);

function stripTrailingPunctuation(name: string): string {
  // Cleans up artifacts left behind after a suffix strip, e.g.
  // "OLYMEL SEC / LP" -> strip "LP" -> "OLYMEL SEC /" -> this function
  // removes the orphaned trailing slash so the next loop pass can see
  // "OLYMEL SEC" cleanly and strip "SEC" too.
  return name.replace(/[/,;:-]+$/, "").trim();
}

export function normalizeEmployerName(raw: string): string {
  let name = raw.trim().toUpperCase();

  // Normalize punctuation/whitespace before touching suffixes.
  name = name.replace(/[.,]/g, "");
  name = name.replace(/\s+/g, " ").trim();

  // Strip a known leading corporate-structure descriptor, if present.
  for (const prefix of LEGAL_PREFIXES) {
    const prefixRegex = new RegExp(`^${prefix}\\s+`);
    if (prefixRegex.test(name)) {
      name = name.replace(prefixRegex, "").trim();
      break; // only expect one leading descriptor
    }
  }

  // Repeatedly strip trailing legal suffixes + trailing punctuation
  // until a pass produces no change. This is what fixes the old
  // single-pass bug: "Olymel s.e.c / l.p" needs THREE passes
  // (strip "LP" -> strip orphaned "/" -> strip "SEC") to fully resolve
  // to "OLYMEL". A single pass left "OLYMEL SEC /" dangling.
  let previous: string;
  do {
    previous = name;
    name = stripTrailingPunctuation(name);
    name = name.replace(suffixPattern, "").trim();
  } while (name !== previous && name.length > 0);

  return name;
}

// Numbered companies (e.g. "7043821 Canada Inc.", "11656520 Canada Inc.")
// have no brand name to normalize toward or fuzzy-match against — the
// leading number IS the identity, and near-identical numbers are
// unrelated companies. Detect these so normalize.ts can route them
// straight to "create new employer" instead of running fuzzy matching
// that can only produce false confidence.
export function isNumberedCompany(raw: string): boolean {
  return /^\d/.test(raw.trim());
}
