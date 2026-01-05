export interface AuthUser {
  id: string;
  email: string;
  name?: string;
  avatar_url?: string;
}

export interface SignUpCredentials {
  email: string;
  password: string;
  name?: string;
}

export interface SignInCredentials {
  email: string;
  password: string;
}

export interface AuthSession {
  user: AuthUser;
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
}

export interface OAuthProvider {
  provider: "google" | "github" | "gitlab" | "azure" | "facebook";
  redirectTo?: string;
}

/**
 * Base authentication adapter interface
 * All auth adapters must implement this interface
 */
export abstract class AuthAdapter {
  abstract signUp(credentials: SignUpCredentials): Promise<AuthSession>;
  abstract signIn(credentials: SignInCredentials): Promise<AuthSession>;
  abstract signOut(): Promise<void>;
  abstract getUser(): Promise<AuthUser | null>;
  abstract getSession(): Promise<AuthSession | null>;
  abstract signInWithOAuth(params: OAuthProvider): Promise<void>;
  abstract resetPassword(email: string): Promise<void>;
  abstract updatePassword(newPassword: string): Promise<void>;
}

export interface AuthConfig {
  adapter: "supabase" | "nextauth" | "auth0" | "custom";
  options?: Record<string, unknown>;
}

