import type { ServerAuth } from "./server-auth";
import { createSupabaseServerAuth } from "./providers/supabase-server-auth";

/**
 * Factory for middleware/server auth.
 *
 * Open-source friendly approach:
 * - Default implementation uses Supabase.
 * - Teams can swap this by changing ONE file.
 */
export function getServerAuth(): ServerAuth {
  return createSupabaseServerAuth();
}
