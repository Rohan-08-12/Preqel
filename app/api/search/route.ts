import { NextRequest, NextResponse } from "next/server";
import { searchHiringSignals, type TrendDirection } from "../../../lib/hiring-trends";

const VALID_TRENDS: TrendDirection[] = ["up", "flat", "down", "limited"];

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  const employerQuery = params.get("employer") ?? undefined;
  const province = params.get("province") ?? undefined;

  const roleFamilyIdRaw = params.get("roleFamilyId");
  const roleFamilyId = roleFamilyIdRaw ? Number(roleFamilyIdRaw) : undefined;
  if (roleFamilyIdRaw && Number.isNaN(roleFamilyId)) {
    return NextResponse.json({ error: "Invalid roleFamilyId" }, { status: 400 });
  }

  const trendRaw = params.get("trend");
  let trend: TrendDirection | undefined;
  if (trendRaw) {
    if (!VALID_TRENDS.includes(trendRaw as TrendDirection)) {
      return NextResponse.json(
        { error: `Invalid trend. Must be one of: ${VALID_TRENDS.join(", ")}` },
        { status: 400 }
      );
    }
    trend = trendRaw as TrendDirection;
  }

  const limitRaw = params.get("limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;
  if (limitRaw && (Number.isNaN(limit) || limit! < 1)) {
    return NextResponse.json({ error: "Invalid limit" }, { status: 400 });
  }

  const offsetRaw = params.get("offset");
  const offset = offsetRaw ? Number(offsetRaw) : undefined;
  if (offsetRaw && (Number.isNaN(offset) || offset! < 0)) {
    return NextResponse.json({ error: "Invalid offset" }, { status: 400 });
  }

  try {
    const { signals, total } = await searchHiringSignals({
      employerQuery,
      roleFamilyId,
      province,
      trend,
      limit,
      offset,
    });
    return NextResponse.json({ results: signals, total });
  } catch (err) {
    console.error("Search query failed:", err);
    return NextResponse.json({ error: "Search failed" }, { status: 500 });
  }
}
