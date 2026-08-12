import { createAuthClient } from "better-auth/react";
import {
  AuthAdapter,
  AuthError,
  type AuthErrorCode,
  type AuthResult,
  type AuthStateEvent,
  type OAuthSignInOptions,
  type Session,
  type SignInCredentials,
  type SignUpCredentials,
  type User,
  type UserIdentity,
} from "../types";

export interface BetterAuthConfig {
  /**
   * Base URL of the Better Auth server. Defaults to the current origin,
   * which is what a local single-origin deployment wants.
   */
  baseURL?: string;
}

type BetterAuthClient = ReturnType<typeof createAuthClient>;

interface BetterAuthUser {
  id: string;
  email: string;
  name?: string | null;
  image?: string | null;
  emailVerified?: boolean | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
}

interface BetterAuthSession {
  token: string;
  expiresAt: Date | string;
}

/** Shape returned by Better Auth's `/list-accounts` endpoint. */
interface BetterAuthAccount {
  id: string;
  providerId: string;
  accountId: string;
  scopes?: string[] | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
}

interface BetterAuthClientError {
  message?: string;
  code?: string;
  status?: number;
}

export class BetterAuthAdapter extends AuthAdapter {
  private client: BetterAuthClient;

  constructor(config: BetterAuthConfig = {}) {
    super();
    this.client = createAuthClient(
      config.baseURL ? { baseURL: config.baseURL } : {},
    );
  }

  async signUp(credentials: SignUpCredentials): Promise<AuthResult> {
    const { data, error } = await this.client.signUp.email({
      email: credentials.email,
      password: credentials.password,
      // Better Auth requires a name; fall back to the local part of the email.
      name:
        credentials.name?.trim() ||
        credentials.email.split("@")[0] ||
        credentials.email,
    });

    if (error) {
      throw this.mapError(error);
    }

    const session = await this.getSession();
    if (session) {
      return { user: session.user, session };
    }

    // Email verification pending: no session yet.
    const user = data?.user
      ? this.mapUser(data.user as BetterAuthUser)
      : undefined;

    if (!user) {
      throw new AuthError("No user returned from sign up", "UNKNOWN_ERROR");
    }

    return {
      user,
      session: { user, accessToken: "", expiresAt: 0 },
    };
  }

  async signIn(credentials: SignInCredentials): Promise<AuthResult> {
    const { error } = await this.client.signIn.email({
      email: credentials.email,
      password: credentials.password,
    });

    if (error) {
      throw this.mapError(error);
    }

    const session = await this.getSession();
    if (!session) {
      throw new AuthError("No session returned from sign in", "UNKNOWN_ERROR");
    }

    return { user: session.user, session };
  }

  async signInWithOAuth(options: OAuthSignInOptions): Promise<void> {
    const { error } = await this.client.signIn.social({
      provider: options.provider,
      callbackURL: options.redirectTo,
      scopes: options.scopes,
    });

    if (error) {
      throw this.mapError(error);
    }
  }

  /**
   * Attaches an OAuth account to the user who is already signed in.
   *
   * `signIn.social` would instead start a fresh session for whichever provider
   * account is chosen, which is not what "link account" means.
   */
  async linkOAuth(options: OAuthSignInOptions): Promise<void> {
    const { error } = await this.client.linkSocial({
      provider: options.provider,
      callbackURL: options.redirectTo,
      scopes: options.scopes,
    });

    if (error) {
      throw this.mapError(error);
    }
  }

  async listIdentities(): Promise<UserIdentity[]> {
    const { data, error } = await this.client.listAccounts();

    if (error) {
      // Not signed in is a normal state here, not something to surface.
      if (error.status === 401) {
        return [];
      }
      throw this.mapError(error);
    }

    return ((data ?? []) as BetterAuthAccount[]).map((account) => ({
      provider: account.providerId,
      accountId: account.accountId,
      scopes: account.scopes ?? [],
      createdAt: account.createdAt ? new Date(account.createdAt) : undefined,
      updatedAt: account.updatedAt ? new Date(account.updatedAt) : undefined,
    }));
  }

  async signOut(): Promise<void> {
    const { error } = await this.client.signOut();

    if (error) {
      throw this.mapError(error);
    }
  }

  async getSession(): Promise<Session | null> {
    const { data, error } = await this.client.getSession();

    if (error) {
      throw this.mapError(error);
    }

    if (!data?.session || !data.user) {
      return null;
    }

    return this.mapSession(
      data.user as BetterAuthUser,
      data.session as BetterAuthSession,
    );
  }

  /**
   * Better Auth refreshes session cookies transparently, so refreshing is just
   * re-reading the current session.
   */
  async refreshSession(): Promise<Session | null> {
    try {
      return await this.getSession();
    } catch (error) {
      console.warn(
        "Session refresh failed:",
        error instanceof Error ? error.message : error,
      );
      return null;
    }
  }

  async getUser(): Promise<User | null> {
    const session = await this.getSession();
    return session?.user ?? null;
  }

  async updateUser(
    data: Partial<Pick<User, "name" | "avatarUrl" | "metadata">>,
  ): Promise<User> {
    const { error } = await this.client.updateUser({
      name: data.name,
      image: data.avatarUrl,
    });

    if (error) {
      throw this.mapError(error);
    }

    const user = await this.getUser();
    if (!user) {
      throw new AuthError("No user returned from update", "UNKNOWN_ERROR");
    }

    return user;
  }

  async resetPassword(email: string, redirectTo?: string): Promise<void> {
    const { error } = await this.client.requestPasswordReset({
      email,
      redirectTo:
        redirectTo ??
        (typeof window !== "undefined"
          ? `${window.location.origin}/reset-password`
          : undefined),
    });

    if (error) {
      throw this.mapError(error);
    }
  }

  /**
   * Completes the "forgot password" flow. Better Auth delivers a one-time token
   * in the reset link, so this must run on the page that link points to.
   */
  async updatePassword(newPassword: string): Promise<void> {
    const token =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search).get("token")
        : null;

    if (!token) {
      throw new AuthError(
        "Missing password reset token. Open the reset link from your email.",
        "INVALID_TOKEN",
      );
    }

    const { error } = await this.client.resetPassword({ newPassword, token });

    if (error) {
      throw this.mapError(error);
    }
  }

  async getProviderToken(provider: string): Promise<string | null> {
    const { data, error } = await this.client.getAccessToken({
      providerId: provider,
    });

    if (error) {
      return null;
    }

    return data?.accessToken ?? null;
  }

  onAuthStateChange(
    callback: (event: AuthStateEvent, session: Session | null) => void,
  ): () => void {
    let cancelled = false;

    // `$store.listen` does not return an unsubscribe handle, so guard with a flag.
    this.client.$store.listen("$sessionSignal", () => {
      if (cancelled) {
        return;
      }

      this.getSession()
        .then((session) => {
          if (cancelled) {
            return;
          }
          callback(session ? "SIGNED_IN" : "SIGNED_OUT", session);
        })
        .catch(() => {
          if (!cancelled) {
            callback("SIGNED_OUT", null);
          }
        });
    });

    return () => {
      cancelled = true;
    };
  }

  // ===========================================================================
  // Private Helper Methods
  // ===========================================================================

  private mapUser(user: BetterAuthUser): User {
    return {
      id: user.id,
      email: user.email ?? "",
      name: user.name ?? undefined,
      avatarUrl: user.image ?? undefined,
      emailVerified: !!user.emailVerified,
      createdAt: user.createdAt ? new Date(user.createdAt) : undefined,
      updatedAt: user.updatedAt ? new Date(user.updatedAt) : undefined,
    };
  }

  private mapSession(
    user: BetterAuthUser,
    session: BetterAuthSession,
  ): Session {
    return {
      user: this.mapUser(user),
      accessToken: session.token,
      expiresAt: session.expiresAt
        ? Math.floor(new Date(session.expiresAt).getTime() / 1000)
        : 0,
    };
  }

  private mapError(error: BetterAuthClientError): AuthError {
    const code = error.code ?? "";
    const message = error.message ?? "Authentication failed";

    const byCode: Record<string, [string, AuthErrorCode]> = {
      INVALID_EMAIL_OR_PASSWORD: [
        "Invalid email or password",
        "INVALID_CREDENTIALS",
      ],
      USER_ALREADY_EXISTS: [
        "An account with this email already exists",
        "USER_ALREADY_EXISTS",
      ],
      USER_NOT_FOUND: ["No account found for this email", "USER_NOT_FOUND"],
      EMAIL_NOT_VERIFIED: [
        "Please verify your email address",
        "EMAIL_NOT_VERIFIED",
      ],
      SESSION_EXPIRED: ["Your session has expired", "SESSION_EXPIRED"],
      INVALID_TOKEN: ["Invalid or expired token", "INVALID_TOKEN"],
      PROVIDER_NOT_FOUND: [
        "This sign-in provider is not configured on the server",
        "PROVIDER_ERROR",
      ],
    };

    const mapped = byCode[code];
    if (mapped) {
      return new AuthError(mapped[0], mapped[1]);
    }

    if (error.status === 0) {
      return new AuthError(
        "Network error. Please check your connection.",
        "NETWORK_ERROR",
      );
    }

    return new AuthError(message, "PROVIDER_ERROR");
  }
}
