import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { database } from "@/lib/database";

/**
 * Personal tokens, so something other than a browser can act as a user.
 *
 * The reason this exists at all: every route authenticates with a session cookie, and
 * an MCP host in somebody's editor cannot hold one. `sameSite` — the property that
 * makes the cookie safe — is exactly what keeps a non-browser client out.
 *
 * A token is deliberately narrower than a session. It is named, scoped, expirable and
 * individually revocable, because unlike a cookie it ends up in a plain-text config
 * file on a laptop, and those get committed, synced between machines and pasted into
 * chat windows.
 */

/** Distinguishes our tokens from every other bearer string, in logs and in code. */
const PREFIX = "tbx_";

/**
 * 32 bytes, base64url.
 *
 * 256 bits because the token is the only thing between a stranger and somebody's
 * infrastructure, and because this is machine-generated — there is no memorability to
 * trade against. base64url so it survives a JSON config file, a shell variable and a
 * URL without escaping.
 */
const SECRET_BYTES = 32;

/** How much of the token the settings screen may show. Enough to recognise, not to use. */
const PREFIX_SHOWN = PREFIX.length + 6;

export type ApiTokenScope = "read" | "write";

export interface ApiTokenSummary {
  id: string;
  name: string;
  /** e.g. `tbx_a1b2c3…`. The rest is unrecoverable. */
  tokenPrefix: string;
  scopes: ApiTokenScope[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface CreatedApiToken {
  summary: ApiTokenSummary;
  /**
   * The only time this is ever available.
   *
   * Returned from the create call and never stored, so a caller that loses it has to
   * issue a new token. That is the point: see the hashing note in the schema.
   */
  token: string;
}

export class ApiTokenError extends Error {}

function hash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function toSummary(row: {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}): ApiTokenSummary {
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.tokenPrefix,
    // Narrowed on the way out rather than trusted: the column is `text[]`, so a row
    // written by an older version could hold anything.
    scopes: row.scopes.filter(
      (scope): scope is ApiTokenScope => scope === "read" || scope === "write",
    ),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Issues a token and returns it in the clear, once.
 *
 * `expiresInDays` is optional because a token for a workstation nobody will remember
 * to rotate is more honestly described as non-expiring than given a deadline the
 * person will extend without reading.
 */
export async function createApiToken(
  userId: string,
  input: { name: string; scopes?: ApiTokenScope[]; expiresInDays?: number },
): Promise<CreatedApiToken> {
  const name = input.name.trim();
  if (!name) throw new ApiTokenError("Give the token a name.");
  if (name.length > 100) {
    throw new ApiTokenError("That name is too long (100 characters maximum).");
  }

  const scopes = input.scopes?.length ? input.scopes : (["read"] as const);

  if (
    input.expiresInDays !== undefined &&
    (!Number.isInteger(input.expiresInDays) ||
      input.expiresInDays < 1 ||
      input.expiresInDays > 365)
  ) {
    throw new ApiTokenError("Expiry must be between 1 and 365 days.");
  }

  const token = `${PREFIX}${randomBytes(SECRET_BYTES).toString("base64url")}`;

  const expiresAt =
    input.expiresInDays === undefined
      ? null
      : new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000);

  // The unique constraint on (userId, name) is what enforces distinct names, and it
  // is caught rather than pre-checked: a read-then-write would race with itself.
  try {
    const row = await database.apiToken.create({
      data: {
        userId,
        name,
        tokenHash: hash(token),
        tokenPrefix: token.slice(0, PREFIX_SHOWN),
        scopes: [...scopes],
        expiresAt,
      },
    });

    return { summary: toSummary(row), token };
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "P2002"
    ) {
      throw new ApiTokenError(`You already have a token called "${name}".`);
    }
    throw error;
  }
}

/** A person's tokens, newest first. Revoked ones are omitted. */
export async function listApiTokens(
  userId: string,
): Promise<ApiTokenSummary[]> {
  const rows = await database.apiToken.findMany({
    where: { userId, revokedAt: null },
    orderBy: { createdAt: "desc" },
  });

  return rows.map(toSummary);
}

/**
 * Revokes a token. Idempotent, and scoped to the owner.
 *
 * `updateMany` with the userId in the filter rather than a lookup then an update:
 * ownership is part of the write, so there is no window in which it was checked
 * against a row somebody else's request could have changed.
 */
export async function revokeApiToken(
  userId: string,
  tokenId: string,
): Promise<boolean> {
  const result = await database.apiToken.updateMany({
    where: { id: tokenId, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  return result.count > 0;
}

/** How stale `lastUsedAt` may get before it is worth a write. */
const LAST_USED_RESOLUTION_MS = 60_000;

/**
 * The user this token belongs to, or null.
 *
 * Returns the scopes as well, because the caller has to know whether this token may
 * change anything, and finding that out with a second query would invite forgetting.
 *
 * The comparison is constant-time even though the lookup is by hash. That is not
 * theatre: `findUnique` on the hash is safe, but the token *presence* check below
 * compares the recomputed hash against the stored one, and doing that with `===`
 * would leak a byte-wise timing signal about a value an attacker is trying to guess.
 */
export async function resolveApiToken(token: string): Promise<{
  userId: string;
  tokenId: string;
  scopes: ApiTokenScope[];
} | null> {
  if (!token.startsWith(PREFIX)) return null;

  const digest = hash(token);

  const row = await database.apiToken.findUnique({
    where: { tokenHash: digest },
    select: {
      id: true,
      userId: true,
      scopes: true,
      tokenHash: true,
      expiresAt: true,
      revokedAt: true,
      lastUsedAt: true,
    },
  });

  if (!row) return null;

  const a = Buffer.from(row.tokenHash, "utf8");
  const b = Buffer.from(digest, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  if (row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;

  // Throttled, and not awaited. Every accepted request would otherwise be a write,
  // and this column exists so somebody can spot a token they stopped using — a
  // minute's resolution answers that and a failed update must never fail the request.
  const stale =
    !row.lastUsedAt ||
    Date.now() - row.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS;

  if (stale) {
    void database.apiToken
      .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
      .catch(() => {});
  }

  return {
    userId: row.userId,
    tokenId: row.id,
    scopes: row.scopes.filter(
      (scope): scope is ApiTokenScope => scope === "read" || scope === "write",
    ),
  };
}

/** The bearer token of a request, or null. Case-insensitive scheme, as the RFC has it. */
export function bearerTokenOf(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;

  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}
