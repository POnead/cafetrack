import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "./auth";
import { localDb } from "./local-db";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

/**
 * Set CAFETRACK_DB=local in .env.local to run against the bundled PGlite
 * database instead of Supabase — no account, no network.
 */
export const usingLocalDb =
  (process.env.CAFETRACK_DB ?? "").trim().toLowerCase() === "local";

/**
 * Loosely-typed database handle. Supabase and the local PGlite adapter both
 * satisfy it, which is what lets every API route stay unchanged between the
 * two modes. (Without a generated Database type, supabase-js results were
 * effectively `any` here anyway.)
 */
export type DbFacade = {
  from: (table: string) => any;
  rpc: (name: string, params?: Record<string, unknown>) => any;
};

/** The values shipped in .env.example are templates, not real config. */
const PLACEHOLDERS = [/your-project-ref/i, /xxxx/i, /^your-/i, /change-me/i];

function looksUnset(value: string | undefined): boolean {
  return !value || PLACEHOLDERS.some((p) => p.test(value.trim()));
}

/**
 * Server-side client using the service role key.
 * Bypasses RLS — only ever import this from API routes / server code.
 */
let _db: SupabaseClient | null = null;

export function db(): DbFacade {
  if (usingLocalDb) return localDb() as unknown as DbFacade;

  // Resolved lazily rather than at import time, so `next build` and the login
  // screen still work before .env.local is filled in. Unconfigured values get
  // a plain-English message instead of a bare "TypeError: fetch failed"
  // from an unresolvable hostname.
  if (looksUnset(url)) {
    throw new HttpError(
      503,
      "Supabase is not configured: .env.local still has the placeholder NEXT_PUBLIC_SUPABASE_URL. Either paste your real project URL, or set CAFETRACK_DB=local to run on the bundled local database."
    );
  }

  if (looksUnset(serviceKey)) {
    throw new HttpError(
      503,
      "Supabase is not configured: .env.local still has the placeholder SUPABASE_SERVICE_ROLE_KEY. Paste the service_role key from Supabase > Project Settings > API, or set CAFETRACK_DB=local to run locally."
    );
  }

  if (!_db) {
    _db = createClient(url!, serviceKey!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _db as unknown as DbFacade;
}

