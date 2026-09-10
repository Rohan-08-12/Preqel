# Preqel

Hiring-signal intelligence for Canadian job seekers. Ingests public regulatory
data and surfaces hiring trends (ramping up / flat / declining) by company, role
family, and location — ideally before roles are publicly posted.

For the full product vision, phased roadmap, and known risks, see
`README.md` and `Preqel_Platform_Reference.pdf`. Don't duplicate them here.

## V1 scope (current focus)

- **One data source:** ESDC's quarterly Positive LMIA Employers List
  ([open.canada.ca](https://open.canada.ca/data/en/dataset/90fed587-1364-4f33-a9ee-208181dc0b97))
- Pipeline: ingest → normalize → aggregate → simple search/filter UI
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
  (`npm run ingest|normalize|aggregate`). They are **manual per-quarter batch
  jobs**, not routed through the web server or triggered by requests.

## Layout

```
/app                       Next.js App Router (UI is currently just a scaffold page)
/lib
  supabase.ts              Anon-key client — app reads only
  db.ts                    Raw pg Pool (SUPABASE_DB_URL) — batch scripts only
  employer-normalize.ts    Rule-based employer name cleanup (deterministic first pass)
/scripts
  ingest.ts                Quarterly ESDC file → raw_lmia_rows
  normalize.ts             raw_lmia_rows → employers / employer_aliases / lmia_filings
  aggregate.ts             Refreshes mv_hiring_trends materialized view
/supabase/schema.sql       Full DB schema — heavily commented, read it before touching data layers
```

## Current state

- **Working & verified** (`npm install`, `tsc`, `next build` all pass):
  repo scaffold, `supabase/schema.sql`, and `scripts/ingest.ts` (implements the
  merged-cell forward-fill — see below).
- **Stub:** `scripts/normalize.ts` is implemented only through the rule-based
  employer cleanup (`lib/employer-normalize.ts`). Still TODO (see comments in
  the file): employer fuzzy-matching + create-or-link, NOC code/title splitting
  and `role_family` mapping, address parsing (city / postal). Left unimplemented
  on purpose — those thresholds/decisions want real data, not guesses.
- UI (`app/page.tsx`) is a placeholder. Search/filter UI is unbuilt.

## ESDC data-source gotchas (affect ingest.ts / normalize.ts correctness)

- **No unique row/case identifier** in the source — only province + stream +
  employer + address + occupation + positions. No FEIN or business number.
- **Merged-cell export:** Province/Territory, Stream, and Employer columns are
  blank on repeat rows (= same as row above). MUST be forward-filled at ingest
  or aggregation silently drops most rows into null groups. `ingest.ts` already
  does this; `raw_lmia_rows` stores the *filled* values.
- **Occupation** column is a glued string like `"6322-Cooks"` — NOC code +
  title, needs splitting (normalize step, not done).
- **Address** column is a glued string like `"St. John's, NL A1E 0C2"` —
  city / province / postal in one field, needs parsing (normalize step, not done).
- **NOC version switch:** codes moved from NOC 2011 → NOC 2021 partway through
  the series (~2024). Same code string can mean different occupations by version
  — that's why `noc_codes` is versioned. Resolve per the version in effect for
  the quarter being processed.
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
parse args with `node:util` `parseArgs` (space-separated flags).

## Setup

Requires a Supabase project with `supabase/schema.sql` applied. Copy
`.env.example` → `.env.local` and fill `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, and `SUPABASE_DB_URL` (URI, Session pooler / port 5432).
See README for details.
