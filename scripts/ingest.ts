/**
 * Ingest an ESDC Positive LMIA quarterly file into raw_lmia_rows.
 *
 * Usage:
 *   npm run ingest -- --file ./data/tfwp_2026q1_pos_en.xlsx --quarter 2026Q1
 *
 * What this does NOT do (by design — that's normalize.ts):
 *   - resolve employer names to a canonical entity
 *   - split the combined "Occupation" field into NOC code + title
 *   - parse the combined "Address" field into city/postal code
 *
 * What this DOES do:
 *   - reads the source workbook
 *   - forward-fills the merged-cell blanks in Province/Territory, Stream,
 *     and Employer (see the Preqel data-structure notes: ESDC exports these
 *     as merged cells, so a blank means "same as the row above", not "no
 *     data" — this MUST happen before anything downstream groups by these
 *     fields, or you'll silently lose most of your province/employer values)
 *   - tags every row with the quarter and source filename, since the
 *     source file has no date column of its own
 *   - batch-inserts into raw_lmia_rows, unmodified otherwise
 */

import { parseArgs } from "node:util";
import ExcelJS from "exceljs";
import { pool } from "../lib/db";

const { values } = parseArgs({
  options: {
    file: { type: "string" },
    quarter: { type: "string" },
  },
});

const filePath = values.file;
const sourceQuarter = values.quarter;

if (!filePath || !sourceQuarter) {
  console.error(
    "Usage: npm run ingest -- --file <path to .xlsx or .csv> --quarter <e.g. 2026Q1>"
  );
  process.exit(1);
}

type RawRow = {
  source_quarter: string;
  source_file: string;
  row_index: number;
  province_territory: string | null;
  stream: string | null;
  employer_raw: string | null;
  address_raw: string | null;
  occupation_raw: string | null;
  approved_positions: number | null;
};

async function main() {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath!);
  const sheet = workbook.worksheets[0];

  const rows: RawRow[] = [];

  // Forward-fill state — carries the last non-blank value down through
  // merged-cell blanks, per column.
  let lastProvince: string | null = null;
  let lastStream: string | null = null;
  let lastEmployer: string | null = null;

  let rowIndex = 0;
  let headerSeen = false;

  sheet.eachRow((row) => {
    // Real 2026Q1 file layout — 8 data columns, header on row 2:
    //   A Province/Territory  B Program Stream  C Employer  D Address
    //   E Occupation  F Incorporate Status  G Approved LMIAs  H Approved Positions
    // (row.values is 1-indexed, so index 0 is the leading empty slot.)
    // incorporateStatusCell / approvedLmiasCell are destructured only to keep
    // the column positions self-documenting — they're not in the v1 schema.
    const [
      ,
      provinceCell,
      streamCell,
      employerCell,
      addressCell,
      occupationCell,
      incorporateStatusCell,
      approvedLmiasCell,
      positionsCell,
    ] = row.values as unknown[];

    const province = cellToString(provinceCell);
    const stream = cellToString(streamCell);
    const employer = cellToString(employerCell);
    const address = cellToString(addressCell);
    const occupation = cellToString(occupationCell);
    const positions = cellToNumber(positionsCell);

    // Skip the title row and the header row itself.
    // NOTE: this checks column C specifically because that's where "Employer"
    // currently falls in the header row. If ESDC ever reorders the columns
    // again, this detection silently stops matching and every row gets treated
    // as data (or nothing does) — start looking here if that happens.
    if (!headerSeen) {
      if (employer?.toLowerCase().includes("employer")) {
        headerSeen = true;
      }
      return;
    }

    // Forward-fill merged-cell blanks.
    if (province) lastProvince = province;
    if (stream) lastStream = stream;
    if (employer) lastEmployer = employer;

    // A row with no occupation/positions data is a stray blank row — skip it.
    if (!occupation && positions === null) return;

    rows.push({
      source_quarter: sourceQuarter!,
      source_file: filePath!.split("/").pop()!,
      row_index: rowIndex++,
      province_territory: lastProvince,
      stream: lastStream,
      employer_raw: lastEmployer,
      address_raw: address,
      occupation_raw: occupation,
      approved_positions: positions,
    });
  });

  console.log(`Parsed ${rows.length} rows from ${filePath}. Inserting...`);

  await insertBatched(rows);

  console.log(`Done. ${rows.length} rows loaded for ${sourceQuarter}.`);
  await pool.end();
}

function cellToString(cell: unknown): string | null {
  if (cell === null || cell === undefined) return null;
  const str = String(cell).trim();
  return str.length > 0 ? str : null;
}

function cellToNumber(cell: unknown): number | null {
  const str = cellToString(cell);
  if (str === null) return null;
  const n = Number(str.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

async function insertBatched(rows: RawRow[], batchSize = 500) {
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const values: unknown[] = [];
    const placeholders = batch
      .map((r, idx) => {
        const base = idx * 9;
        values.push(
          r.source_quarter,
          r.source_file,
          r.row_index,
          r.province_territory,
          r.stream,
          r.employer_raw,
          r.address_raw,
          r.occupation_raw
        );
        // approved_positions handled separately below since it's a number
        values.push(r.approved_positions);
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`;
      })
      .join(", ");

    await pool.query(
      `insert into raw_lmia_rows
        (source_quarter, source_file, row_index, province_territory, stream, employer_raw, address_raw, occupation_raw, approved_positions)
       values ${placeholders}`,
      values
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
