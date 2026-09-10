import { createClient } from "@supabase/supabase-js";

// Client for use inside the Next.js app (API routes, server components).
// Uses the public anon key — fine for read-only queries against
// aggregate/lookup tables. Never use this client for bulk writes;
// see lib/db.ts for the ingest-script connection instead.

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. Copy .env.example to .env.local and fill in your Supabase project values."
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
