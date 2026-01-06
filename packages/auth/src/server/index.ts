import type { AuthAdapter, Session, User } from "../types";

// =============================================================================
// Server Auth Context
// =============================================================================

export function createServerAuth(adapter: AuthAdapter) {
  return {
    getSession: async (): Promise<Session | null> => {
      return adapter.getSession();
    },
    getUser: async (): Promise<User | null> => {
      return adapter.getUser();
    },
    requireAuth: async (): Promise<Session> => {
      const session = await adapter.getSession();

      if (!session) {
        throw new AuthRequiredError();
      }

      return session;
    },
    requireUser: async (userId: string): Promise<User> => {
      const user = await adapter.getUser();

      if (!user) {
        throw new AuthRequiredError();
      }

      if (user.id !== userId) {
        throw new ForbiddenError();
      }

      return user;
    },
  };
}

// =============================================================================
// Auth Errors
// =============================================================================

export class AuthRequiredError extends Error {
  public readonly status = 401;

  constructor(message = "Authentication required") {
    super(message);
    this.name = "AuthRequiredError";
  }
}

export class ForbiddenError extends Error {
  public readonly status = 403;

  constructor(message = "Access forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

// =============================================================================
// Middleware Helpers
// =============================================================================

export interface WithAuthOptions {
  publicPaths?: string[];
  loginPath?: string;
  isPublicPath?: (pathname: string) => boolean;
}

export function protectedRoute<T>(
  adapter: AuthAdapter,
  handler: (
    request: Request,
    context: { session: Session; user: User },
  ) => Promise<T>,
): (request: Request) => Promise<T | Response> {
  return async (request: Request) => {
    const session = await adapter.getSession();

    if (!session) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    return handler(request, { session, user: session.user });
  };
}

// =============================================================================
// Token Utilities
// =============================================================================

export function extractBearerToken(request: Request): string | null {
  const authHeader = request.headers.get("Authorization");

  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }

  return authHeader.slice(7);
}

export function parseJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const payload = parts[1];
    if (!payload) return null;

    const decoded = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

export function isTokenExpired(token: string): boolean {
  const payload = parseJwtPayload(token);

  if (!payload || typeof payload.exp !== "number") {
    return true;
  }

  // Add 10 second buffer for clock skew
  return Date.now() >= payload.exp * 1000 - 10000;
}
