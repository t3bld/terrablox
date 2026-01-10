import { createContext, type ReactNode } from "react";

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

export interface Session {
  user: User;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

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

export type OAuthProvider = "github";

export interface OAuthSignInOptions {
  provider: OAuthProvider;
  redirectTo?: string;
  scopes?: string[];
}

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

export type AuthAdapterConfig =
  | { type: "supabase"; config: SupabaseAuthConfig }
  | { type: "custom"; adapter: AuthAdapter };

export interface SupabaseAuthConfig {
  url: string;
  anonKey: string;
  serviceRoleKey?: string;
}

export abstract class AuthAdapter {
  abstract signUp(credentials: SignUpCredentials): Promise<AuthResult>;
  abstract signIn(credentials: SignInCredentials): Promise<AuthResult>;
  abstract signInWithOAuth(options: OAuthSignInOptions): Promise<void>;
  abstract signOut(): Promise<void>;
  abstract getSession(): Promise<Session | null>;
  abstract refreshSession(): Promise<Session | null>;
  abstract getUser(): Promise<User | null>;
  abstract updateUser(
    data: Partial<Pick<User, "name" | "avatarUrl" | "metadata">>,
  ): Promise<User>;
  abstract resetPassword(email: string, redirectTo?: string): Promise<void>;
  abstract updatePassword(newPassword: string): Promise<void>;
  getProviderToken?(provider: string): Promise<string | null>;
  onAuthStateChange?(
    callback: (event: AuthStateEvent, session: Session | null) => void,
  ): () => void;
}

export type AuthStateEvent =
  | "SIGNED_IN"
  | "SIGNED_OUT"
  | "TOKEN_REFRESHED"
  | "USER_UPDATED"
  | "PASSWORD_RECOVERY";

export interface ServerAuth {
  isAuthenticated: (
    req: Request,
    res: {
      cookies: {
        set: (
          name: string,
          value: string,
          options?: Record<string, unknown>,
        ) => void;
      };
    },
  ) => Promise<boolean>;
}

export interface AuthState {
  user: User | null;
  session: Session | null;
  isLoading: boolean;
  isAuthenticated: boolean;
}

export interface AuthActions {
  signUp: (
    credentials: SignUpCredentials,
    options?: { onSuccess?: () => void },
  ) => Promise<void>;
  signIn: (
    credentials: SignInCredentials,
    options?: { onSuccess?: () => void },
  ) => Promise<void>;
  signInWithOAuth: (
    provider: OAuthProvider,
    options?: { redirectTo?: string; scopes?: string[] },
  ) => Promise<void>;
  signOut: (options?: { onSuccess?: () => void }) => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  updatePassword: (newPassword: string) => Promise<void>;
  updateUser: (
    data: Partial<Pick<User, "name" | "avatarUrl">>,
  ) => Promise<void>;
  refreshSession: () => Promise<void>;
  getProviderToken: (provider: OAuthProvider) => Promise<string | null>;
}

export type AuthContextValue = AuthState & AuthActions;

export interface AuthProviderProps {
  adapter: AuthAdapter;
  children: ReactNode;
  loadingComponent?: ReactNode;
  onAuthStateChange?: (user: User | null) => void;
}
