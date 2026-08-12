import "server-only";

import { createPrivateKey, createSign } from "node:crypto";

/**
 * GitHub App authentication (server-to-server).
 *
 * Module code lives in Git, not in our database, so every module view reads
 * from the repository. Doing that with the *viewing user's* OAuth token would
 * make a module readable only for users who personally have access to that
 * repo, which defeats "the repository is the single source of truth".
 *
 * Instead we authenticate as the GitHub App installation: one identity, one
 * admin-controlled set of repositories, `Contents: Read-only`, and no user
 * tokens with `repo` write scope anywhere.
 *
 * @see https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app
 */

const GITHUB_API = "https://api.github.com";
const API_VERSION = "2022-11-28";

/** Installation tokens live 1h; refresh early so in-flight requests stay valid. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;
/** GitHub rejects app JWTs older than 10 minutes. */
const JWT_LIFETIME_S = 9 * 60;

const appId = process.env.GITHUB_APP_ID?.trim();
const rawPrivateKey = process.env.GITHUB_APP_PRIVATE_KEY?.trim();
const configuredInstallationId = process.env.GITHUB_APP_INSTALLATION_ID?.trim();

export const isGithubAppConfigured = !!appId && !!rawPrivateKey;

interface CachedToken {
  token: string;
  expiresAt: number;
}

let tokenCache: CachedToken | null = null;
let installationIdCache: string | null = configuredInstallationId || null;
// Collapses concurrent requests onto a single token exchange.
let inFlight: Promise<string> | null = null;

/**
 * Accepts the PEM either verbatim (real newlines), with escaped `\n` as is
 * common in .env files, or base64-encoded.
 */
function normalisePrivateKey(value: string): string {
  const unescaped = value.includes("\\n") ? value.replace(/\\n/g, "\n") : value;

  if (unescaped.includes("-----BEGIN")) {
    return unescaped;
  }

  const decoded = Buffer.from(unescaped, "base64").toString("utf8");
  if (decoded.includes("-----BEGIN")) {
    return decoded;
  }

  throw new Error(
    "GITHUB_APP_PRIVATE_KEY is not a valid PEM key. Paste the contents of the .pem file downloaded from GitHub (newlines may be escaped as \\n), or base64-encode it.",
  );
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Builds the short-lived RS256 JWT that authenticates as the App itself.
 * Only used to obtain installation tokens; never sent to the repo endpoints.
 */
function createAppJwt(): string {
  if (!appId || !rawPrivateKey) {
    throw new Error("GitHub App is not configured.");
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    // `iat` is backdated by 60s to tolerate clock skew against GitHub.
    JSON.stringify({ iat: now - 60, exp: now + JWT_LIFETIME_S, iss: appId }),
  );

  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  signer.end();

  const key = createPrivateKey(normalisePrivateKey(rawPrivateKey));
  const signature = base64url(signer.sign(key));

  return `${header}.${payload}.${signature}`;
}

async function githubAppFetch(path: string, init?: RequestInit) {
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${createAppJwt()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `GitHub App request failed: ${res.status} ${res.statusText} ${body.slice(0, 200)}`,
    );
  }

  return res;
}

async function resolveInstallationId(): Promise<string> {
  if (installationIdCache) {
    return installationIdCache;
  }

  const res = await githubAppFetch("/app/installations?per_page=100");
  const installations = (await res.json()) as Array<{
    id: number;
    account?: { login?: string } | null;
  }>;

  if (installations.length > 1) {
    const accounts = installations
      .map((i) => `${i.account?.login ?? "unknown"}=${i.id}`)
      .join(", ");
    throw new Error(
      `The GitHub App is installed in multiple accounts (${accounts}). Set GITHUB_APP_INSTALLATION_ID to pick one.`,
    );
  }

  const [installation] = installations;
  if (!installation) {
    throw new Error(
      "The GitHub App is not installed anywhere yet. Install it in your organisation and select the repositories it may read.",
    );
  }

  installationIdCache = String(installation.id);
  return installationIdCache;
}

/**
 * Returns a cached installation access token, minting a new one when needed.
 */
export async function getInstallationToken(): Promise<string> {
  if (!isGithubAppConfigured) {
    throw new Error("GitHub App is not configured.");
  }

  if (tokenCache && Date.now() < tokenCache.expiresAt - EXPIRY_MARGIN_MS) {
    return tokenCache.token;
  }

  if (inFlight) {
    return inFlight;
  }

  inFlight = (async () => {
    const installationId = await resolveInstallationId();

    const res = await githubAppFetch(
      `/app/installations/${installationId}/access_tokens`,
      { method: "POST" },
    );

    const data = (await res.json()) as { token: string; expires_at: string };

    tokenCache = {
      token: data.token,
      expiresAt: new Date(data.expires_at).getTime(),
    };

    return data.token;
  })();

  try {
    return await inFlight;
  } catch (error) {
    // Never cache a failure; the next request should retry.
    tokenCache = null;
    throw error;
  } finally {
    inFlight = null;
  }
}
