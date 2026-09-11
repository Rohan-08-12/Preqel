import { Pool } from "pg";

// Direct Postgres connection for the batch pipeline (ingest / normalize /
// aggregate scripts) AND for the app's API routes. These scripts write
// hundreds of thousands of rows at once, which supabase-js is not built
// for efficiently — connect straight to the Supabase Postgres instance
// instead.
//
// Get this connection string from: Supabase project settings ->
// Database -> Connection string (use the "URI" format, "Session" pooler
// mode / port 5432). Session pooler, not Transaction pooler, because
// this project's Supabase dashboard reports Transaction pooler defaults
// to IPv6 and needs the paid IPv4 add-on to work from an IPv4-only
// network — Session pooler is confirmed IPv4-compatible for free. Not a
// `pg`-library requirement either way; both modes work fine with `pg`.

const connectionString = process.env.SUPABASE_DB_URL;

if (!connectionString) {
  throw new Error(
    "Missing SUPABASE_DB_URL. Copy .env.example to .env.local and fill in your Supabase connection string."
  );
}

export const pool = new Pool({
  connectionString,
  // Conservative cap, not a measured limit — Supabase's free tier has a
  // real, fairly low ceiling on concurrent connections through the
  // shared pooler, and this project is now deployable to a serverless
  // host (Vercel), where a burst of concurrent requests could otherwise
  // try to open far more connections than a single local dev server
  // ever would. Keeping this well under whatever the actual limit is
  // means a traffic spike degrades gracefully (requests queue briefly)
  // instead of hard-failing with "max clients reached" for everyone.
  max: 10,
  // Release idle connections back to the pool fairly quickly — serverless
  // invocations are short-lived, so there's little value in holding a
  // connection open waiting for the next request the way a long-running
  // local script might.
  idleTimeoutMillis: 10_000,
});
