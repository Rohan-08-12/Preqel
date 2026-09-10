/**
 * Refresh the aggregation layer after an ingest + normalize run.
 *
 * Usage:
 *   npm run aggregate
 *
 * mv_hiring_trends is a materialized view (see supabase/schema.sql) —
 * this just refreshes it. Trend direction (ramping up / flat / declining)
 * is computed in the app layer from this view's quarterly counts, not
 * here, so this script stays trivial by design.
 */

import { pool } from "../lib/db";

async function main() {
  console.log("Refreshing mv_hiring_trends...");
  await pool.query(`refresh materialized view concurrently mv_hiring_trends`);
  console.log("Done.");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
