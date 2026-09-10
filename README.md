# Preqel

Hiring-signal intelligence, built from Canadian public regulatory data.
v1 ingests ESDC's quarterly Positive LMIA Employers List, normalizes
employer names and occupation codes, and surfaces hiring trends via a
simple search/filter UI.

See `Preqel_Platform_Reference.pdf` (project reference doc) for the full
product vision, phased roadmap, and known risks/limitations.

## Stack

- **Frontend/API**: Next.js (App Router), TypeScript
- **Storage**: Supabase (Postgres)
- **Ingest pipeline**: standalone TypeScript scripts (not routed through
  the web server — these are batch jobs run manually per quarter)
- **UI**: React + Tailwind, no component library

## Repo layout

```
/app                  Next.js App Router (UI + API routes)
/lib
  supabase.ts          Supabase client (anon key) — used by the app for reads
  db.ts                 Raw Postgres pool — used by ingest/normalize/aggregate scripts
  employer-normalize.ts  Rule-based employer name cleanup (first pass)
/scripts
  ingest.ts              Parse a quarterly ESDC file -> raw_lmia_rows
  normalize.ts             raw_lmia_rows -> employers / employer_aliases / lmia_filings
  aggregate.ts               Refresh the mv_hiring_trends materialized view
/supabase
  schema.sql                  Full DB schema — run this against your Supabase project
```

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
     (Legacy `anon` JWT keys still work but are deprecated by end of 2026.)
   - `SUPABASE_DB_URL` — from Supabase project settings -> Database ->
     Connection string (URI format, "Session" pooler mode / port 5432 —
     the batch scripts use `pg`, which wants session mode)

5. **Run the app**:
   ```
   npm run dev
   ```
   Visit `http://localhost:3000`.

## Running the data pipeline

Download a quarterly file from the
[ESDC Positive LMIA Employers List](https://open.canada.ca/data/en/dataset/90fed587-1364-4f33-a9ee-208181dc0b97)
into a local `data/` folder (gitignored — don't commit source files), then:

```
npm run ingest -- --file ./data/tfwp_2026q1_pos_en.xlsx --quarter 2026Q1
npm run normalize -- --quarter 2026Q1
npm run aggregate
```

**Status note**: `ingest.ts` implements the forward-fill logic for ESDC's
merged-cell export quirk (Province/Stream/Employer columns repeat as
blank cells — see schema comments) and loads raw rows. `normalize.ts` is
a stub — employer fuzzy-matching, NOC code splitting, and address
parsing still need real implementation before the pipeline is usable
end to end. See the TODOs in that file.

## Known scope limits (v1)

- No auth, single-user local tool
- ESDC LMIA data only — no StatCan, provincial layoff notices, SEDAR+,
  or GitHub signals yet (see reference doc phases v2+)
- Quarterly data only, published with a ~4 month lag — no real-time signal
