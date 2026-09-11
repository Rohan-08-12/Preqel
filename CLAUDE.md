# Preqel

Hiring-signal intelligence for Canadian job seekers. Ingests public regulatory
data and surfaces hiring trends (ramping up / flat / declining) by company, role
family, and location — ideally before roles are publicly posted.

For the full product vision, phased roadmap, and known risks, see
`README.md` and `Preqel_Platform_Reference.pdf`. Don't duplicate them here.

## V1 scope (current focus)

- **One data source:** ESDC's quarterly Positive LMIA Employers List
  ([open.canada.ca](https://open.canada.ca/data/en/dataset/90fed587-1364-4f33-a9ee-208181dc0b97))
- Pipeline: ingest → normalize → aggregate → search/filter UI. **All stages
  are implemented and working end to end against live data** (see Current
  state below) — this is no longer a scaffold.
- No auth. Single-user local tool.

**Out of scope until v2+ (see the reference PDF):** StatCan JVWS, provincial
mass-termination notices, SEDAR+ filings, GitHub activity signals, alerting,
org-structure mapping. If a request pulls toward any of these before v1 works
end to end, flag it before building.

## Stack

- Next.js (App Router) + TypeScript
- Supabase (Postgres) for storage
- React + Tailwind for the UI — **no component library**
- ingest / normalize / aggregate are standalone scripts run via `tsx`
  (`npm run ingest|normalize|aggregate`, loading `.env.local` via
  `--env-file`). They are **manual per-quarter batch jobs**, not routed
  through the web server or triggered by requests.
- **The Next.js API routes (`app/api/search`, `app/api/filters`) also go
  straight through `lib/db.ts` (the server-side `pg` pool)**, not through
  `lib/supabase.ts`. `lib/supabase.ts` (anon/publishable-key client) exists
  but is currently imported nowhere — dead code, scaffolded for a future
  client-side query rather than actively wired in. No RLS policies exist
  on any table, which is why a client-side Supabase query isn't safe yet.

## Layout

```
/app
  page.tsx                   Search/filter UI, "use client", debounced search + Load more
  api/search/route.ts        GET — validates query params, calls searchHiringSignals
  api/filters/route.ts       GET — role family / province dropdown options
/lib
  db.ts                      Raw pg Pool (SUPABASE_DB_URL) — scripts AND API routes
  supabase.ts                Anon-key client — unused, see note above
  employer-normalize.ts      Rule-based employer name cleanup (deterministic first pass)
  employer-plural.ts         Singular/plural exact-match variants (second pass)
  employer-match.ts          Fuzzy matching with a length-window prefilter (last resort)
  noc-split.ts               NOC code/title split + Tier 1 broad-category role families
  address-parse.ts           Address string -> city (title-cased) + postal code
  hiring-trends.ts           groupAndClassify, classifyTrend, searchHiringSignals (paginated)
/scripts
  ingest.ts                  Quarterly ESDC file → raw_lmia_rows
  normalize.ts               raw_lmia_rows → employers / employer_aliases / lmia_filings
  aggregate.ts               Refreshes mv_hiring_trends materialized view
/supabase/schema.sql          Full DB schema — heavily commented, read it before touching data layers
```

## Current state

Fully implemented and verified against live data:

- **8 quarters loaded**, contiguous: 2024Q2, 2024Q3, 2024Q4, 2025Q1, 2025Q2,
  2025Q3, 2025Q4, 2026Q1. ~124,700 raw rows, **all fully resolved** into
  `lmia_filings` (only 1 row each with an unresolved NOC code / role family —
  a residual parse failure, not a systemic gap) and aggregated into
  `mv_hiring_trends` (~112k rows).
- `employers`: ~68,600 canonical employers. `employer_aliases` breaks down as
  ~68,600 `exact`, ~300 `rule_normalized`, ~55 `fuzzy`, 17 `manual_override`
  (hand-fixed from the review queue this session).
- `role_families`: 10 broad categories (Tier 1, one per NOC first-digit) plus
  3 hand-curated overrides (Tier 2) — Software & IT, Engineering, Life &
  Physical Sciences — mapped from 35 specific NOC codes via
  `noc_role_family_map`. All 478 loaded NOC codes are version 2021.
- UI is built: search by employer name, filter by role family / province /
  trend direction, paginated (100 per page, 500 max, "Load more").

## Employer resolution pipeline (in order)

Each unresolved `employer_raw` for a quarter goes through, in this order,
falling through to the next only if the previous step finds nothing:

1. **Rule-based normalization** (`employer-normalize.ts`) — uppercase,
   strip punctuation (including apostrophes), strip a leading
   "Société en commandite"/"Societe en commandite" prefix, loop-strip
   trailing legal suffixes (English + French/Québécois: INC, LTD, LTÉE,
   ULC, SEC, CORP, etc.) until nothing more matches — this is what
   correctly resolves chained cases like "ClubLink Corporation ULC" and
   punctuation-mangled ones like "Olymel s.e.c / l.p".
2. **Exact match** against an existing `canonical_name`.
3. **Plural/singular match** (`employer-plural.ts`) — toggles a trailing S
   on one word at a time (not just the last word) and checks each variant
   for an exact match. Catches "SHREEJI ENTERPRISE" vs "SHREEJI
   ENTERPRISES" as a safe rule-based match rather than routing it through
   fuzzy review. Skips words under 4 characters specifically to avoid
   short-word false merges like "SAS"/"SA".
4. **Numbered companies** (`isNumberedCompany` — starts with a digit) skip
   straight to step 6. They never fuzzy-match: the number *is* the
   identity, and two numbered companies differing by one digit are
   unrelated, not near-duplicates.
5. **Fuzzy match** (`employer-match.ts`, `findBestMatch`) — edit-distance
   similarity with a length-window prefilter first (mathematically exact
   bound, not a heuristic: a candidate whose length falls outside
   `[queryLen·REVIEW_THRESHOLD, queryLen/REVIEW_THRESHOLD]` cannot possibly
   score above threshold, so filtering by it never changes the result,
   just speeds up the scan ~1.8–3.3x).
   - `AUTO_LINK_THRESHOLD = 0.95` → auto-link.
   - `REVIEW_THRESHOLD = 0.85` → log a `[REVIEW]` line, don't link, fall
     through to step 6 (safe default).
   - Below 0.85 → no match, fall through to step 6.
   - **Why conservative:** a false merge (treating two different real
     companies as one) silently corrupts every aggregate touching either
     of them and is invisible in the UI. A missed merge just leaves two
     employer rows unresolved — annoying but visible and fixable later.
     Thresholds were raised twice this session (0.75→0.85 review,
     0.92→0.95 auto-link) after live data showed false merges like
     "H & H Insulation"/"H & S Insulation" clearing the original 0.92 bar.
6. **Create a new employer**, alias the raw name to it (`match_method =
   'exact'`).

**Known gap, accepted rather than solved:** numbered-company spacing
variants ("3324608 Nova Scotia" vs "3324608 Novascotia") could create
duplicate employer records, since numbered companies skip fuzzy matching
by design. Not yet observed at meaningful scale.

## NOC / role family classification

`occupation_raw` (e.g. `"6322-Cooks"`) is split on the first hyphen — safe
because the NOC code is glued directly to the title with no space, while
any hyphens inside the title itself are always surrounded by spaces.

Role family resolution is two-tiered:
- **Tier 1 (guaranteed fallback):** the NOC code's first digit maps to one
  of 10 broad categories (0=Senior management … 9=Manufacturing &
  utilities). Every code gets bucketed here even with no other data.
- **Tier 2 (specific override):** `noc_role_family_map` maps individual
  NOC codes to a more specific family (e.g. carving "Software & IT" out
  of the broad "Natural & applied sciences" bucket). Checked first;
  Tier 1 is the fallback when no override row exists.

`NOC_VERSION` is hardcoded to `"2021"` in `normalize.ts` — true for all 8
loaded quarters, but the source data is known to have used NOC 2011 codes
before ~2024. **This will silently mis-tag codes if an older quarter is
ever ingested** — the versioned `noc_codes` table already supports this,
the hardcode just hasn't needed to move yet.

## Address parsing

`address_raw` (e.g. `"Boucherville, QC J4B 8P4"`) splits into city +
postal code via a regex anchored on the Canadian postal code shape at the
end of the string; the 2-letter province abbreviation is discarded
(redundant with the already-forward-filled `province_territory` column).

City text is title-cased for consistent grouping — real data had the same
city as "Kelowna"/"KELOWNA"/"kelowna", which would otherwise fragment
`mv_hiring_trends` groupings. **Known simplification:** French linking
particles ("de", "du", "la") still get capitalized (e.g. "Ste-Clotilde-
De-Chateauguay") rather than kept lowercase per formal French convention —
accepted rather than building full French title-case rules. The exact
same title-casing (`titleCaseDisplayName` in `hiring-trends.ts`) is applied
to *employer* names for display only — `employers.canonical_name` itself
stays uppercase, since it's the matching key everything else depends on.

## Search / trend / pagination

- `searchHiringSignals` queries `mv_hiring_trends` with optional
  employer/role-family/province filters, groups rows into one signal per
  employer+role+province+city, classifies a trend, then sorts by
  `latestPositions` descending and slices for pagination — sorting
  happens **before** paginating so `limit`/`offset` return a stable,
  meaningful window rather than an arbitrary Map-iteration-order slice.
- Trend filtering happens after grouping (trend isn't a stored column,
  can't filter it in SQL) — fine at current data volume.
- `classifyTrend`: compares the two most recent quarters a group has
  data for, ±15% (`TREND_CHANGE_THRESHOLD`) = flat, otherwise up/down.
  A group with only one quarter of data is classified by whether that
  quarter is the newest in the whole dataset (new filer → up) or an
  older one it dropped out of (→ down) — this distinction requires
  knowing the dataset's overall latest quarter, not just the group's own.
- Pagination: `DEFAULT_LIMIT = 100`, `MAX_LIMIT = 500`. Node-postgres
  returns `bigint`/`numeric` columns (ids, `count()`, `sum()`) as strings,
  not numbers — `mapRawRow` casts them explicitly. This was a real bug
  found and fixed this session (silent string concatenation on position
  sums); don't remove the casts without re-verifying.
- Employer search is a plain `ILIKE '%query%'` — a numbered company can
  swamp results for a common location-name search. Not yet addressed.

## ESDC data-source gotchas (affect ingest.ts / normalize.ts correctness)

- **No unique row/case identifier** in the source — only province + stream +
  employer + address + occupation + positions. No FEIN or business number.
- **Merged-cell export:** Province/Territory, Stream, and Employer columns are
  blank on repeat rows (= same as row above). MUST be forward-filled at ingest
  or aggregation silently drops most rows into null groups. `ingest.ts` already
  does this; `raw_lmia_rows` stores the *filled* values.
- **8 data columns, not 6** — a real bug this session: `ingest.ts` originally
  destructured only 6 of the real file's 8 columns, so `approved_positions`
  silently read from the wrong column (`Incorporate Status`) and came back
  NULL for every row. Fixed by destructuring all 8 (`Incorporate Status` and
  `Approved LMIAs` are read but intentionally not stored). Header detection
  relies on "Employer" landing in column C by current ESDC convention — will
  silently break if ESDC reorders columns again.
- **NOC version switch:** codes moved from NOC 2011 → NOC 2021 partway through
  the series (~2024). Same code string can mean different occupations by
  version — that's why `noc_codes` is versioned. See the NOC_VERSION hardcode
  note above.
- **No date column at all.** The quarter comes only from *which file* you
  ingest; `ingest.ts` tags every row with `--quarter` explicitly.
- **"Approved positions" is a ceiling**, not a confirmed headcount — what the
  employer *could* hire under that LMIA.

## Pipeline commands

```
npm run ingest -- --file ./data/tfwp_2026q1_pos_en.xlsx --quarter 2026Q1
npm run normalize -- --quarter 2026Q1
npm run aggregate
```

Source files go in `./data/` (gitignored — don't commit them). Both scripts
parse args with `node:util` `parseArgs` (space-separated flags, matching
`ingest.ts`'s pattern). Batch inserts (`ingest.ts`'s raw-row insert,
`normalize.ts`'s `lmia_filings` insert) use multi-row `VALUES` in batches
of 500, not one `INSERT` per row. `ingest.ts` was batched from its first
version — its real bug this session was a stride mismatch (`idx * 8` vs
the actual 9 params per row), not an absence of batching. `normalize.ts`'s
`lmia_filings` insert was genuinely one-row-at-a-time originally; batching
it was a real perf fix this session for the ~8-8000-row-per-quarter
insert loop.

## Setup

Requires a Supabase project with `supabase/schema.sql` applied. Copy
`.env.example` → `.env.local` and fill `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (currently unused by the app, see
Stack above — kept for `.env.example` parity), and `SUPABASE_DB_URL`
(URI, Session pooler / port 5432 — required, this is what everything
actually reads from). See README for the human-facing setup walkthrough.
