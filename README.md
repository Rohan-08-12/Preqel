# Preqel

Hiring-signal intelligence, built from Canadian public regulatory data.
v1 ingests ESDC's quarterly Positive LMIA Employers List, normalizes
employer names and occupation codes, and surfaces hiring trends via a
search/filter UI.

See `Preqel_Platform_Reference.pdf` (project reference doc) for the full
product vision, phased roadmap, and known risks/limitations. See
`CLAUDE.md` for design decisions and why the pipeline is built the way
it is.

## Stack

- **Frontend/API**: Next.js (App Router), TypeScript
- **Storage**: Supabase (Postgres)
- **Ingest pipeline**: standalone TypeScript scripts (not routed through
  the web server — these are batch jobs run manually per quarter)
- **UI**: React + Tailwind, no component library

## Repo layout

```
/app
  page.tsx                   Search/filter UI
  api/search/route.ts        GET — filtered, paginated hiring signals
  api/filters/route.ts       GET — dropdown options (role families, provinces)
/lib
  db.ts                      Raw pg Pool (SUPABASE_DB_URL) — used by scripts
                             AND by the app's API routes (see note below)
  supabase.ts                Anon/publishable-key client — scaffolded, not
                             currently used anywhere; the app reads via db.ts
  employer-normalize.ts      Rule-based employer name cleanup
  employer-plural.ts         Singular/plural variant matching
  employer-match.ts          Fuzzy matching (edit-distance + length prefilter)
  noc-split.ts               NOC code/title split + broad-category role families
  address-parse.ts           Address string -> city + postal code
  hiring-trends.ts           Trend classification + the search query itself
/scripts
  ingest.ts                  Parse a quarterly ESDC file -> raw_lmia_rows
  normalize.ts               raw_lmia_rows -> employers / employer_aliases / lmia_filings
  aggregate.ts               Refresh the mv_hiring_trends materialized view
/supabase
  schema.sql                 Full DB schema — run this against your Supabase project
```

**Note on `lib/db.ts` vs `lib/supabase.ts`**: both the batch scripts *and*
the Next.js API routes currently query Postgres directly through `lib/db.ts`
(the `pg` pool with full write access), not through the anon-key Supabase
client in `lib/supabase.ts`. That's fine for a single-user local tool with
no RLS policies set up — see "Known limitations" below before deploying
this anywhere public.

## Setup

1. **Create a Supabase project** at supabase.com (free tier is fine for v1).

2. **Run the schema** against your project: open the Supabase SQL editor
   and paste in the contents of `supabase/schema.sql`, or run it via
   `psql` using your connection string.

3. **Install dependencies**:
   ```
   npm install
   ```

4. **Copy environment variables**:
   ```
   cp .env.example .env.local
   ```
   Fill in:
   - `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` —
     the publishable key (`sb_publishable_...`), from the "Connect" dialog
     in the project header or Supabase project settings -> API Keys.
     (Legacy `anon` JWT keys still work but are deprecated by end of 2026.
     Currently unused by the app itself — see note above — but kept for
     when a client-side query is added.)
   - `SUPABASE_DB_URL` — from Supabase project settings -> Database ->
     Connection string (URI format, "Session" pooler mode / port 5432 —
     confirmed IPv4-compatible for local development without the paid
     IPv4 add-on; the Transaction pooler defaults to IPv6, which an
     IPv4-only local network can't reach. `pg` itself has no preference
     between pooler modes)

5. **Run the app**:
   ```
   npm run dev
   ```
   Visit `http://localhost:3000`. Search by employer name, filter by role
   family / province / trend direction, and page through results with
   "Load more".

## Running the data pipeline

Download a quarterly file from the
[ESDC Positive LMIA Employers List](https://open.canada.ca/data/en/dataset/90fed587-1364-4f33-a9ee-208181dc0b97)
into a local `data/` folder (gitignored — don't commit source files), then:

```
npm run ingest -- --file ./data/tfwp_2026q1_pos_en.xlsx --quarter 2026Q1
npm run normalize -- --quarter 2026Q1
npm run aggregate
```

Both `ingest` and `normalize` parse args with `node:util` `parseArgs`
(space-separated: `--quarter 2026Q1`, not `--quarter=2026Q1`).

The pipeline is fully implemented end to end: `ingest.ts` loads raw rows,
`normalize.ts` resolves employers (rule-based cleanup → plural check →
fuzzy match → new employer) and populates `lmia_filings` (NOC split,
role family, address parse), and `aggregate.ts` refreshes the trends
view. 8 quarters (2024Q2 through 2026Q1) are currently loaded —
~124,700 raw rows, fully resolved.

`normalize.ts` logs a `[REVIEW]` line for any employer name that's a
plausible-but-not-certain fuzzy match to an existing one, rather than
guessing — worth periodically grepping those logs for names that
should be merged via a `manual_override` alias.

## Known limitations

- No auth, single-user local tool. No RLS policies on any table — fine
  since nothing client-side queries Supabase directly today (see the
  `lib/db.ts` note above), but relevant if that ever changes.
- ESDC LMIA data only — no StatCan, provincial layoff notices, SEDAR+,
  or GitHub signals yet (see reference doc phases v2+).
- Quarterly data only, published with a ~4 month lag — no real-time signal.
- Trend classification uses a fixed ±15% change threshold between the
  two most recent quarters a group has data for — an early, adjustable
  heuristic, not a statistically tuned one.
- Employer search is a plain `ILIKE` substring match — a numbered
  company (e.g. "3274876 Nova Scotia Limited") can swamp results for a
  common location-name search. Not yet addressed.
- Numbered companies deliberately skip fuzzy matching (see CLAUDE.md),
  so spacing variants of the same number (e.g. "3324608 Nova Scotia"
  vs "3324608 Novascotia") could in theory create duplicate employer
  records. Not yet observed at scale, not yet addressed.
- All 8 loaded quarters use NOC 2021 codes; the NOC version is
  hardcoded in `normalize.ts` and will need updating if an older
  (NOC 2011, pre-2024Q2) quarter is ever ingested.
