import { Pool } from "pg";

// Direct Postgres connection for the batch pipeline (ingest / normalize /
// aggregate scripts). These scripts write hundreds of thousands of rows
// at once, which supabase-js is not built for efficiently — connect
// straight to the Supabase Postgres instance instead.
//
// Get this connection string from: Supabase project settings ->
// Database -> Connection string (use the "URI" format, "Transaction"
// pooler mode is fine for batch inserts).

const connectionString = process.env.SUPABASE_DB_URL;

if (!connectionString) {
  throw new Error(
    "Missing SUPABASE_DB_URL. Copy .env.example to .env.local and fill in your Supabase connection string."
  );
}

export const pool = new Pool({ connectionString });
