import { NextResponse } from "next/server";
import { getFilterOptions } from "../../../lib/hiring-trends";

export async function GET() {
  try {
    const options = await getFilterOptions();
    return NextResponse.json(options);
  } catch (err) {
    console.error("Failed to load filter options:", err);
    return NextResponse.json({ error: "Failed to load filter options" }, { status: 500 });
  }
}
