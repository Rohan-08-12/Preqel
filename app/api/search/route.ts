import { NextRequest, NextResponse } from "next/server";
import { searchHiringSignals, type TrendDirection } from "../../../lib/hiring-trends";

const VALID_TRENDS: TrendDirection[] = ["up", "flat", "down"];

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

  try {
    const results = await searchHiringSignals({
      employerQuery,
      roleFamilyId,
      province,
      trend,
    });
    return NextResponse.json({ results });
  } catch (err) {
    console.error("Search query failed:", err);
    return NextResponse.json({ error: "Search failed" }, { status: 500 });
  }
}
