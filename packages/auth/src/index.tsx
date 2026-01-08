// =============================================================================
// Type Exports
// =============================================================================

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

export { SupabaseAuthAdapter } from "./adapters/supabase";

// =============================================================================
// Hook Exports
// =============================================================================

export { AuthProvider, useAuth, useSession, useUser } from "./hooks/use-auth";

// =============================================================================
// Server Exports
// =============================================================================

export {
  AuthRequiredError,
  createServerAuth,
  extractBearerToken,
  ForbiddenError,
  isTokenExpired,
  parseJwtPayload,
  protectedRoute,
} from "./server";

// =============================================================================
// Factory Function
// =============================================================================

import { SupabaseAuthAdapter } from "./adapters/supabase";
import type { AuthAdapter, AuthAdapterConfig } from "./types";

export function createAuth(config: AuthAdapterConfig): AuthAdapter {
  switch (config.type) {
    case "supabase":
      return new SupabaseAuthAdapter(config.config);

    case "custom":
      return config.adapter;

    default:
      throw new Error(
        `Unknown auth adapter type: ${(config as { type: string }).type}`,
      );
  }
}
