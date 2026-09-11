import { pool } from "./db";

export type TrendDirection = "up" | "flat" | "down";

export type QuarterDatum = {
  quarter: string;
  positions: number;
  filingCount: number;
};

export type HiringSignal = {
  employerId: number;
  employerName: string;
  roleFamilyId: number;
  roleFamilyName: string;
  province: string;
  city: string | null;
  trend: TrendDirection;
  latestQuarter: string;
  latestPositions: number;
  quarters: QuarterDatum[];
};

export type SearchFilters = {
  employerQuery?: string;
  roleFamilyId?: number;
  province?: string;
  trend?: TrendDirection;
  limit?: number;
  offset?: number;
};

export type SearchResult = {
  signals: HiringSignal[];
  total: number;
};

// +/-15% change between the two most recent quarters a group has data
// for. Arbitrary but reasonable starting threshold for v1 — easy to
// revisit once there's enough quarters of real data to see what a
// meaningful vs. noisy swing actually looks like.
const TREND_CHANGE_THRESHOLD = 0.15;

/**
 * Classifies trend direction for one employer+role+location group, given
 * its quarters sorted ascending and the most recent quarter present
 * ANYWHERE in the overall dataset (not just this group).
 *
 * The "latestOverallQuarter" parameter is what makes this correct rather
 * than naive: a group with only ONE quarter of data is ambiguous on its
 * own — it could be a brand-new filer (should read as "up") or a filer
 * that existed in an older quarter and simply didn't appear in the most
 * recent one (should read as "down", not "up"). Distinguishing those two
 * cases requires knowing what the newest quarter in the whole dataset
 * is, not just what this group happens to have.
 */
export function classifyTrend(
  sortedQuarters: QuarterDatum[],
  latestOverallQuarter: string
): TrendDirection {
  if (sortedQuarters.length === 0) {
    throw new Error("classifyTrend called with no quarters");
  }

  const latest = sortedQuarters[sortedQuarters.length - 1];
  const previous =
    sortedQuarters.length > 1 ? sortedQuarters[sortedQuarters.length - 2] : null;

  if (previous) {
    const change = (latest.positions - previous.positions) / previous.positions;
    if (change > TREND_CHANGE_THRESHOLD) return "up";
    if (change < -TREND_CHANGE_THRESHOLD) return "down";
    return "flat";
  }

  // Only one quarter of data for this group. Whether that reads as "up"
  // or "down" depends entirely on whether that one quarter IS the newest
  // quarter in the dataset (genuinely new filer) or an OLDER one (they
  // stopped appearing — the group is absent from the current quarter).
  return latest.quarter === latestOverallQuarter ? "up" : "down";
}

function titleCaseDisplayName(name: string): string {
  return name
    .toLowerCase()
    .replace(/(^|[\s-])([a-zà-ÿ])/g, (_match, boundary, letter) => boundary + letter.toUpperCase());
}

/**
 * Groups raw mv_hiring_trends rows (already joined with employer/role
 * family names) by employer+role+province+city, and classifies a trend
 * for each group. Pure function — no DB access — so it's testable
 * against fabricated rows without a live database.
 */
export function groupAndClassify(
  rows: Array<{
    employer_id: number;
    employer_name: string;
    role_family_id: number;
    role_family_name: string;
    province_territory: string;
    city: string | null;
    source_quarter: string;
    filing_count: number;
    total_positions: number;
  }>
): HiringSignal[] {
  if (rows.length === 0) return [];

  const latestOverallQuarter = [...new Set(rows.map((r) => r.source_quarter))].sort().pop()!;

  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = `${row.employer_id}|${row.role_family_id}|${row.province_territory}|${row.city ?? ""}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  const signals: HiringSignal[] = [];
  for (const groupRows of groups.values()) {
    const sorted = [...groupRows].sort((a, b) =>
      a.source_quarter.localeCompare(b.source_quarter)
    );
    const quarters: QuarterDatum[] = sorted.map((r) => ({
      quarter: r.source_quarter,
      positions: r.total_positions,
      filingCount: r.filing_count,
    }));

    const trend = classifyTrend(quarters, latestOverallQuarter);
    const latest = sorted[sorted.length - 1];

    signals.push({
      employerId: latest.employer_id,
      employerName: titleCaseDisplayName(latest.employer_name),
      roleFamilyId: latest.role_family_id,
      roleFamilyName: latest.role_family_name,
      province: latest.province_territory,
      city: latest.city,
      trend,
      latestQuarter: latest.source_quarter,
      latestPositions: latest.total_positions,
      quarters,
    });
  }

  return signals;
}

export async function getFilterOptions() {
  const [{ rows: roleFamilyRows }, { rows: provinceRows }] = await Promise.all([
    pool.query<{ id: string; name: string }>(
      `select id, name from role_families order by name`
    ),
    pool.query<{ province_territory: string }>(
      `select distinct province_territory from mv_hiring_trends
        where province_territory is not null
        order by province_territory`
    ),
  ]);
  return {
    // role_families.id is a bigint identity column — node-postgres
    // returns bigint as a string by default (to avoid silently losing
    // precision above Number.MAX_SAFE_INTEGER), so this needs an
    // explicit Number() coercion rather than trusting the query's
    // declared TypeScript type, which is just a compile-time assertion
    // and doesn't actually change what the driver hands back at runtime.
    roleFamilies: roleFamilyRows.map((r) => ({ id: Number(r.id), name: r.name })),
    provinces: provinceRows.map((p) => p.province_territory),
  };
}

// Raw shape actually returned by pg for the search query — bigint/numeric
// columns (ids, count(*), sum(...)) come back as strings, not numbers.
// See the comment in getFilterOptions for why. mapRawRow converts this
// into the real numeric shape groupAndClassify expects.
type RawSignalRow = {
  employer_id: string;
  employer_name: string;
  role_family_id: string;
  role_family_name: string;
  province_territory: string;
  city: string | null;
  source_quarter: string;
  filing_count: string;
  total_positions: string;
};

function mapRawRow(row: RawSignalRow) {
  return {
    employer_id: Number(row.employer_id),
    employer_name: row.employer_name,
    role_family_id: Number(row.role_family_id),
    role_family_name: row.role_family_name,
    province_territory: row.province_territory,
    city: row.city,
    source_quarter: row.source_quarter,
    filing_count: Number(row.filing_count),
    total_positions: Number(row.total_positions),
  };
}

// Defaults chosen to keep the unfiltered/no-filter case from returning
// an ever-growing, unbounded result set as more quarters get ingested
// (8 quarters already pushes this well past tens of thousands of
// grouped signals).
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export async function searchHiringSignals(
  filters: SearchFilters
): Promise<SearchResult> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.employerQuery) {
    params.push(`%${filters.employerQuery.toUpperCase()}%`);
    conditions.push(`e.canonical_name ilike $${params.length}`);
  }
  if (filters.roleFamilyId !== undefined) {
    params.push(filters.roleFamilyId);
    conditions.push(`mv.role_family_id = $${params.length}`);
  }
  if (filters.province) {
    params.push(filters.province);
    conditions.push(`mv.province_territory = $${params.length}`);
  }

  const where = conditions.length ? `where ${conditions.join(" and ")}` : "";

  const { rows } = await pool.query<RawSignalRow>(
    `select mv.employer_id, e.canonical_name as employer_name,
            mv.role_family_id, rf.name as role_family_name,
            mv.province_territory, mv.city, mv.source_quarter,
            mv.filing_count, mv.total_positions
       from mv_hiring_trends mv
       join employers e on e.id = mv.employer_id
       join role_families rf on rf.id = mv.role_family_id
       ${where}`,
    params
  );

  const grouped = groupAndClassify(rows.map(mapRawRow));

  // Trend filtering happens after grouping/classification, since trend
  // is an app-layer computation, not a stored column — can't filter it
  // in SQL. Fine at v1 data volumes (thousands of rows, not millions).
  const filtered = filters.trend
    ? grouped.filter((s) => s.trend === filters.trend)
    : grouped;

  // Stable sort BEFORE paging — without an explicit order, slicing by
  // offset/limit would return a different, meaningless subset on every
  // call (Map iteration order isn't a guaranteed sort). Ranking by
  // latestPositions descending surfaces the biggest, most relevant
  // signals first, matching how we've been eyeballing results in SQL
  // throughout this project.
  const sorted = [...filtered].sort((a, b) => b.latestPositions - a.latestPositions);

  const total = sorted.length;
  const limit = Math.min(filters.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const offset = filters.offset ?? 0;

  return {
    signals: sorted.slice(offset, offset + limit),
    total,
  };
}
