/**
 * Normalize raw_lmia_rows into the canonical tables: employers,
 * employer_aliases, and lmia_filings.
 *
 * Usage:
 *   npm run normalize -- --quarter 2026Q1
 *
 * Steps (see Preqel schema doc for table shapes):
 *   1. For each distinct employer_raw in raw_lmia_rows for this quarter,
 *      check employer_aliases first (already resolved -> skip).
 *   2. For unresolved names: run rule-based normalization
 *      (lib/employer-normalize.ts), then check if the normalized form
 *      matches an existing employer's canonical_name.
 *   3. Still unresolved: fuzzy-match against existing canonical names
 *      (fastest-levenshtein or similar) above a confidence threshold.
 *      Log anything below threshold for manual review rather than
 *      guessing — bad matches are worse than an unresolved row.
 *   4. Still unresolved: create a new employer row, alias the raw name
 *      to it.
 *   5. Split occupation_raw ("6322-Cooks") into NOC code + title, look
 *      up (or create) the noc_codes row for the NOC version in effect
 *      for this quarter, resolve to a role_family via
 *      noc_role_family_map (nullable if no mapping exists yet).
 *   6. Parse address_raw into city / postal_code.
 *   7. Insert the fully normalized row into lmia_filings.
 *
 * This is a stub — steps 3, 5, and 6 need real implementation before
 * this is usable end to end. Left deliberately unimplemented rather
 * than guessed, since fuzzy-match thresholds and NOC-version handling
 * are exactly the kind of decisions worth making against real data,
 * not assumptions.
 */

import { pool } from "../lib/db";
import { normalizeEmployerName } from "../lib/employer-normalize";

const quarter = process.argv
  .find((arg) => arg.startsWith("--quarter"))
  ?.split("=")[1];

async function main() {
  if (!quarter) {
    console.error("Usage: npm run normalize -- --quarter=2026Q1");
    process.exit(1);
  }

  const { rows } = await pool.query(
    `select distinct employer_raw from raw_lmia_rows where source_quarter = $1`,
    [quarter]
  );

  console.log(`Found ${rows.length} distinct raw employer names for ${quarter}.`);

  for (const row of rows) {
    const normalized = normalizeEmployerName(row.employer_raw);
    // TODO: check employer_aliases, fuzzy-match, create-or-link employer.
    console.log(`${row.employer_raw} -> ${normalized}`);
  }

  console.log(
    "Stub complete. Employer resolution, NOC splitting, and address parsing still need implementation — see comments above."
  );

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
