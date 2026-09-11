"use client";

import { Fragment, useEffect, useState } from "react";

type RoleFamily = { id: number; name: string };
type TrendDirection = "up" | "flat" | "down" | "limited";

type HiringSignal = {
  employerId: number;
  employerName: string;
  roleFamilyId: number;
  roleFamilyName: string;
  province: string;
  city: string | null;
  trend: TrendDirection;
  latestQuarter: string;
  latestPositions: number;
  quarters: { quarter: string; positions: number; filingCount: number }[];
};

const TREND_LABEL: Record<TrendDirection, string> = {
  up: "Ramping up",
  flat: "Flat",
  down: "Declining",
  limited: "Limited data",
};

const TREND_STYLE: Record<TrendDirection, string> = {
  up: "bg-green-100 text-green-800",
  flat: "bg-gray-100 text-gray-700",
  down: "bg-red-100 text-red-800",
  limited: "bg-yellow-100 text-yellow-800",
};

export default function Home() {
  const [roleFamilies, setRoleFamilies] = useState<RoleFamily[]>([]);
  const [provinces, setProvinces] = useState<string[]>([]);

  const [employerQuery, setEmployerQuery] = useState("");
  const [roleFamilyId, setRoleFamilyId] = useState("");
  const [province, setProvince] = useState("");
  const [trend, setTrend] = useState("");

  const [results, setResults] = useState<HiringSignal[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  function rowKey(r: HiringSignal) {
    return `${r.employerId}-${r.roleFamilyId}-${r.province}-${r.city}`;
  }

  function toggleExpanded(key: string) {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const PAGE_SIZE = 100;

  function buildParams(offset: number) {
    const params = new URLSearchParams();
    if (employerQuery) params.set("employer", employerQuery);
    if (roleFamilyId) params.set("roleFamilyId", roleFamilyId);
    if (province) params.set("province", province);
    if (trend) params.set("trend", trend);
    params.set("limit", String(PAGE_SIZE));
    params.set("offset", String(offset));
    return params;
  }

  // Load filter dropdown options once on mount.
  useEffect(() => {
    fetch("/api/filters")
      .then((res) => res.json())
      .then((data) => {
        setRoleFamilies(data.roleFamilies ?? []);
        setProvinces(data.provinces ?? []);
      })
      .catch(() => {
        // Filter options failing to load isn't fatal — the search box
        // and results still work, just without dropdown choices.
      });
  }, []);

  // Re-run search from the start whenever any filter changes, debounced
  // for the text input so we're not firing a request on every keystroke.
  // Always resets to offset 0 — a new filter means a new result set, not
  // a continuation of the old one.
  useEffect(() => {
    const handle = setTimeout(() => {
      setLoading(true);
      setError(null);

      fetch(`/api/search?${buildParams(0).toString()}`)
        .then((res) => res.json())
        .then((data) => {
          if (data.error) {
            setError(data.error);
            setResults([]);
            setTotal(0);
          } else {
            setResults(data.results ?? []);
            setTotal(data.total ?? 0);
          }
        })
        .catch(() => setError("Search failed. Check the console for details."))
        .finally(() => setLoading(false));
    }, 300);

    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employerQuery, roleFamilyId, province, trend]);

  function loadMore() {
    setLoadingMore(true);
    fetch(`/api/search?${buildParams(results.length).toString()}`)
      .then((res) => res.json())
      .then((data) => {
        if (!data.error) {
          setResults((prev) => [...prev, ...(data.results ?? [])]);
          setTotal(data.total ?? 0);
        }
      })
      .finally(() => setLoadingMore(false));
  }

  return (
    <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Preqel</h1>
          <p className="mt-1 text-sm text-gray-600">
            Hiring signals from ESDC LMIA filings
          </p>
        </div>
      </div>

      <input
        type="text"
        placeholder="Search company name"
        value={employerQuery}
        onChange={(e) => setEmployerQuery(e.target.value)}
        className="mb-3 w-full rounded border border-gray-300 px-3 py-2 text-sm"
      />

      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <select
          value={roleFamilyId}
          onChange={(e) => setRoleFamilyId(e.target.value)}
          className="rounded border border-gray-300 px-3 py-2 text-sm"
        >
          <option value="">All role families</option>
          {roleFamilies.map((rf) => (
            <option key={rf.id} value={rf.id}>
              {rf.name}
            </option>
          ))}
        </select>

        <select
          value={province}
          onChange={(e) => setProvince(e.target.value)}
          className="rounded border border-gray-300 px-3 py-2 text-sm"
        >
          <option value="">All locations</option>
          {provinces.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>

        <select
          value={trend}
          onChange={(e) => setTrend(e.target.value)}
          className="rounded border border-gray-300 px-3 py-2 text-sm"
        >
          <option value="">All trends</option>
          <option value="up">Ramping up</option>
          <option value="flat">Flat</option>
          <option value="down">Declining</option>
          <option value="limited">Limited data</option>
        </select>
      </div>

      <details className="mb-6 rounded border border-gray-200 text-sm">
        <summary className="cursor-pointer px-3 py-2 text-gray-600 hover:text-gray-900">
          What do these trends mean?
        </summary>
        <div className="border-t border-gray-200 px-3 py-3 text-gray-600">
          <p className="mb-2">
            Each row compares an employer&apos;s hiring in one role family
            and province across ESDC&apos;s quarterly filings. Trend badges
            reflect the change between the two most recent quarters that
            employer actually filed in — not necessarily consecutive
            calendar quarters, since not every employer files every
            quarter.
          </p>
          <ul className="ml-4 list-disc space-y-1">
            <li>
              <span className="rounded bg-green-100 px-1.5 py-0.5 text-xs text-green-800">
                Ramping up
              </span>{" "}
              — approved positions increased by more than 15% since their
              previous filing, or this is the employer&apos;s first filing
              in the newest quarter of data.
            </li>
            <li>
              <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-700">
                Flat
              </span>{" "}
              — within 15% of their previous filing, in either direction.
            </li>
            <li>
              <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-800">
                Declining
              </span>{" "}
              — approved positions dropped by more than 15% since their
              previous filing.
            </li>
            <li>
              <span className="rounded bg-yellow-100 px-1.5 py-0.5 text-xs text-yellow-800">
                Limited data
              </span>{" "}
              — this employer has only one quarter of filing history so
              far, and it&apos;s not the newest quarter in the data. Not
              enough to call a real trend either way.
            </li>
          </ul>
          <p className="mt-3 text-xs text-gray-500">
            Based on ESDC&apos;s Positive LMIA Employers List, updated
            quarterly with roughly a 4-month lag. &ldquo;Positions&rdquo;
            reflects what an employer was approved to hire, not a
            confirmed headcount.
          </p>
        </div>
      </details>

      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}
      {loading && <p className="mb-4 text-sm text-gray-500">Searching…</p>}

      {!loading && !error && results.length === 0 && (
        <p className="text-sm text-gray-500">No results. Try adjusting your filters.</p>
      )}

      {!loading && results.length > 0 && (
        <p className="mb-2 text-xs text-gray-500">
          Showing {results.length} of {total.toLocaleString()} results
        </p>
      )}

      {results.length > 0 && (
        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <table className="w-full min-w-[640px] table-fixed border-collapse text-sm">
            <colgroup>
              <col className="w-[28%]" />
              <col className="w-[24%]" />
              <col className="w-[18%]" />
              <col className="w-[15%]" />
              <col className="w-[15%]" />
            </colgroup>
            <thead>
              <tr className="border-b border-gray-200 text-left text-gray-600">
                <th className="px-1 py-2 font-normal">Employer</th>
                <th className="px-1 py-2 font-normal">Role family</th>
                <th className="px-1 py-2 font-normal">Location</th>
                <th className="px-1 py-2 font-normal">Trend</th>
                <th className="px-1 py-2 text-right font-normal">Positions</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => {
                const key = rowKey(r);
                const isExpanded = expandedRows.has(key);
                return (
                  <Fragment key={key}>
                    <tr
                      onClick={() => toggleExpanded(key)}
                      className="cursor-pointer border-b border-gray-100 hover:bg-gray-50"
                    >
                      <td className="px-1 py-2 font-medium">
                        <span className="mr-1.5 inline-block w-3 text-gray-400">
                          {isExpanded ? "▾" : "▸"}
                        </span>
                        {r.employerName}
                      </td>
                      <td className="px-1 py-2 text-gray-600">{r.roleFamilyName}</td>
                      <td className="px-1 py-2 text-gray-600">
                        {r.city ? `${r.city}, ` : ""}
                        {r.province}
                      </td>
                      <td className="px-1 py-2">
                        <span
                          className={`rounded px-2 py-0.5 text-xs ${TREND_STYLE[r.trend]}`}
                        >
                          {TREND_LABEL[r.trend]}
                        </span>
                      </td>
                      <td className="px-1 py-2 text-right">{r.latestPositions}</td>
                    </tr>
                    {isExpanded && (
                      <tr className="border-b border-gray-100 bg-gray-50">
                        <td colSpan={5} className="px-4 py-3">
                          <p className="mb-2 text-xs font-medium text-gray-500">
                            Quarter-by-quarter history
                          </p>
                          <div className="flex flex-wrap gap-2">
                            {r.quarters.map((q) => (
                              <span
                                key={q.quarter}
                                className="rounded border border-gray-200 bg-white px-2 py-1 text-xs text-gray-600"
                              >
                                <span className="font-medium text-gray-800">{q.quarter}</span>
                                : {q.positions} position{q.positions === 1 ? "" : "s"}
                                {q.filingCount > 1 ? ` (${q.filingCount} filings)` : ""}
                              </span>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {results.length > 0 && results.length < total && (
        <div className="mt-4 flex justify-center">
          <button
            onClick={loadMore}
            disabled={loadingMore}
            className="rounded border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50 disabled:opacity-50"
          >
            {loadingMore ? "Loading…" : `Load more (${(total - results.length).toLocaleString()} remaining)`}
          </button>
        </div>
      )}
    </main>
  );
}
