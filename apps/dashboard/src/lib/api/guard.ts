import "server-only";

import type { z } from "zod";

import {
  enforceRateLimit,
  RATE_LIMITS,
  type RateLimit,
  userRateKey,
} from "@/lib/api/rate-limit";
import { ApiError } from "@/lib/api/route-error";
import { audit } from "@/lib/audit/log";
import { bearerTokenOf, resolveApiToken } from "@/lib/auth/api-token-service";
import { getCurrentUserId } from "@/lib/auth/server-helpers";

/**
 * The three things every write route has to do before it does its own job.
 *
 * Authenticate, spend a rate-limit unit, and validate the body. Each of those was
 * previously hand-rolled per handler — which is why the coverage was uneven: 22
 * routes read a JSON body and two of them validated it properly. Collapsing the
 * boilerplate into one call is what makes it realistic for the fifty-first route to
 * get it right.
 *
 * CSRF is *not* here. It runs in middleware for every `/api/**` request, because a
 * check a handler has to remember is a check a handler will eventually forget.
 */

/**
 * The signed-in user's id, or a 401.
 *
 * Throws rather than returning null so the call site is one line and cannot fall
 * through to the happy path by omission — the `if (!userId) return unauthorized()`
 * pattern it replaces was correct everywhere, but only because someone checked
 * seventy times.
 *
 * The denial is audited. A single 401 is noise; a thousand of them against one route
 * is the first thing an incident wants to see, and nothing recorded them before.
 */
export async function requireUserId(context?: {
  action?: string;
}): Promise<string> {
  const userId = await getCurrentUserId();

  if (!userId) {
    await audit({
      action: "auth.denied",
      outcome: "denied",
      detail: context?.action ? { route: context.action } : {},
    });

    throw new ApiError("Unauthorized", 401);
  }

  return userId;
}

/**
 * Authenticate, then charge the caller for the call.
 *
 * `scope` names the budget so that exhausting the agent ceiling does not also lock
 * the user out of reading their project list. Pass the matching entry from
 * {@link RATE_LIMITS} — the default is the ordinary-write budget.
 */
export async function requireUserWithLimit(
  scope: string,
  limit: RateLimit = RATE_LIMITS.write,
): Promise<string> {
  const userId = await requireUserId({ action: scope });

  try {
    enforceRateLimit(userRateKey(userId, scope), limit);
  } catch (error) {
    if (error instanceof ApiError && error.status === 429) {
      await audit({
        action: "ratelimit.blocked",
        userId,
        outcome: "denied",
        detail: { scope },
      });
    }
    throw error;
  }

  return userId;
}

/**
 * How much of a request body we are willing to read.
 *
 * There is no body-size limit anywhere else in the stack: App Router handlers ignore
 * the old `api.bodyParser` config, and nothing sits in front of the app in the
 * shipped compose file. Without this, `req.json()` buffers whatever it is given, and
 * the graph and chat routes persist what they parse.
 *
 * 256 KB is far above any real payload here — the largest is a Terraform local's
 * value or a chat message — and far below what would trouble the process.
 */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * Reads and validates a JSON body.
 *
 * Three failures, three distinct 400s, because "Invalid request" for all of them is
 * what makes a form impossible to debug from the outside:
 *
 *   - too large, checked before parsing so an oversized body is never materialised
 *   - not JSON
 *   - JSON, but not the shape the route needs, reported with the offending path
 *
 * The size check reads `content-length` when present and otherwise measures the text
 * it actually received, since a chunked request can omit the header.
 */
export async function parseJsonBody<S extends z.ZodTypeAny>(
  request: Request,
  schema: S,
): Promise<z.infer<S>> {
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > MAX_BODY_BYTES) {
    throw new ApiError("That request body is too large.", 413);
  }

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    throw new ApiError("That request body is too large.", 413);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ApiError("Expected a JSON body.", 400);
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.join(".");

    throw new ApiError(
      where
        ? `${where}: ${first?.message}`
        : (first?.message ?? "Invalid body"),
      400,
    );
  }

  return parsed.data;
}

/** Who is making a request, and what they are allowed to do. */
export interface Caller {
  userId: string;
  /** `"cookie"` for a browser session, `"token"` for a personal API token. */
  kind: "cookie" | "token";
  /**
   * Whether this caller may change anything.
   *
   * Always true for a browser session — a signed-in person can do everything the UI
   * offers, and narrowing that here would be inventing a permission model the app
   * does not have. A token carries whatever scope it was issued with.
   */
  canWrite: boolean;
  /** Set for a token, so a revocation can be traced to the calls it made. */
  tokenId?: string;
}

/**
 * Authenticates a request from either a browser or a token, then charges for it.
 *
 * The one place the two identities meet, and deliberately the only one: every route
 * beyond this point deals in a `userId` and does not care how it was established.
 * That is what keeps the MCP endpoint from becoming a second implementation of
 * authorisation — it reaches the same services through the same guard.
 *
 * Cookie first. A browser request carries both a cookie and, occasionally, an
 * `Authorization` header meant for something else entirely; preferring the session
 * means a stray header cannot downgrade a signed-in person to a token's scope.
 */
export async function requireCaller(options: {
  request: Request;
  /** Names the budget and the audit entry, e.g. `"mcp.call"`. */
  scope: string;
  limit?: RateLimit;
  /** Refuse a read-only token. Set for anything that changes state. */
  write?: boolean;
}): Promise<Caller> {
  const cookieUserId = await getCurrentUserId();

  const caller: Caller | null = cookieUserId
    ? { userId: cookieUserId, kind: "cookie", canWrite: true }
    : await callerFromToken(options.request);

  if (!caller) {
    await audit({
      action: "auth.denied",
      outcome: "denied",
      detail: { route: options.scope },
    });

    throw new ApiError("Unauthorized", 401);
  }

  if (options.write && !caller.canWrite) {
    // 403, not 401: the caller is who they say they are, and retrying with the same
    // credential will not help. Saying which scope is missing is the difference
    // between "issue a write token" and an afternoon of guessing.
    await audit({
      action: "authz.denied",
      userId: caller.userId,
      outcome: "denied",
      detail: { route: options.scope, reason: "read-only-token" },
    });

    throw new ApiError(
      "This token is read-only. Create a token with write access to change anything.",
      403,
    );
  }

  try {
    enforceRateLimit(
      userRateKey(caller.userId, options.scope),
      options.limit ?? RATE_LIMITS.write,
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 429) {
      await audit({
        action: "ratelimit.blocked",
        userId: caller.userId,
        outcome: "denied",
        detail: { scope: options.scope },
      });
    }
    throw error;
  }

  return caller;
}

async function callerFromToken(request: Request): Promise<Caller | null> {
  const presented = bearerTokenOf(request);
  if (!presented) return null;

  const resolved = await resolveApiToken(presented);
  if (!resolved) return null;

  return {
    userId: resolved.userId,
    kind: "token",
    canWrite: resolved.scopes.includes("write"),
    tokenId: resolved.tokenId,
  };
}
