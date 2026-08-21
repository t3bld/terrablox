import "server-only";

import type { MCPServerConfig } from "@github/copilot-sdk";
import { prisma } from "@terrablox/database";

import { decryptSecret, encryptSecret } from "@/lib/crypto/secret-box";
import { isKnownKnowledge } from "./knowledge";
import {
  REASONING_EFFORTS,
  type ReasoningEffortValue,
  TURN_TIMEOUT_MAX_SECONDS,
  TURN_TIMEOUT_MIN_SECONDS,
} from "./runtime-options";
import { isKnownTool } from "./tool-catalogue";

/**
 * Per-user agent settings: what to tell the agent, and what it may reach.
 *
 * Everything a user types here ends up in their own prompt or in a request made
 * on their behalf, so validation is about protecting the user and this server —
 * not about protecting other users, who never see any of it.
 */

/** Long enough for real house rules, short enough not to crowd out the graph. */
export const MAX_INSTRUCTIONS_LENGTH = 4000;

// Re-exported so server code has one import for "agent settings" and does not
// have to know which constants happen to be safe for the browser.
export {
  DEFAULT_TURN_TIMEOUT_SECONDS,
  REASONING_EFFORTS,
  type ReasoningEffortValue,
  TURN_TIMEOUT_MAX_SECONDS,
  TURN_TIMEOUT_MIN_SECONDS,
} from "./runtime-options";

export class AgentSettingsError extends Error {}

export interface McpServerView {
  id: string;
  name: string;
  url: string;
  transport: "http" | "sse";
  enabled: boolean;
  /** Header names only. The values are secrets and are never sent back. */
  headerNames: string[];
}

export interface AgentSettingsView {
  instructions: string;
  /** Knowledge source ids withheld from the agent. Empty means all available. */
  disabledKnowledge: string[];
  mcpServers: McpServerView[];
  /** Null means "auto": Copilot picks what the user is entitled to. */
  model: string | null;
  /** Null leaves the model's own default in place. */
  reasoningEffort: ReasoningEffortValue | null;
  /** Tool names the agent may not call. */
  disabledTools: string[];
  /** How long a turn may run, in seconds. Null → default (300s). */
  turnTimeout: number | null;
  /** Whether the agent may delete modules and variables. Off by default. */
  allowDestructive: boolean;
}

export async function getAgentSettings(
  userId: string,
): Promise<AgentSettingsView> {
  const [settings, servers] = await Promise.all([
    prisma.agentSettings.findUnique({ where: { userId } }),
    prisma.agentMcpServer.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  return {
    instructions: settings?.instructions ?? "",
    // Filtered on read as well as on write: an id we retired must stop
    // withholding anything immediately, not once someone next saves.
    disabledKnowledge: (settings?.disabledKnowledge ?? []).filter(
      isKnownKnowledge,
    ),
    mcpServers: servers.map(toServerView),
    model: settings?.model ?? null,
    reasoningEffort: asReasoningEffort(settings?.reasoningEffort),
    disabledTools: settings?.disabledTools ?? [],
    turnTimeout: settings?.turnTimeout ?? null,
    // A user who has never opened the settings gets the safe answer, which is the
    // same one the column defaults to.
    allowDestructive: settings?.allowDestructive ?? false,
  };
}

/**
 * Allows or forbids the destructive operations, leaving everything else alone.
 *
 * Its own function rather than a field on {@link setAgentRuntime}: the runtime
 * choices are about how well the agent works, and this one is about what it is
 * permitted to destroy. Sharing a writer would let a dropdown change save it.
 */
export async function setAgentAllowDestructive(
  userId: string,
  allowDestructive: boolean,
): Promise<void> {
  await prisma.agentSettings.upsert({
    where: { userId },
    create: { userId, instructions: "", allowDestructive },
    update: { allowDestructive },
  });
}

/** Replaces the deny list, leaving every other setting untouched. */
export async function setAgentDisabledTools(
  userId: string,
  tools: string[],
): Promise<void> {
  const disabledTools = [...new Set(tools)].filter(isKnownTool);

  await prisma.agentSettings.upsert({
    where: { userId },
    create: { userId, instructions: "", disabledTools },
    update: { disabledTools },
  });
}

export function asReasoningEffort(
  value: string | null | undefined,
): ReasoningEffortValue | null {
  return REASONING_EFFORTS.includes(value as ReasoningEffortValue)
    ? (value as ReasoningEffortValue)
    : null;
}

/**
 * A turn timeout in seconds, or null for the default.
 *
 * Out-of-range values are rejected rather than clamped: a clamp would silently
 * store something other than what the caller sent, and this is the one setting
 * where a wrong number is invisible until a turn dies.
 */
export function asTurnTimeout(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;

  const seconds = Number(value);

  if (
    !Number.isFinite(seconds) ||
    seconds < TURN_TIMEOUT_MIN_SECONDS ||
    seconds > TURN_TIMEOUT_MAX_SECONDS
  ) {
    throw new AgentSettingsError(
      `A turn timeout must be between ${TURN_TIMEOUT_MIN_SECONDS} and ${TURN_TIMEOUT_MAX_SECONDS} seconds.`,
    );
  }

  return Math.round(seconds);
}

/**
 * Replaces the runtime choices — model, thinking effort, turn timeout.
 *
 * Each field is written only when the caller mentions it, so the settings screen
 * can save one dropdown without having to hold the other two. Null is a value in
 * its own right here and means "let the default decide", which is why presence is
 * tested with `in` rather than by checking for null.
 */
export async function setAgentRuntime(
  userId: string,
  input: {
    model?: string | null;
    reasoningEffort?: string | null;
    turnTimeout?: number | string | null;
  },
): Promise<void> {
  const data: {
    model?: string | null;
    reasoningEffort?: string | null;
    turnTimeout?: number | null;
  } = {};

  if ("model" in input) {
    const model = typeof input.model === "string" ? input.model.trim() : "";

    // An identifier, not prose. The cap is defence against a request body being
    // used to write arbitrary length into a column the model id is read from.
    if (model.length > 200) {
      throw new AgentSettingsError("That model id is not valid.");
    }

    data.model = model || null;
  }

  if ("reasoningEffort" in input) {
    const effort = asReasoningEffort(
      typeof input.reasoningEffort === "string" ? input.reasoningEffort : null,
    );

    // Distinguishes "auto" from a typo: an unrecognised level would otherwise be
    // stored as null and look like a deliberate reset.
    if (input.reasoningEffort && !effort) {
      throw new AgentSettingsError(
        `Thinking effort must be one of ${REASONING_EFFORTS.join(", ")}.`,
      );
    }

    data.reasoningEffort = effort;
  }

  if ("turnTimeout" in input) {
    data.turnTimeout = asTurnTimeout(input.turnTimeout);
  }

  if (Object.keys(data).length === 0) return;

  await prisma.agentSettings.upsert({
    where: { userId },
    create: { userId, instructions: "", ...data },
    update: data,
  });
}

export async function saveAgentSettings(
  userId: string,
  input: { instructions: string },
): Promise<void> {
  const instructions = input.instructions.trim();

  if (instructions.length > MAX_INSTRUCTIONS_LENGTH) {
    throw new AgentSettingsError(
      `Instructions are limited to ${MAX_INSTRUCTIONS_LENGTH} characters.`,
    );
  }

  await prisma.agentSettings.upsert({
    where: { userId },
    create: { userId, instructions },
    update: { instructions },
  });
}

/**
 * Replaces the knowledge deny list, leaving every other setting untouched.
 *
 * The context view toggles one source at a time and never loads the instruction
 * text, so it must not be able to send an empty one and wipe what the user
 * wrote on the settings tab.
 */
export async function setAgentDisabledKnowledge(
  userId: string,
  ids: string[],
): Promise<void> {
  const disabledKnowledge = [...new Set(ids)].filter(isKnownKnowledge);

  await prisma.agentSettings.upsert({
    where: { userId },
    create: { userId, instructions: "", disabledKnowledge },
    update: { disabledKnowledge },
  });
}

export async function addMcpServer(
  userId: string,
  input: {
    name: string;
    url: string;
    transport: string;
    headers: Record<string, string>;
  },
): Promise<McpServerView> {
  const name = input.name.trim();

  // The name becomes the namespace its tools appear under, so it has to be
  // something the model can refer to unambiguously.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/.test(name)) {
    throw new AgentSettingsError(
      "Use a short name of letters, numbers, hyphens or underscores.",
    );
  }

  const transport = input.transport === "sse" ? "sse" : "http";
  const url = assertSafeUrl(input.url.trim());
  const headers = assertHeaders(input.headers);

  const existing = await prisma.agentMcpServer.findUnique({
    where: { userId_name: { userId, name } },
  });

  if (existing) {
    throw new AgentSettingsError(`You already have a server called "${name}".`);
  }

  const record = await prisma.agentMcpServer.create({
    data: {
      userId,
      name,
      url,
      transport,
      headersCiphertext: Object.keys(headers).length
        ? encryptSecret(JSON.stringify(headers))
        : null,
      // Off on creation. Adding a server and trusting it are two decisions, and
      // the second one deserves its own click.
      enabled: false,
    },
  });

  return toServerView(record);
}

export async function setMcpServerEnabled(
  userId: string,
  id: string,
  enabled: boolean,
): Promise<void> {
  // Scoped by userId so an id guessed from elsewhere cannot touch another
  // person's server.
  const { count } = await prisma.agentMcpServer.updateMany({
    where: { id, userId },
    data: { enabled },
  });

  if (count === 0)
    throw new AgentSettingsError("That server no longer exists.");
}

export async function deleteMcpServer(
  userId: string,
  id: string,
): Promise<void> {
  await prisma.agentMcpServer.deleteMany({ where: { id, userId } });
}

/**
 * The MCP servers to hand to a session, decrypted.
 *
 * Only enabled ones, and only ones whose secrets we can still read: a server we
 * cannot authenticate to would fail on first use, which is a worse experience
 * than quietly not offering its tools.
 */
export async function mcpServersForSession(
  userId: string,
): Promise<Record<string, MCPServerConfig>> {
  const servers = await prisma.agentMcpServer.findMany({
    where: { userId, enabled: true },
  });

  const config: Record<string, MCPServerConfig> = {};

  for (const server of servers) {
    const headers = readHeaders(server.headersCiphertext);
    if (server.headersCiphertext && !headers) continue;

    config[server.name] = {
      type: server.transport === "sse" ? "sse" : "http",
      url: server.url,
      ...(headers ? { headers } : {}),
    };
  }

  return config;
}

/**
 * Rejects anything that is not a plain https endpoint on the public internet.
 *
 * The runtime makes these requests from inside our network, so a URL pointing
 * at localhost or a link-local address turns the agent into a proxy for
 * reaching things the user could not reach themselves — the server-side request
 * forgery problem. Hostnames still resolve at request time, so this is a first
 * line of defence rather than the only one; deployments should also egress
 * through a network that cannot route to internal ranges.
 */
function assertSafeUrl(value: string): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new AgentSettingsError("That is not a valid URL.");
  }

  if (url.protocol !== "https:") {
    throw new AgentSettingsError(
      "The URL must use https, since auth headers travel with every request.",
    );
  }

  const host = url.hostname.toLowerCase();

  const isBlocked =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host === "metadata.google.internal" ||
    /^\[?::1\]?$/.test(host) ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);

  if (isBlocked) {
    throw new AgentSettingsError(
      "That address is inside the server's own network, which is not allowed.",
    );
  }

  return url.toString();
}

function assertHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const clean: Record<string, string> = {};

  for (const [name, value] of Object.entries(headers)) {
    const key = name.trim();
    if (!key) continue;

    // A newline in either half would let a value forge extra headers.
    if (!/^[a-zA-Z0-9-]+$/.test(key) || /[\r\n]/.test(value)) {
      throw new AgentSettingsError(`"${name}" is not a valid header.`);
    }

    clean[key] = value;
  }

  if (Object.keys(clean).length > 10) {
    throw new AgentSettingsError("That is more headers than any server needs.");
  }

  return clean;
}

function readHeaders(ciphertext: string | null): Record<string, string> | null {
  if (!ciphertext) return null;

  const plaintext = decryptSecret(ciphertext);
  if (!plaintext) return null;

  try {
    return JSON.parse(plaintext) as Record<string, string>;
  } catch {
    return null;
  }
}

function toServerView(record: {
  id: string;
  name: string;
  url: string;
  transport: string;
  enabled: boolean;
  headersCiphertext: string | null;
}): McpServerView {
  return {
    id: record.id,
    name: record.name,
    url: record.url,
    transport: record.transport === "sse" ? "sse" : "http",
    enabled: record.enabled,
    headerNames: Object.keys(readHeaders(record.headersCiphertext) ?? {}),
  };
}
