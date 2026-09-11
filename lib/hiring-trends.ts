import { pool } from "./db";

export type TrendDirection = "up" | "flat" | "down" | "limited";

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
 * Classifies trend direction for one employer+role+province group, given
 * its quarters sorted ascending and the most recent quarter present
 * ANYWHERE in the overall dataset (not just this group).
 *
 * The "latestOverallQuarter" parameter is what makes this correct rather
 * than naive: a group with only ONE quarter of data is ambiguous on its
 * own. Two sub-cases:
 *   - That one quarter IS the newest in the dataset: a genuinely NEW
 *     filer. That's real, informative signal — "up" is the right call.
 *   - That one quarter is an OLDER one, and the group has nothing in the
 *     newest quarter: this does NOT mean the same thing as a measured
 *     decline. It might mean the employer simply hasn't filed again yet,
 *     a data quirk, or a real drop-off — we can't tell from one point.
 *     Labeling this "down" overstates what we actually know (real
 *     testing against live data showed employers with genuinely
 *     continuous, growing multi-quarter history getting mislabeled
 *     "Declining" this way once grouped at a granularity sparse enough
 *     to produce lots of single-quarter groups). "limited" is the
 *     honest label: not enough history to call a direction either way.
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

  return latest.quarter === latestOverallQuarter ? "up" : "limited";
}

function titleCaseDisplayName(name: string): string {
  return name
    .toLowerCase()
    .replace(/(^|[\s-])([a-zà-ÿ])/g, (_match, boundary, letter) => boundary + letter.toUpperCase());
}

/**
 * Groups raw mv_hiring_trends rows (already joined with employer/role
 * family names) by employer+role+province, and classifies a trend for
 * each group. Pure function — no DB access — so it's testable against
 * fabricated rows without a live database.
 *
 * Deliberately does NOT include city in the grouping key. Earlier it
 * did, and real testing against live data showed this was actively
 * misleading: a company like Amazon files across many different cities
 * within the same province, often skipping a specific city for a
 * quarter or two even while overall hiring is healthy and growing. At
 * city granularity, 74% of all groups ended up with only one quarter of
 * data each (verified: 57,634 of 78,034 groups), which meant the
 * single-quarter classification fallback was doing most of the work,
 * not genuine multi-quarter trend detection — and it was systematically
 * mislabeling continuously-growing employers as "Declining" just
 * because their filings happened to be spread across cities rather
 * than concentrated in one. Grouping by province instead lets a
 * company's real provincial hiring pattern show through.
 *
 * city is still tracked and shown for display — chosen as the highest-
 * position city within the group's own most recent quarter (alphabetical
 * tie-break for determinism) — it's just no longer part of what decides
 * whether two rows belong to the same trend history.
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
    const key = `${row.employer_id}|${row.role_family_id}|${row.province_territory}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  const signals: HiringSignal[] = [];
  for (const groupRows of groups.values()) {
    // Sum positions/filingCount across cities that share the same
    // quarter, so one row per quarter feeds the trend classifier.
    const byQuarter = new Map<string, { positions: number; filingCount: number }>();
    for (const row of groupRows) {
      const existing = byQuarter.get(row.source_quarter);
      if (existing) {
        existing.positions += row.total_positions;
        existing.filingCount += row.filing_count;
      } else {
        byQuarter.set(row.source_quarter, {
          positions: row.total_positions,
          filingCount: row.filing_count,
        });
      }
    }

    const quarters: QuarterDatum[] = [...byQuarter.entries()]
      .map(([quarter, v]) => ({ quarter, positions: v.positions, filingCount: v.filingCount }))
      .sort((a, b) => a.quarter.localeCompare(b.quarter));

    const trend = classifyTrend(quarters, latestOverallQuarter);
    const latestQuarterStr = quarters[quarters.length - 1].quarter;
    const latestQuarterTotals = byQuarter.get(latestQuarterStr)!;

    // Display city: the highest-position city among this group's rows
    // in its own most recent quarter. Alphabetical tie-break for
    // determinism (not for any meaningful reason — just needs to be
    // stable across runs).
    let displayCity: string | null = null;
    let bestCityPositions = -Infinity;
    for (const row of groupRows) {
      if (row.source_quarter !== latestQuarterStr || row.city === null) continue;
      const better =
        row.total_positions > bestCityPositions ||
        (row.total_positions === bestCityPositions &&
          displayCity !== null &&
          row.city.localeCompare(displayCity) < 0);
      if (better) {
        bestCityPositions = row.total_positions;
        displayCity = row.city;
      }
    }

    const first = groupRows[0];
    signals.push({
      employerId: first.employer_id,
      employerName: titleCaseDisplayName(first.employer_name),
      roleFamilyId: first.role_family_id,
      roleFamilyName: first.role_family_name,
      province: first.province_territory,
      city: displayCity,
      trend,
      latestQuarter: latestQuarterStr,
      latestPositions: latestQuarterTotals.positions,
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
