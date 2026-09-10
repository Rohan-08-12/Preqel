-- ============================================================================
-- Preqel v1 — Database Schema
-- Target: Postgres (Supabase)
-- Source: ESDC Positive LMIA Employers List (quarterly CSV/XLSX)
-- ============================================================================
-- Layers:
--   1. raw_lmia_rows        -- staging, unmodified rows from source files
--   2. employers             -- canonical entity table (the normalization target)
--   3. employer_aliases      -- every raw name string seen, mapped to an employer
--   4. noc_codes              -- NOC code/title reference, versioned (2011 vs 2021)
--   5. role_families          -- job-seeker-friendly occupation buckets
--   6. noc_role_family_map    -- NOC code -> role family, per NOC version
--   7. lmia_filings           -- normalized fact table (one row per source row)
--   8. mv_hiring_trends       -- materialized view: the aggregation/trend layer
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. RAW STAGING
-- Unmodified ingest of each quarterly file. Never mutated after load.
-- Keeping this separate means re-running normalization never requires
-- re-downloading source files, and lets you diff normalization logic
-- against a stable input.
-- ----------------------------------------------------------------------------
create table raw_lmia_rows (
  id                bigint generated always as identity primary key,
  source_quarter    text not null,        -- e.g. '2026Q1' — tagged at ingest time,
                                           -- since the source files have NO date column
  source_file        text not null,        -- original filename, for traceability
  row_index          int not null,         -- row's position in the source file (debugging)

  -- raw fields, exactly as they appear after forward-fill of merged cells
  -- (see note below — this is NOT the original blank-cell CSV, forward-fill
  -- happens at ingest time since it's meaningless to store it un-filled)
  province_territory text,
  stream              text,
  employer_raw        text,   -- untouched employer name string
  address_raw          text,   -- combined "City, PROV POSTAL" string, unparsed
  occupation_raw        text,   -- combined "NOC_CODE-Title" string, unparsed
  approved_positions      int,

  loaded_at           timestamptz not null default now()
);

create index idx_raw_lmia_rows_quarter on raw_lmia_rows (source_quarter);
create index idx_raw_lmia_rows_employer_raw on raw_lmia_rows (employer_raw);


-- ----------------------------------------------------------------------------
-- 2. EMPLOYERS (canonical entity)
-- This is the normalization target. One row per real-world company,
-- however many raw name variants map to it.
-- ----------------------------------------------------------------------------
create table employers (
  id                  bigint generated always as identity primary key,
  canonical_name       text not null,        -- the cleaned, display-ready name
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create unique index idx_employers_canonical_name on employers (canonical_name);


-- ----------------------------------------------------------------------------
-- 3. EMPLOYER ALIASES
-- Every distinct raw name string ever seen, mapped to a canonical employer.
-- This is where rule-based cleanup + fuzzy match + manual overrides live.
-- Rebuilding this table is how you re-run normalization without touching
-- raw_lmia_rows or re-ingesting anything.
-- ----------------------------------------------------------------------------
create table employer_aliases (
  id              bigint generated always as identity primary key,
  employer_id     bigint not null references employers (id),
  raw_name         text not null,
  match_method      text not null,   -- 'exact' | 'rule_normalized' | 'fuzzy' | 'manual_override'
  confidence         numeric,          -- 0-1, null for exact/manual
  created_at         timestamptz not null default now()
);

create unique index idx_employer_aliases_raw_name on employer_aliases (raw_name);
create index idx_employer_aliases_employer_id on employer_aliases (employer_id);


-- ----------------------------------------------------------------------------
-- 4. NOC CODES (reference table)
-- Versioned because the source data switches from NOC 2011 to NOC 2021
-- partway through the historical series — same code string can mean a
-- different occupation depending on version.
-- ----------------------------------------------------------------------------
create table noc_codes (
  id            bigint generated always as identity primary key,
  noc_version    text not null,      -- '2011' | '2021'
  code            text not null,
  title            text not null
);

create unique index idx_noc_codes_version_code on noc_codes (noc_version, code);


-- ----------------------------------------------------------------------------
-- 5. ROLE FAMILIES
-- Job-seeker-friendly buckets, e.g. "Software Engineering", "Skilled Trades —
-- Welding", "Registered Nursing". Hand-curated, not derived automatically.
-- ----------------------------------------------------------------------------
create table role_families (
  id           bigint generated always as identity primary key,
  name          text not null unique,
  description    text
);


-- ----------------------------------------------------------------------------
-- 6. NOC -> ROLE FAMILY MAP
-- Many-to-one: several NOC codes can roll into one role family.
-- Mapped per NOC version so 2011 and 2021 codes both resolve correctly
-- without needing a code crosswalk at query time.
-- ----------------------------------------------------------------------------
create table noc_role_family_map (
  id               bigint generated always as identity primary key,
  noc_code_id       bigint not null references noc_codes (id),
  role_family_id     bigint not null references role_families (id)
);

create unique index idx_noc_role_family_map_noc on noc_role_family_map (noc_code_id);


-- ----------------------------------------------------------------------------
-- 7. LMIA FILINGS (normalized fact table)
-- One row per source row, fully normalized: employer resolved, NOC code
-- and title split out, address parsed, tagged with quarter.
-- This is what the aggregation layer (below) is built on.
-- ----------------------------------------------------------------------------
create table lmia_filings (
  id                  bigint generated always as identity primary key,
  raw_row_id           bigint not null references raw_lmia_rows (id),

  source_quarter        text not null,
  employer_id            bigint not null references employers (id),
  noc_code_id             bigint references noc_codes (id),   -- nullable: some rows may fail to match
  role_family_id           bigint references role_families (id), -- nullable: derived via noc_role_family_map

  stream                    text,
  province_territory         text,
  city                        text,
  postal_code                  text,

  approved_positions             int not null,

  created_at                    timestamptz not null default now()
);

create index idx_lmia_filings_quarter on lmia_filings (source_quarter);
create index idx_lmia_filings_employer on lmia_filings (employer_id);
create index idx_lmia_filings_role_family on lmia_filings (role_family_id);
create index idx_lmia_filings_location on lmia_filings (province_territory, city);


-- ----------------------------------------------------------------------------
-- 8. AGGREGATION / TREND LAYER
-- Materialized view over lmia_filings. Refresh after each quarterly ingest.
-- Trend direction is left to the app layer for v1 (simple slope over the
-- last N quarters) rather than computed in SQL — easier to iterate on the
-- trend logic without migrating the view.
-- ----------------------------------------------------------------------------
create materialized view mv_hiring_trends as
select
  employer_id,
  role_family_id,
  province_territory,
  city,
  source_quarter,
  count(*)                as filing_count,
  sum(approved_positions)  as total_positions
from lmia_filings
group by employer_id, role_family_id, province_territory, city, source_quarter;

create unique index idx_mv_hiring_trends_key
  on mv_hiring_trends (employer_id, role_family_id, province_territory, city, source_quarter);

-- Refresh after each ingest + normalize run:
--   refresh materialized view concurrently mv_hiring_trends;
