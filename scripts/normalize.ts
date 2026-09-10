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
 * All steps are implemented. Employer resolution (1-4) runs first, then
 * NOC splitting + address parsing + lmia_filings population (5-7).
 */

import { parseArgs } from "node:util";
import { pool } from "../lib/db";
import { isNumberedCompany, normalizeEmployerName } from "../lib/employer-normalize";
import {
  findBestMatch,
  type EmployerCandidate,
} from "../lib/employer-match";
import {
  BROAD_CATEGORY_ROLE_FAMILIES,
  getBroadCategoryRoleFamily,
  parseOccupation,
} from "../lib/noc-split";
import { parseAddress } from "../lib/address-parse";

// Both quarters we have use NOC 2021 (stated in the source file title).
const NOC_VERSION = "2021";

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

  // --- lmia_filings population (steps 5-7) ---------------------------------

  // (1) Ensure the broad-category role families exist. Idempotent: the
  // no-op "do update" forces RETURNING to yield the id on conflict too.
  const roleFamilyByName = new Map<string, number>();
  for (const familyName of new Set(Object.values(BROAD_CATEGORY_ROLE_FAMILIES))) {
    const { rows } = await pool.query<{ id: number }>(
      `insert into role_families (name)
       values ($1)
       on conflict (name) do update set name = excluded.name
       returning id`,
      [familyName]
    );
    roleFamilyByName.set(familyName, rows[0].id);
  }

  // (2) Raw rows for this quarter that still need an lmia_filings row.
  // Re-running only processes rows not already inserted, same as employer
  // resolution above.
  const { rows: toFill } = await pool.query<{
    raw_row_id: number;
    employer_raw: string;
    stream: string | null;
    province_territory: string | null;
    address_raw: string | null;
    occupation_raw: string | null;
    approved_positions: number | null;
    employer_id: number;
  }>(
    `select r.id as raw_row_id, r.employer_raw, r.stream, r.province_territory,
            r.address_raw, r.occupation_raw, r.approved_positions, ea.employer_id
       from raw_lmia_rows r
       join employer_aliases ea on ea.raw_name = r.employer_raw
      where r.source_quarter = $1
        and not exists (select 1 from lmia_filings f where f.raw_row_id = r.id)`,
    [quarter]
  );

  // (3) In-memory caches to avoid a DB round-trip per row.
  const { rows: nocRows } = await pool.query<{ id: number; code: string }>(
    `select id, code from noc_codes where noc_version = $1`,
    [NOC_VERSION]
  );
  const nocCodeIdByCode = new Map<string, number>(
    nocRows.map((n) => [n.code, n.id])
  );

  // Tier 2 overrides: noc_code_id -> role_family_id. Empty for now (none
  // seeded), but the lookup below works unchanged once rows are added.
  const { rows: nrfmRows } = await pool.query<{
    noc_code_id: number;
    role_family_id: number;
  }>(`select noc_code_id, role_family_id from noc_role_family_map`);
  const roleFamilyByNocCodeId = new Map<number, number>(
    nrfmRows.map((m) => [m.noc_code_id, m.role_family_id])
  );

  async function upsertNocCode(code: string, title: string): Promise<number> {
    const { rows } = await pool.query<{ id: number }>(
      `insert into noc_codes (noc_version, code, title)
       values ($1, $2, $3)
       on conflict (noc_version, code) do update set title = excluded.title
       returning id`,
      [NOC_VERSION, code, title]
    );
    const id = rows[0].id;
    nocCodeIdByCode.set(code, id);
    return id;
  }

  // One resolved filing, ready to insert — column order matches the
  // INSERT below. Collected in the loop, flushed in batches after.
  type FilingRow = [
    raw_row_id: number,
    source_quarter: string,
    employer_id: number,
    noc_code_id: number | null,
    role_family_id: number | null,
    stream: string | null,
    province_territory: string | null,
    city: string | null,
    postal_code: string | null,
    approved_positions: number
  ];
  const FILING_COLS = 10;

  // Batched multi-row insert, same shape as scripts/ingest.ts —
  // FILING_COLS placeholders per row, base index advances by FILING_COLS.
  async function insertFilingsBatched(rows: FilingRow[], batchSize = 500) {
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const values: unknown[] = [];
      const placeholders = batch
        .map((r, idx) => {
          const base = idx * FILING_COLS;
          values.push(...r);
          const slots = Array.from(
            { length: FILING_COLS },
            (_, k) => `$${base + k + 1}`
          );
          return `(${slots.join(", ")})`;
        })
        .join(", ");

      await pool.query(
        `insert into lmia_filings
           (raw_row_id, source_quarter, employer_id, noc_code_id, role_family_id,
            stream, province_territory, city, postal_code, approved_positions)
         values ${placeholders}`,
        values
      );
    }
  }

  const filings: FilingRow[] = [];
  let occFailures = 0;
  let addrFailures = 0;

  for (const row of toFill) {
    // (4a) Bad row guard — don't crash the batch on missing positions.
    if (row.approved_positions === null) {
      console.warn(
        `Skipping raw_row_id=${row.raw_row_id}: approved_positions is null`
      );
      continue;
    }

    // (4b) Occupation -> noc_code_id + role_family_id.
    let nocCodeId: number | null = null;
    let roleFamilyId: number | null = null;

    const occ = parseOccupation(row.occupation_raw ?? "");
    if (occ === null) {
      console.warn(
        `Could not parse occupation: "${row.occupation_raw ?? ""}" (raw_row_id=${row.raw_row_id})`
      );
      occFailures++;
    } else {
      nocCodeId =
        nocCodeIdByCode.get(occ.code) ??
        (await upsertNocCode(occ.code, occ.title));

      // Tier 2 override wins; otherwise the Tier 1 broad-category fallback.
      const override = roleFamilyByNocCodeId.get(nocCodeId);
      if (override !== undefined) {
        roleFamilyId = override;
      } else {
        const familyName = getBroadCategoryRoleFamily(occ.code);
        roleFamilyId = familyName
          ? roleFamilyByName.get(familyName) ?? null
          : null;
      }
    }

    // (4c) Address -> city + postal_code. A few malformed source
    // addresses are expected; no per-row logging.
    let city: string | null = null;
    let postalCode: string | null = null;
    const addr = row.address_raw ? parseAddress(row.address_raw) : null;
    if (addr) {
      city = addr.city;
      postalCode = addr.postalCode;
    } else {
      addrFailures++;
    }

    // (4d) Collect the fully normalized filing; flushed in batches below.
    filings.push([
      row.raw_row_id,
      quarter,
      row.employer_id,
      nocCodeId,
      roleFamilyId,
      row.stream,
      row.province_territory,
      city,
      postalCode,
      row.approved_positions,
    ]);
  }

  await insertFilingsBatched(filings);

  console.log(
    `lmia_filings populated: ${filings.length} rows inserted, ` +
      `${occFailures} occupation parse failures, ${addrFailures} address parse failures.`
  );

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
