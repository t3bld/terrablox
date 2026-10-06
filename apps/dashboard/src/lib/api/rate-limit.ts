import "server-only";

import { ApiError } from "@/lib/api/route-error";

/**
 * A per-process rate limiter.
 *
 * Scope, stated plainly so nobody mistakes this for more than it is: the counters
 * live in this process's memory. They reset on restart and they are not shared
 * between instances, so N replicas allow N times the budget. That is a real
 * limitation and the honest fix is a limiter in front of the app — Postgres would
 * turn every request into a write, and the abuse this exists to stop is exactly the
 * kind that would make that write the bottleneck.
 *
 * What it does buy, which the app had none of before: a single authenticated account
 * can no longer hold a hundred concurrent agent turns. Each turn forks a ~190 MB
 * Copilot CLI child and may run for five minutes, so the ceiling here is what stops
 * one user from exhausting the host's memory. The same applies, with real money
 * attached, to the deploy routes.
 *
 * Keyed by user id rather than by IP wherever a session exists. IP is the wrong key
 * for a self-hosted tool: a team behind one NAT would share a budget, and the
 * limiter would read as an outage. IP is used only where there is no user yet.
 */

interface Bucket {
  /** Timestamps of the calls still inside the window, oldest first. */
  hits: number[];
}

/**
 * A sliding window rather than a fixed one.
 *
 * A fixed window lets twice the budget through across a boundary — 30 calls at
 * 59.9s and 30 more at 60.1s — which for a route that forks a subprocess is the
 * difference between a limit and a suggestion.
 */
const buckets = new Map<string, Bucket>();

/**
 * When the map was last swept, and why sweeping is needed at all.
 *
 * Every distinct key allocates an entry, so without eviction this map is an
 * unbounded cache keyed by user id — a slow leak in a long-running process, and one
 * an attacker could accelerate on the unauthenticated routes by varying the key.
 * Swept opportunistically on write rather than on a timer, so an idle process does
 * no work and nothing has to be torn down.
 */
let lastSweep = Date.now();
const SWEEP_INTERVAL_MS = 60_000;

function sweep(now: number, windowMs: number): void {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;

  for (const [key, bucket] of buckets) {
    const live = bucket.hits.filter((at) => now - at < windowMs);
    if (live.length === 0) buckets.delete(key);
    else bucket.hits = live;
  }
}

export interface RateLimit {
  /** Calls allowed inside the window. */
  max: number;
  /** Window length in seconds. */
  windowSeconds: number;
}

/**
 * The budgets, named so a route reads as its intent rather than as two numbers.
 *
 * The values are deliberately generous for interactive use and tight for anything
 * that spends a resource. `agentTurn` is the important one: five concurrent-ish
 * turns per minute is more than a person types and far less than a script.
 */
export const RATE_LIMITS = {
  /** Anything that forks the Copilot CLI or spends the user's model quota. */
  agentTurn: { max: 10, windowSeconds: 60 },
  /** Anything that reaches a customer's AWS account or starts a pipeline. */
  infrastructure: { max: 20, windowSeconds: 60 },
  /** Writes that only touch our own database. */
  write: { max: 120, windowSeconds: 60 },
  /** Repository reads proxied to GitHub on the user's token. */
  providerRead: { max: 300, windowSeconds: 60 },
  /** Imports, which walk a whole repository tree. */
  importModule: { max: 20, windowSeconds: 60 },
  /**
   * The MCP endpoint, where one user action is many requests.
   *
   * Sized differently from every other entry here because the unit is different. A
   * budget is charged per HTTP request, and this endpoint's requests are protocol
   * messages: a host spends one on `initialize`, one on `tools/list`, and one per
   * tool call — so a single "add a VPC and wire it up" is a dozen before any work
   * happens. Pointed at `infrastructure` (20/60s) it ran out mid-probe, which is
   * exactly what it would have done to a real agent three steps into a task.
   *
   * Still a ceiling, and deliberately below `write`: each call here can commit to a
   * repository, so this is what stops a runaway agent loop from filling somebody's
   * history with a hundred commits a minute.
   */
  mcp: { max: 60, windowSeconds: 60 },
} as const satisfies Record<string, RateLimit>;

/**
 * Consumes one unit of `limit` for `key`, or throws a 429.
 *
 * Throws rather than returning a boolean so a route cannot forget to act on the
 * answer — `routeError` already turns an `ApiError` into the right response, so the
 * call site is one line with no branch.
 */
export function enforceRateLimit(
  key: string,
  limit: RateLimit = RATE_LIMITS.write,
): void {
  const now = Date.now();
  const windowMs = limit.windowSeconds * 1000;

  sweep(now, windowMs);

  const bucket = buckets.get(key) ?? { hits: [] };
  const hits = bucket.hits.filter((at) => now - at < windowMs);

  if (hits.length >= limit.max) {
    const oldest = hits[0] ?? now;
    const retryAfter = Math.max(
      1,
      Math.ceil((windowMs - (now - oldest)) / 1000),
    );

    // The message names the wait rather than the budget: the number of calls
    // allowed is not something the caller can do anything with.
    throw new ApiError(
      `Too many requests. Try again in ${retryAfter} second${retryAfter === 1 ? "" : "s"}.`,
      429,
    );
  }

  hits.push(now);
  bucket.hits = hits;
  buckets.set(key, bucket);
}

/**
 * The key for a signed-in caller.
 *
 * `scope` separates budgets so that hitting the agent ceiling does not also lock the
 * user out of reading their project list.
 */
export function userRateKey(userId: string, scope: string): string {
  return `u:${userId}:${scope}`;
}

/** Test seam: the counters are process state, and a test needs them empty. */
export function __resetRateLimits(): void {
  buckets.clear();
  lastSweep = 0;
}
