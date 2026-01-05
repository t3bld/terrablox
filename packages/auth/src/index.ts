import { AuthAdapter, AuthConfig } from "./adapters/base";
import { SupabaseAuthAdapter } from "./adapters/supabase";

let authInstance: AuthAdapter | null = null;

/**
 * Create an auth client based on the configured adapter
 */
export async function createAuthClient(config?: AuthConfig): Promise<AuthAdapter> {
  if (authInstance) {
    return authInstance;
  }

  const adapter = config?.adapter || process.env.AUTH_ADAPTER || "supabase";

  let client: AuthAdapter;

  switch (adapter) {
    case "supabase":
      client = new SupabaseAuthAdapter();
      break;
    case "nextauth":
      throw new Error("NextAuth adapter not yet implemented");
    case "auth0":
      throw new Error("Auth0 adapter not yet implemented");
    case "custom":
      throw new Error("Custom adapter must be provided in config");
    default:
      throw new Error(`Unknown auth adapter: ${adapter}`);
  }

  authInstance = client;
  return client;
}

/**
 * Get the existing auth client instance
 */
export function getAuthClient(): AuthAdapter {
  if (!authInstance) {
    throw new Error("Auth not initialized. Call createAuthClient() first.");
  }
  return authInstance;
}

export * from "./adapters/base";
export * from "./adapters/supabase";

