// =============================================================================
// Type Exports
// =============================================================================

export type {
  User,
  Session,
  SignUpCredentials,
  SignInCredentials,
  OAuthProvider,
  OAuthSignInOptions,
  AuthResult,
  AuthErrorCode,
  AuthStateEvent,
  SupabaseAuthConfig,
  AuthAdapterConfig,
} from "./types";

export { AuthAdapter, AuthError } from "./types";

// =============================================================================
// Adapter Exports
// =============================================================================

export { SupabaseAuthAdapter } from "./adapters/supabase";

// =============================================================================
// Hook Exports
// =============================================================================

export { AuthProvider, useAuth, useUser, useSession } from "./hooks/use-auth";

// =============================================================================
// Server Exports
// =============================================================================

export {
  createServerAuth,
  protectedRoute,
  extractBearerToken,
  parseJwtPayload,
  isTokenExpired,
  AuthRequiredError,
  ForbiddenError,
} from "./server";

// =============================================================================
// Factory Function
// =============================================================================

import type { AuthAdapter, AuthAdapterConfig } from "./types";
import { SupabaseAuthAdapter } from "./adapters/supabase";

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
