import "server-only";

import { prisma } from "@terrablox/database";

import { decryptSecret, encryptSecret } from "@/lib/crypto/secret-box";

/**
 * The user's own Infracost credential.
 *
 * TerraBlox holds no shared key on purpose. Pricing a plan runs against an
 * Infracost account, and whoever owns that account owns the quota, the invoice
 * and the data that passes through it — none of which should silently belong to
 * whoever happens to host TerraBlox. So every user brings their own key, and
 * without one the project cost features stay switched off rather than falling
 * back to somebody else's credential.
 *
 * The key is only ever read on the server, to fill the repository secret the
 * generated cost workflow reads.
 */

export class InfracostSettingsError extends Error {}

/**
 * Deliberately loose. Infracost has changed its key format before, and a
 * pattern that is stricter than reality rejects valid keys with a message the
 * user cannot act on. Anything that is plausibly a token is accepted; whether
 * it actually works is answered by the pipeline, which fails loudly.
 */
const KEY_PATTERN = /^[\w-]{16,200}$/;
const PRICING_API_ENDPOINT = "https://pricing.api.infracost.io/graphql";

export interface InfracostStatus {
  configured: boolean;
  /** Last four characters, so a user can tell which key is stored. */
  hint: string | null;
  updatedAt: string | null;
  /** Set when a key exists but can no longer be decrypted. */
  problem: string | null;
}

const NOT_CONFIGURED: InfracostStatus = {
  configured: false,
  hint: null,
  updatedAt: null,
  problem: null,
};

async function validateInfracostApiKey(apiKey: string): Promise<void> {
  const headers: HeadersInit = {
    "Content-Type": "application/json",
    "User-Agent": "terrablox-infracost-validation",
  };

  if (apiKey.startsWith("ics")) {
    headers.Authorization = `Bearer ${apiKey}`;
  } else {
    headers["X-Api-Key"] = apiKey;
  }

  let response: Response;
  try {
    response = await fetch(PRICING_API_ENDPOINT, {
      method: "POST",
      headers,
      // The CLI sends a batch with an empty query as its validation probe.
      body: JSON.stringify([{ query: "", variables: null }]),
      cache: "no-store",
    });
  } catch {
    throw new InfracostSettingsError(
      "Could not reach Infracost to validate the key. Try again.",
    );
  }

  const responseBody = await response.text().catch(() => "");
  const apiErrorCode = responseBody.match(/"error_code"\s*:\s*"([^"]+)"/)?.[1];

  if (
    response.status === 401 ||
    response.status === 403 ||
    apiErrorCode === "invalid_api_key"
  ) {
    throw new InfracostSettingsError(
      "This Infracost CLI token is invalid or expired.",
    );
  }

  if (apiErrorCode === "above_quota") {
    throw new InfracostSettingsError(
      "This Infracost account has reached its current API quota.",
    );
  }

  // The probe carries no real query, so the API rejects the query itself once
  // the credential passes. Only an auth failure tells us the token is bad.
}

export async function getInfracostStatus(
  userId: string,
): Promise<InfracostStatus> {
  const row = await prisma.infracostSettings.findUnique({ where: { userId } });
  if (!row) return NOT_CONFIGURED;

  const key = decryptSecret(row.apiKey);

  // A key encrypted under an older BETTER_AUTH_SECRET is unusable, so reporting
  // it as configured would leave the user staring at a working-looking setting
  // while every estimate fails.
  if (!key) {
    return {
      configured: false,
      hint: null,
      updatedAt: row.updatedAt.toISOString(),
      problem:
        "The stored key could not be read. Enter it again to replace it.",
    };
  }

  return {
    configured: true,
    hint: key.slice(-4),
    updatedAt: row.updatedAt.toISOString(),
    problem: null,
  };
}

export async function saveInfracostApiKey(
  userId: string,
  apiKey: string,
): Promise<void> {
  const trimmed = apiKey.trim();

  if (!trimmed) {
    throw new InfracostSettingsError("Enter your Infracost API key.");
  }

  if (!KEY_PATTERN.test(trimmed)) {
    throw new InfracostSettingsError(
      "That does not look like an Infracost API key. Copy it from the Infracost dashboard under Org Settings.",
    );
  }

  await validateInfracostApiKey(trimmed);

  const apiKeyEncrypted = encryptSecret(trimmed);

  await prisma.infracostSettings.upsert({
    where: { userId },
    create: { userId, apiKey: apiKeyEncrypted },
    update: { apiKey: apiKeyEncrypted },
  });
}

export async function clearInfracostApiKey(userId: string): Promise<void> {
  await prisma.infracostSettings.deleteMany({ where: { userId } });
}

/** Whether the cost features may be offered to this user at all. */
export async function hasInfracostApiKey(userId: string): Promise<boolean> {
  const { configured } = await getInfracostStatus(userId);
  return configured;
}

/** The decrypted key, for server-side use only. Null when unusable. */
export async function getInfracostApiKey(
  userId: string,
): Promise<string | null> {
  const row = await prisma.infracostSettings.findUnique({ where: { userId } });
  return row ? decryptSecret(row.apiKey) : null;
}
