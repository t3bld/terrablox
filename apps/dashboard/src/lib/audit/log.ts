import "server-only";

import { headers } from "next/headers";

import { database } from "@/lib/database";

/**
 * The security trail.
 *
 * `ProjectOperation` already records what the agent did to a graph, but that is
 * product history: it is shown in the UI, scoped to a project, and says nothing
 * about who read a credential or which request was refused. This answers the
 * questions an incident actually asks — who used which AWS connection, when did a
 * deploy start, which requests were denied and for whom — none of which were
 * answerable before, in an app that holds `repo`-scoped OAuth tokens and encrypted
 * AWS credentials.
 *
 * Deliberately not a general-purpose logger. Every write here is a decision worth
 * keeping for months; a request log belongs in the platform, not in Postgres.
 */

/**
 * What happened. Dotted, coarse, and a closed set in the type but a plain string in
 * the column — a new event should be one call site, not a migration, and an old row
 * carrying a retired action must still read.
 */
export type AuditAction =
  // Authentication and authorization
  | "auth.denied"
  | "authz.denied"
  | "ratelimit.blocked"
  | "csrf.blocked"
  // Credentials
  | "aws.connection.created"
  | "aws.connection.deleted"
  | "aws.connection.verified"
  | "aws.credentials.issued"
  | "aws.sso.started"
  | "aws.sso.completed"
  | "mcp.server.created"
  | "mcp.server.updated"
  | "mcp.server.deleted"
  // The repository grant changed on GitHub's side, which is the boundary of
  // everything this app can read or commit.
  | "github.installation.returned"
  // Infrastructure actions with real-world effect
  | "deploy.bootstrap.submitted"
  | "deploy.run.started"
  | "deploy.pipeline.written"
  | "project.deleted"
  // Configuration
  | "harness.updated"
  | "agent.settings.updated";

export interface AuditEntry {
  action: AuditAction;
  /** The actor, or null when the request never authenticated. */
  userId?: string | null;
  /** What it happened to: a project, connection or server id. */
  subject?: string | null;
  outcome?: "ok" | "denied" | "error";
  /**
   * Anything worth keeping alongside, e.g. `{ reason: "not-owner" }`.
   *
   * Never a secret. These rows are read by whoever operates the instance, who is
   * not necessarily the actor, and a token in here would outlive its rotation.
   */
  detail?: Record<string, unknown>;
}

/**
 * Where the client address comes from, and why it is usually absent.
 *
 * `x-forwarded-for` is trivially forged by whoever can reach the app directly, so it
 * is only meaningful behind a proxy that overwrites it. Reading it unconditionally
 * would put an attacker-chosen string in an audit row and make the trail worse than
 * having no column at all — so it is opt-in via `TERRABLOX_TRUST_PROXY`, and the
 * default is to record nothing.
 */
function requestContext(): { ip: string | null; userAgent: string | null } {
  if (process.env.TERRABLOX_TRUST_PROXY !== "true") {
    return { ip: null, userAgent: null };
  }

  try {
    const h = headers();
    // The left-most entry is the original client; the rest are proxies. Only the
    // right-most is actually trustworthy, but with a single known proxy in front
    // the left-most is the useful one.
    const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim();

    return {
      ip: forwarded || h.get("x-real-ip") || null,
      userAgent: h.get("user-agent")?.slice(0, 500) ?? null,
    };
  } catch {
    // `headers()` throws outside a request scope, e.g. from a background task.
    return { ip: null, userAgent: null };
  }
}

/**
 * Records an event. Never throws, never blocks the caller's result.
 *
 * A failed audit write must not turn a working request into a 500 — the row is
 * evidence about the request, not part of it. It is still awaited rather than
 * fire-and-forget, so the write is ordered before the response and cannot be lost
 * to a serverless freeze; the cost is one insert.
 */
export async function audit(entry: AuditEntry): Promise<void> {
  const { ip, userAgent } = requestContext();

  try {
    await database.auditEvent.create({
      data: {
        action: entry.action,
        userId: entry.userId ?? null,
        subject: entry.subject ?? null,
        outcome: entry.outcome ?? "ok",
        detail: (entry.detail ?? {}) as object,
        ip,
        userAgent,
      },
    });
  } catch (error) {
    // Logged rather than swallowed silently: losing the trail is itself worth
    // noticing, and this is the one place that can report it.
    console.error("[audit] could not record event", entry.action, error);
  }
}
