/**
 * Normalize raw_lmia_rows into the canonical tables: employers,
 * employer_aliases, and lmia_filings.
 *
 * Usage:
 *   npm run normalize -- --quarter 2026Q1
 *
 * (Args are parsed with node:util parseArgs, matching scripts/ingest.ts.)
 *
 * Steps (see Preqel schema doc for table shapes):
 *   1. For each distinct employer_raw in raw_lmia_rows for this quarter,
 *      check employer_aliases first (already resolved -> skip).
 *   2. For unresolved names: run rule-based normalization
 *      (lib/employer-normalize.ts), then check if the normalized form
 *      matches an existing employer's canonical_name exactly.
 *   3. Still unresolved: fuzzy-match against existing canonical names
 *      (lib/employer-match.ts). Auto-link above AUTO_LINK_THRESHOLD;
 *      log anything in the review band for manual inspection and fall
 *      back to creating a new employer rather than guessing — a false
 *      merge silently corrupts every aggregate, a missed merge is just
 *      visibly unresolved.
 *   4. Still unresolved: create a new employer row, alias the raw name
 *      to it.
 *   5. Split occupation_raw ("6322-Cooks") into NOC code + title, look
 *      up (or create) the noc_codes row for the NOC version in effect
 *      for this quarter, resolve to a role_family via
 *      noc_role_family_map (nullable if no mapping exists yet).
 *   6. Parse address_raw into city / postal_code.
 *   7. Insert the fully normalized row into lmia_filings.
 *
 * Steps 1-4 (employer resolution) are implemented. Steps 5-7 (NOC
 * splitting, address parsing, lmia_filings population) are still TODO —
 * see the note at the bottom of main().
 */

import { parseArgs } from "node:util";
import { pool } from "../lib/db";
import { isNumberedCompany, normalizeEmployerName } from "../lib/employer-normalize";
import {
  findBestMatch,
  type EmployerCandidate,
} from "../lib/employer-match";

const { values } = parseArgs({
  options: {
    quarter: { type: "string" },
  },
});

const quarter = values.quarter;

type AliasMethod = "exact" | "rule_normalized" | "fuzzy" | "manual_override";

async function main() {
  if (!quarter) {
    console.error("Usage: npm run normalize -- --quarter 2026Q1");
    process.exit(1);
  }

  // --- Employer resolution (steps 1-4) --------------------------------------

  // Distinct raw employer names for this quarter that aren't already
  // resolved. employer_aliases.raw_name is unique, so an existing row
  // means this name was handled by a previous run — skip it entirely.
  const { rows: unresolved } = await pool.query<{ employer_raw: string }>(
    `select distinct r.employer_raw
       from raw_lmia_rows r
      where r.source_quarter = $1
        and r.employer_raw is not null
        and not exists (
          select 1 from employer_aliases a where a.raw_name = r.employer_raw
        )`,
    [quarter]
  );

  console.log(
    `${unresolved.length} unresolved distinct employer names for ${quarter}.`
  );

  // Fetch the full candidate list once. Kept up to date in memory as new
  // employers are created during this run, so two different raw names in
  // the same batch that normalize identically resolve to the same new
  // employer instead of racing to create duplicates.
  const { rows: existing } = await pool.query<{
    id: number;
    canonical_name: string;
  }>(`select id, canonical_name from employers`);

  const candidates: EmployerCandidate[] = existing.map((e) => ({
    employerId: e.id,
    canonicalName: e.canonical_name,
  }));
  // canonical_name -> employerId, for O(1) exact lookups.
  const byCanonical = new Map<string, number>(
    candidates.map((c) => [c.canonicalName, c.employerId])
  );

  const stats = {
    rule_normalized: 0,
    fuzzy: 0,
    needs_review: 0,
    created: 0,
  };

  async function linkAlias(
    rawName: string,
    employerId: number,
    method: AliasMethod,
    confidence: number | null
  ) {
    await pool.query(
      `insert into employer_aliases (employer_id, raw_name, match_method, confidence)
       values ($1, $2, $3, $4)`,
      [employerId, rawName, method, confidence]
    );
  }

  async function createEmployer(canonicalName: string): Promise<number> {
    const { rows } = await pool.query<{ id: number }>(
      `insert into employers (canonical_name)
       values ($1)
       on conflict (canonical_name) do update set updated_at = now()
       returning id`,
      [canonicalName]
    );
    const id = rows[0].id;
    if (!byCanonical.has(canonicalName)) {
      byCanonical.set(canonicalName, id);
      candidates.push({ employerId: id, canonicalName });
    }
    return id;
  }

  for (const { employer_raw: rawName } of unresolved) {
    const normalized = normalizeEmployerName(rawName);

    // (b) exact match against an existing canonical name.
    const exactId = byCanonical.get(normalized);
    if (exactId !== undefined) {
      await linkAlias(rawName, exactId, "rule_normalized", null);
      stats.rule_normalized++;
      continue;
    }

    // (c) numbered companies never fuzzy-match — the number is the
    // identity and near-identical numbers are unrelated companies.
    if (isNumberedCompany(rawName)) {
      const id = await createEmployer(normalized);
      await linkAlias(rawName, id, "exact", null);
      stats.created++;
      continue;
    }

    // (d) fuzzy match against all existing canonical names.
    const match = findBestMatch(normalized, candidates);
    if (match.decision === "auto_link") {
      await linkAlias(rawName, match.employerId, "fuzzy", match.confidence);
      stats.fuzzy++;
      continue;
    }
    if (match.decision === "needs_review") {
      console.log(
        `[REVIEW] "${rawName}" (normalized: "${normalized}") ~ ${(
          match.confidence * 100
        ).toFixed(1)}% similar to existing "${match.canonicalName}" ` +
          `(employer_id=${match.employerId}) — not auto-linked, check manually if this is a duplicate`
      );
      stats.needs_review++;
      // fall through to (e): create a new employer as the safe default.
    }

    // (e) create a new employer and alias the raw name to it.
    const id = await createEmployer(normalized);
    await linkAlias(rawName, id, "exact", null);
    stats.created++;
  }

  console.log(
    `Employer resolution done: ${stats.rule_normalized} rule-normalized, ` +
      `${stats.fuzzy} fuzzy-linked, ${stats.needs_review} flagged for review, ` +
      `${stats.created} new employers.`
  );

  // --- TODO: steps 5-7 (NOC splitting, address parsing, lmia_filings) ------
  // Not yet implemented. Once employer resolution is trusted against real
  // data, wire up: split occupation_raw into NOC code + title (NOC 2021
  // for 2026Q1 — the file title states the version), resolve role_family
  // via noc_role_family_map, parse address_raw into city / postal_code,
  // then insert one lmia_filings row per raw_lmia_rows row for this quarter.
  console.log(
    "NOC splitting and address parsing still TODO — lmia_filings not populated."
  );

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
