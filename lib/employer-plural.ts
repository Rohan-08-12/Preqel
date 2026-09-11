/**
 * Generates plural/singular variants of an already-normalized employer
 * name, for an exact-match check against existing canonical names
 * BEFORE falling through to fuzzy matching.
 *
 * Why this exists: a real, recurring pattern in the review queue was
 * pairs like "SHREEJI ENTERPRISE" vs "SHREEJI ENTERPRISES" or "YOUNG
 * BOY DRYWALL" vs "YOUNG BOYS DRYWALL" — the exact same company, just
 * with one word singular in one filing and plural in another (a
 * genuinely common inconsistency in how people type their own business
 * name across different government forms). These are NOT ambiguous the
 * way "D GILL CONSTRUCTION" vs "P GILL CONSTRUCTION" is (different
 * initial = plausibly a different real Gill) — a trailing S on a whole
 * word is a spelling/grammar inconsistency, not a different-identity
 * signal, so this is safe to treat as a rule-based exact match rather
 * than routing it through fuzzy-match review.
 *
 * Toggles ONE WORD AT A TIME (not just the last word — a real case,
 * "YOUNG BOYS DRYWALL"/"YOUNG BOY DRYWALL", has the difference in the
 * middle word), holding every other word fixed, so a generated variant
 * only differs from the original by a single trailing S on a single
 * word — never a compound change across multiple words.
 *
 * Skips words shorter than MIN_WORD_LENGTH. This matters: a naive
 * trailing-S toggle on a SHORT word risks a coincidental false match to
 * an unrelated real company — e.g. "SAS" -> "SA" isn't a plural typo,
 * "SA" is a real, distinct corporate-suffix pattern (Société Anonyme).
 * Short words are exactly where a single-letter difference carries
 * disproportionate weight (the same lesson learned the hard way with
 * the fuzzy-match AUTO_LINK_THRESHOLD bug earlier in this project).
 *
 * Known residual risk, accepted rather than fully solved: a longer
 * proper noun that happens to end in S without being a plural (e.g.
 * "TEXAS") will still generate a stripped variant ("TEXA"). This is
 * only a real problem if that exact stripped string coincidentally
 * matches a genuinely different company's canonical name, which is
 * rare in practice — accepted the same way the French-particle city
 * casing and acronym display-name limitations were accepted elsewhere
 * in this codebase, rather than building more complexity to chase a
 * fully perfect rule.
 */
const MIN_WORD_LENGTH_FOR_PLURAL_CHECK = 4;

export function pluralVariants(normalizedName: string): string[] {
  const words = normalizedName.split(" ");
  const variants = new Set<string>([normalizedName]);

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word.length < MIN_WORD_LENGTH_FOR_PLURAL_CHECK) continue;

    const toggled = word.endsWith("S") ? word.slice(0, -1) : word + "S";
    const variantWords = [...words];
    variantWords[i] = toggled;
    variants.add(variantWords.join(" "));
  }

  return [...variants];
}
