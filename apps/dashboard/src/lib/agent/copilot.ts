import "server-only";

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import {
  type ModelChoice,
  resolveModelChoice,
} from "@terrablox/agent-harness/runtime-options";

/**
 * Copilot as the model behind the project agent.
 *
 * Terrablox holds no model API key. Each turn runs on the signed-in user's own
 * Copilot subscription, using the GitHub token they already granted us, so
 * usage is billed and rate-limited per user and their organisation's Copilot
 * policies apply unchanged.
 *
 * The SDK spawns the Copilot CLI as a child process and talks to it over stdin
 * and stdout. Nothing listens on a port, so there is no unauthenticated
 * surface to protect and nothing to start or configure separately.
 */

/**
 * The default when the user's model list cannot be read.
 *
 * Not the default itself any more: that is the newest Anthropic model on the
 * user's own list (see `resolveDefaultModel`), so a new Claude release becomes
 * the default without a deploy. This id only applies when there is no list to
 * choose from — no token, no seat, a runtime that would not start.
 */
export const COPILOT_MODEL = "claude-opus-5.5";

/** How hard that model thinks unless the chat picker says otherwise. */
export const COPILOT_REASONING_EFFORT = "high";

let client: CopilotClient | null = null;

/**
 * One client for the whole app, sessions carry the identity.
 *
 * `mode: "empty"` means it brings no tools of its own, so a session can never
 * reach the server's filesystem or shell — it gets exactly the tools we
 * register and nothing else. That mode needs somewhere to keep session state,
 * and a temp directory is the honest choice: the transcript we care about
 * lives in Postgres, so nothing here needs to survive a restart.
 */
export function copilotClient(): CopilotClient {
  if (!client) {
    const baseDirectory = join(tmpdir(), "terrablox-copilot");
    mkdirSync(baseDirectory, { recursive: true });

    client = new CopilotClient({
      // No path: the SDK finds the CLI itself, and only its own code can — it
      // runs unbundled, so its resolver sees the real node_modules layout
      // rather than webpack's module graph.
      connection: RuntimeConnection.forStdio(),
      mode: "empty",
      baseDirectory,
      useLoggedInUser: false,
    });
  }

  return client;
}

/** What one model looks like to the settings screen and the chat composer. */
export interface CopilotModelInfo {
  id: string;
  name: string;
  reasoningEfforts: string[];
  multiplier: number | null;
  /** Null when the runtime does not say, which is the usual case today. */
  vendor: string | null;
  preview: boolean;
}

/**
 * How long a listing is reused before the runtime is asked again.
 *
 * Entitlements change rarely — a seat being granted, a policy being flipped — so
 * ten minutes is far shorter than the thing it caches. It exists because the
 * listing costs a CLI process: roughly half a second to spawn and a second to
 * answer, which is too much to pay on every render of the settings screen.
 *
 * It is also the longest a newly released model takes to appear, and with it to
 * become the default when it is the newest Claude: entries expire rather than
 * being refreshed in place, so the next request after that asks the runtime.
 */
const MODEL_CACHE_TTL_MS = 10 * 60 * 1000;

const modelCache = new Map<
  string,
  { at: number; models: CopilotModelInfo[] }
>();

/**
 * Listings in flight, by the same key.
 *
 * The settings screen asks for the list and for what "no choice" resolves to in
 * two parallel requests, and both need the listing. Without this a cold cache
 * would spawn two CLI processes to answer the same question twice.
 */
const pendingListings = new Map<string, Promise<CopilotModelInfo[] | null>>();

/** Keyed by digest so the cache never holds a usable token. */
function cacheKey(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 32);
}

/**
 * The models this user's Copilot entitlement allows.
 *
 * A client of its own, authenticated with their token and thrown away again.
 * The shared {@link copilotClient} cannot answer this: it is deliberately
 * unauthenticated so that sessions can carry different identities, and an
 * unauthenticated runtime rejects `models.list` outright — which is why this used
 * to come back empty every single time and leave the model dropdown with nothing
 * in it but whatever was already stored.
 *
 * Every model the runtime reports is kept — any vendor, preview or not, whatever
 * its multiplier — except two kinds. One is a model the user's Copilot policy
 * has not enabled: `disabled` was switched off by them or their organisation, and
 * `unconfigured` is waiting for someone to accept its terms, which this headless
 * runtime has no way to do, so a turn on it would fail. A model reported with no
 * policy at all is offered, since nothing says it is withheld. The other is
 * `auto`, below.
 *
 * Returned in the runtime's own order, which is the order Copilot's own pickers
 * use, so the list reads the same here as in the user's editor.
 *
 * Returns null when the listing could not be obtained, so the caller can tell
 * "no entitlement information" from "entitled to nothing".
 */
export async function listCopilotModels(
  githubToken: string,
): Promise<CopilotModelInfo[] | null> {
  const key = cacheKey(githubToken);
  const cached = modelCache.get(key);

  if (cached && Date.now() - cached.at < MODEL_CACHE_TTL_MS) {
    return cached.models;
  }

  const pending = pendingListings.get(key);
  if (pending) return pending;

  const listing = fetchCopilotModels(githubToken, key).finally(() => {
    pendingListings.delete(key);
  });
  pendingListings.set(key, listing);
  return listing;
}

/** The fields some runtimes add to a listing beyond the SDK's own type. */
interface ListedModelExtras {
  vendor?: unknown;
  preview?: unknown;
}

async function fetchCopilotModels(
  githubToken: string,
  key: string,
): Promise<CopilotModelInfo[] | null> {
  // Its own directory: two CLI processes sharing session state is not something
  // to find out about in production.
  const baseDirectory = join(tmpdir(), "terrablox-copilot-models");
  mkdirSync(baseDirectory, { recursive: true });

  const client = new CopilotClient({
    connection: RuntimeConnection.forStdio(),
    mode: "empty",
    baseDirectory,
    gitHubToken: githubToken,
  });

  try {
    // Explicit, because `listModels` does not start the runtime itself and fails
    // with "Client not connected" if nothing else has.
    await client.start();

    const models = (await client.listModels())
      .filter((model) => !model.policy || model.policy.state === "enabled")
      // `auto` is not a model, it is Copilot choosing one. Offering it in a list
      // of model names makes the list mean two different things.
      .filter((model) => model.id !== "auto")
      .map((model) => {
        // Read defensively: neither field is in the SDK's type, and the runtime
        // this was verified against sends neither — the id carries the vendor.
        const extras = model as typeof model & ListedModelExtras;

        return {
          id: model.id,
          name: model.name ?? model.id,
          reasoningEfforts: model.supportedReasoningEfforts ?? [],
          multiplier: model.billing?.multiplier ?? null,
          vendor: typeof extras.vendor === "string" ? extras.vendor : null,
          preview:
            extras.preview === true ||
            /preview/i.test(`${model.id} ${model.name ?? ""}`),
        };
      });

    modelCache.set(key, { at: Date.now(), models });
    return models;
  } catch (error) {
    console.error("[agent] could not list models", error);
    return null;
  } finally {
    // Left running it would leak a CLI process per cache miss.
    await client.stop().catch(() => undefined);
  }
}

/**
 * What a turn for this user runs on, given what they chose (null for nothing).
 *
 * The one place a default model is resolved on the server, so the settings
 * screen, the composer, a new project's snapshot and the turn itself cannot
 * disagree about it. The rule is `resolveModelChoice`: an explicit choice wins
 * while the user's list still offers it, and otherwise the newest Anthropic
 * model on that list. Without a token or a listing it falls back to
 * {@link COPILOT_MODEL}, and an explicit choice is trusted as it stands.
 */
export async function resolveCopilotModel(
  githubToken: string | null,
  chosen: string | null | undefined,
): Promise<ModelChoice> {
  const models = githubToken ? await listCopilotModels(githubToken) : null;
  return resolveModelChoice(chosen, models, COPILOT_MODEL);
}

/**
 * Drops the cached client after the CLI process died.
 *
 * The SDK never restarts it, so without this a single crash would leave every
 * later request talking to a corpse. Spawning is cheap; a permanently broken
 * agent is not.
 */
export function discardCopilotClient(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);

  if (
    /CLI server exited|Timeout waiting for CLI server|Failed to start CLI/.test(
      message,
    )
  ) {
    client = null;
  }
}

/**
 * Turns a Copilot failure into something the user can act on.
 *
 * The common case by far is a user without a Copilot seat, which is a fact
 * about their account and not a bug in Terrablox.
 */
export function describeCopilotError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (/401|unauthor/i.test(message)) {
    return "GitHub rejected the request. Reconnect GitHub and try again.";
  }

  if (/403|not entitled|no access|subscription|seat/i.test(message)) {
    return "Your GitHub account has no active Copilot subscription, so the agent cannot run.";
  }

  if (/429|rate limit|quota/i.test(message)) {
    return "Your Copilot quota is used up for now. Try again later.";
  }

  return message;
}
