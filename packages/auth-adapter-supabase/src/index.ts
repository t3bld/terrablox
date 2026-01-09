import { createBrowserClient } from "@supabase/ssr";
import type {
  AuthError as SupabaseAuthError,
  SupabaseClient,
} from "@supabase/supabase-js";
import {
  AuthAdapter,
  AuthError,
  type AuthResult,
  type AuthStateEvent,
  type OAuthSignInOptions,
  type Session,
  type SignInCredentials,
  type SignUpCredentials,
  type SupabaseAuthConfig,
  type User,
} from "@terrablox/auth";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import type { ServerAuth } from "@terrablox/auth/server";

// =============================================================================
// Supabase Auth Adapter
// =============================================================================

export class SupabaseAuthAdapter extends AuthAdapter {
  private client: SupabaseClient;

  constructor(config: SupabaseAuthConfig) {
    super();
    this.client = createBrowserClient(config.url, config.anonKey);
  }

  // ===========================================================================
  // Authentication Methods
  // ===========================================================================

  async signUp(credentials: SignUpCredentials): Promise<AuthResult> {
    const { data, error } = await this.client.auth.signUp({
      email: credentials.email,
      password: credentials.password,
      options: {
        data: {
          name: credentials.name,
          ...credentials.metadata,
        },
      },
    });

    if (error) {
      throw this.mapError(error);
    }

    if (!data.user) {
      throw new AuthError("No user returned from sign up", "UNKNOWN_ERROR");
    }

    // Note: Session may be null if email confirmation is required
    if (!data.session) {
      // Return user without session (email confirmation pending)
      return {
        user: this.mapUser(data.user),
        session: {
          user: this.mapUser(data.user),
          accessToken: "",
          expiresAt: 0,
        },
      };
    }

    return {
      user: this.mapUser(data.user),
      session: this.mapSession(data.session),
    };
  }

  async signIn(credentials: SignInCredentials): Promise<AuthResult> {
    const { data, error } = await this.client.auth.signInWithPassword({
      email: credentials.email,
      password: credentials.password,
    });

    if (error) {
      throw this.mapError(error);
    }

    if (!data.user) {
      throw new AuthError("No user returned from sign in", "UNKNOWN_ERROR");
    }

    if (!data.session) {
      throw new AuthError("No session returned from sign in", "UNKNOWN_ERROR");
    }

    return {
      user: this.mapUser(data.user),
      session: this.mapSession(data.session),
    };
  }

  async signInWithOAuth(options: OAuthSignInOptions): Promise<void> {
    const { error } = await this.client.auth.signInWithOAuth({
      provider: options.provider,
      options: {
        redirectTo: options.redirectTo,
        scopes: options.scopes?.join(" "),
      },
    });

    if (error) {
      throw this.mapError(error);
    }
  }

  async signOut(): Promise<void> {
    const { error } = await this.client.auth.signOut();

    if (error) {
      throw this.mapError(error);
    }
  }

  // ===========================================================================
  // Session Methods
  // ===========================================================================

  async getSession(): Promise<Session | null> {
    const { data, error } = await this.client.auth.getSession();

    if (error) {
      throw this.mapError(error);
    }

    if (!data.session) {
      return null;
    }

    return this.mapSession(data.session);
  }

  async refreshSession(): Promise<Session | null> {
    const { data, error } = await this.client.auth.refreshSession();

    if (error) {
      // Don't throw on refresh failure, just return null
      console.warn("Session refresh failed:", error.message);
      return null;
    }

    if (!data.session) {
      return null;
    }

    return this.mapSession(data.session);
  }

  // ===========================================================================
  // User Methods
  // ===========================================================================

  async getUser(): Promise<User | null> {
    const { data, error } = await this.client.auth.getUser();

    if (error) {
      // Don't throw if user is simply not authenticated
      if (error.message.includes("Not authenticated")) {
        return null;
      }
      throw this.mapError(error);
    }

    if (!data.user) {
      return null;
    }

    return this.mapUser(data.user);
  }

  async updateUser(
    data: Partial<Pick<User, "name" | "avatarUrl" | "metadata">>,
  ): Promise<User> {
    const { data: result, error } = await this.client.auth.updateUser({
      data: {
        name: data.name,
        avatar_url: data.avatarUrl,
        ...data.metadata,
      },
    });

    if (error) {
      throw this.mapError(error);
    }

    return this.mapUser(result.user);
  }

  // ===========================================================================
  // Password Methods
  // ===========================================================================

  async resetPassword(email: string, redirectTo?: string): Promise<void> {
    const { error } = await this.client.auth.resetPasswordForEmail(email, {
      redirectTo:
        redirectTo ??
        (typeof window !== "undefined"
          ? `${window.location.origin}/auth/reset-password`
          : undefined),
    });

    if (error) {
      throw this.mapError(error);
    }
  }

  async updatePassword(newPassword: string): Promise<void> {
    const { error } = await this.client.auth.updateUser({
      password: newPassword,
    });

    if (error) {
      throw this.mapError(error);
    }
  }

  // ===========================================================================
  // Token Methods
  // ===========================================================================

  async verifyToken(token: string, type: "email" | "recovery"): Promise<void> {
    const { error } = await this.client.auth.verifyOtp({
      token_hash: token,
      type: type === "email" ? "email" : "recovery",
    });

    if (error) {
      throw this.mapError(error);
    }
  }

  // ===========================================================================
  // Auth State Listener
  // ===========================================================================

  onAuthStateChange(
    callback: (event: AuthStateEvent, session: Session | null) => void,
  ): () => void {
    const { data } = this.client.auth.onAuthStateChange((event, session) => {
      const mappedEvent = this.mapAuthEvent(event);
      const mappedSession = session ? this.mapSession(session) : null;
      callback(mappedEvent, mappedSession);
    });

    return () => {
      data.subscription.unsubscribe();
    };
  }

  // ===========================================================================
  // Utility Methods
  // ===========================================================================

  getClient(): SupabaseClient {
    return this.client;
  }

  // ===========================================================================
  // Private Helper Methods
  // ===========================================================================

  private mapUser(supabaseUser: {
    id: string;
    email?: string;
    user_metadata?: Record<string, unknown>;
    created_at?: string;
    updated_at?: string;
    email_confirmed_at?: string;
    identities?: any[];
  }): User {
    return {
      id: supabaseUser.id,
      email: supabaseUser.email ?? "",
      name: supabaseUser.user_metadata?.name as string | undefined,
      avatarUrl: supabaseUser.user_metadata?.avatar_url as string | undefined,
      emailVerified: !!supabaseUser.email_confirmed_at,
      createdAt: supabaseUser.created_at
        ? new Date(supabaseUser.created_at)
        : undefined,
      updatedAt: supabaseUser.updated_at
        ? new Date(supabaseUser.updated_at)
        : undefined,
      metadata: supabaseUser.user_metadata,
      identities: supabaseUser.identities,
    };
  }

  private mapSession(supabaseSession: {
    user: {
      id: string;
      email?: string;
      user_metadata?: Record<string, unknown>;
      created_at?: string;
      updated_at?: string;
      email_confirmed_at?: string;
      identities?: any[];
    };
    access_token: string;
    refresh_token?: string;
    expires_at?: number;
  }): Session {
    return {
      user: this.mapUser(supabaseSession.user),
      accessToken: supabaseSession.access_token,
      refreshToken: supabaseSession.refresh_token,
      expiresAt: supabaseSession.expires_at ?? 0,
    };
  }

  private mapAuthEvent(event: string): AuthStateEvent {
    switch (event) {
      case "SIGNED_IN":
      case "INITIAL_SESSION":
        return "SIGNED_IN";
      case "SIGNED_OUT":
        return "SIGNED_OUT";
      case "TOKEN_REFRESHED":
        return "TOKEN_REFRESHED";
      case "USER_UPDATED":
        return "USER_UPDATED";
      case "PASSWORD_RECOVERY":
        return "PASSWORD_RECOVERY";
      default:
        return "SIGNED_IN";
    }
  }

  private mapError(error: SupabaseAuthError): AuthError {
    const message = error.message;

    if (message.includes("Invalid login credentials")) {
      return new AuthError("Invalid email or password", "INVALID_CREDENTIALS");
    }

    if (message.includes("User already registered")) {
      return new AuthError(
        "An account with this email already exists",
        "USER_ALREADY_EXISTS",
      );
    }

    if (message.includes("Email not confirmed")) {
      return new AuthError("Please verify your email address", "EMAIL_NOT_VERIFIED");
    }

    if (
      message.includes("JWT expired") ||
      message.includes("session_not_found")
    ) {
      return new AuthError("Your session has expired", "SESSION_EXPIRED");
    }

    if (
      message.includes("invalid_token") ||
      message.includes("Invalid token")
    ) {
      return new AuthError("Invalid or expired token", "INVALID_TOKEN");
    }

    if (
      error.status === 0 ||
      message.includes("network") ||
      message.includes("fetch")
    ) {
      return new AuthError(
        "Network error. Please check your connection.",
        "NETWORK_ERROR",
      );
    }

    return new AuthError(message, "PROVIDER_ERROR");
  }

  async getProviderToken(provider: string): Promise<string | null> {
    const { data } = await this.client.auth.getSession();
    if (data.session?.provider_token) {
      return data.session.provider_token;
    }
    return null;
  }
}

// =============================================================================
// Supabase Server Auth Implementation
// =============================================================================

type NextResponseCookies = {
  set: (name: string, value: string, options?: CookieOptions) => void;
};

export function createSupabaseServerAuth(): ServerAuth {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error("Missing Supabase environment variables.");
  }

  return {
    isAuthenticated: async (
      req: Request,
      res: { cookies: NextResponseCookies },
    ) => {
      const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
        cookies: {
          getAll() {
            // The request object needs to be cast to NextRequest to access cookies.
            // This is a Next.js-specific implementation detail.
            return (req as import("next/server").NextRequest).cookies.getAll();
          },
          setAll(
            cookies: Array<{
              name: string;
              value: string;
              options: CookieOptions;
            }>,
          ) {
            for (const { name, value, options } of cookies) {
              res.cookies.set(name, value, options);
            }
          },
        },
      });

      const {
        data: { user },
      } = await supabase.auth.getUser();

      return !!user;
    },
  };
}
