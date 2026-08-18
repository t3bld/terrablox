import "server-only";

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";

/**
 * Copilot as the model behind the project agent.
 *
 * TerraBlox holds no model API key. Each turn runs on the signed-in user's own
 * Copilot subscription, using the GitHub token they already granted us, so
 * usage is billed and rate-limited per user and their organisation's Copilot
 * policies apply unchanged.
 *
 * The SDK spawns the Copilot CLI as a child process and talks to it over stdin
 * and stdout. Nothing listens on a port, so there is no unauthenticated
 * surface to protect and nothing to start or configure separately.
 */

/** Model a turn runs on unless the chat picker says otherwise. */
export const COPILOT_MODEL =
  process.env.COPILOT_MODEL?.trim() || "claude-opus-5";

/** How hard that model thinks unless the chat picker says otherwise. */
export const COPILOT_REASONING_EFFORT =
  process.env.COPILOT_REASONING_EFFORT?.trim() || "high";

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
 * about their account and not a bug in TerraBlox.
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
