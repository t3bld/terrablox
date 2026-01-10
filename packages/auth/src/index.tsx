export type {
  AuthAdapterConfig,
  AuthErrorCode,
  AuthResult,
  AuthStateEvent,
  OAuthProvider,
  OAuthSignInOptions,
  Session,
  SignInCredentials,
  SignUpCredentials,
  SupabaseAuthConfig,
  User,
} from "./types";

export { AuthAdapter, AuthError } from "./types";

// =============================================================================
// Adapter Exports
// =============================================================================

// Concrete adapters are no longer exported from the core package.
// Each implementation should be in its own package, e.g., `@terrablox/auth-adapter-supabase`.

// =============================================================================
// Hook Exports
// =============================================================================

export { AuthProvider, useAuth, useSession, useUser } from "./hooks/use-auth";

// =============================================================================
// Server Exports
// =============================================================================

export {
  createServerAuth,
  extractBearerToken,
  isTokenExpired,
  parseJwtPayload,
  protectedRoute,
} from "./server/server-auth";

// =============================================================================
// Factory Function
// =============================================================================

import type { AuthAdapter, AuthAdapterConfig } from "./types";

export function createAuth(config: AuthAdapterConfig): AuthAdapter {
  switch (config.type) {
    case "supabase":
      throw new Error(
        "The Supabase adapter has been moved to its own package: `@terrablox/auth-adapter-supabase`. Please install it and import the adapter directly.",
      );

    case "custom":
      return config.adapter;

    default:
      throw new Error(
        `Unknown auth adapter type: ${(config as { type: string }).type}`,
      );
  }
}
