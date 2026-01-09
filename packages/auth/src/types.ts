// =============================================================================
// User Types
// =============================================================================

export interface UserIdentity {
  provider: string;
  identity_id: string;
  user_id: string;
  identity_data?: Record<string, unknown>;
  created_at?: string;
  last_sign_in_at?: string;
}

export interface User {
  id: string;
  email: string;
  name?: string;
  avatarUrl?: string;
  emailVerified?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
  metadata?: Record<string, unknown>;
  identities?: UserIdentity[];
}

// =============================================================================
// Session Types
// =============================================================================

export interface Session {
  user: User;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

// =============================================================================
// Credential Types
// =============================================================================

export interface SignUpCredentials {
  email: string;
  password: string;
  name?: string;
  metadata?: Record<string, unknown>;
}

export interface SignInCredentials {
  email: string;
  password: string;
}

// =============================================================================
// OAuth Types
// =============================================================================

export type OAuthProvider = "github";

export interface OAuthSignInOptions {
  provider: OAuthProvider;
  redirectTo?: string;
  scopes?: string[];
}

// =============================================================================
// Auth Result Types
// =============================================================================

export interface AuthResult {
  user: User;
  session: Session;
}

export class AuthError extends Error {
  constructor(
    message: string,
    public code: AuthErrorCode,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export type AuthErrorCode =
  | "INVALID_CREDENTIALS"
  | "USER_NOT_FOUND"
  | "USER_ALREADY_EXISTS"
  | "EMAIL_NOT_VERIFIED"
  | "SESSION_EXPIRED"
  | "INVALID_TOKEN"
  | "NETWORK_ERROR"
  | "PROVIDER_ERROR"
  | "UNKNOWN_ERROR";

// =============================================================================
// Configuration Types
// =============================================================================

export type AuthAdapterConfig =
  | { type: "supabase"; config: SupabaseAuthConfig }
  | { type: "custom"; adapter: AuthAdapter };

export interface SupabaseAuthConfig {
  url: string;
  anonKey: string;
  serviceRoleKey?: string;
}

// =============================================================================
// Adapter Interface
// =============================================================================

export abstract class AuthAdapter {
  // ===========================================================================
  // Authentication Methods
  // ===========================================================================

  abstract signUp(credentials: SignUpCredentials): Promise<AuthResult>;
  abstract signIn(credentials: SignInCredentials): Promise<AuthResult>;
  abstract signInWithOAuth(options: OAuthSignInOptions): Promise<void>;
  abstract signOut(): Promise<void>;

  // ===========================================================================
  // Session Methods
  // ===========================================================================

  abstract getSession(): Promise<Session | null>;
  abstract refreshSession(): Promise<Session | null>;

  // ===========================================================================
  // User Methods
  // ===========================================================================

  abstract getUser(): Promise<User | null>;
  abstract updateUser(
    data: Partial<Pick<User, "name" | "avatarUrl" | "metadata">>,
  ): Promise<User>;

  // ===========================================================================
  // Password Methods
  // ===========================================================================

  abstract resetPassword(email: string, redirectTo?: string): Promise<void>;
  abstract updatePassword(newPassword: string): Promise<void>;

  // ===========================================================================
  // Provider Methods
  // ===========================================================================

  getProviderToken?(provider: string): Promise<string | null>;

  // ===========================================================================
  // Auth State Subscription
  // ===========================================================================

  onAuthStateChange?(
    callback: (event: AuthStateEvent, session: Session | null) => void,
  ): () => void;
}

// =============================================================================
// Auth State Event Types
// =============================================================================

export type AuthStateEvent =
  | "SIGNED_IN"
  | "SIGNED_OUT"
  | "TOKEN_REFRESHED"
  | "USER_UPDATED"
  | "PASSWORD_RECOVERY";
