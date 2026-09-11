"use client";

import { useEffect, useState } from "react";

type RoleFamily = { id: number; name: string };
type TrendDirection = "up" | "flat" | "down";

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
};

const TREND_STYLE: Record<TrendDirection, string> = {
  up: "bg-green-100 text-green-800",
  flat: "bg-gray-100 text-gray-700",
  down: "bg-red-100 text-red-800",
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
    <main className="mx-auto max-w-4xl px-6 py-12">
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
        </select>
      </div>

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
        <table className="w-full table-fixed border-collapse text-sm">
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
            {results.map((r) => (
              <tr
                key={`${r.employerId}-${r.roleFamilyId}-${r.province}-${r.city}`}
                className="border-b border-gray-100"
              >
                <td className="px-1 py-2 font-medium">{r.employerName}</td>
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
            ))}
          </tbody>
        </table>
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
