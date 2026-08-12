import "server-only";

import type { MCPServerConfig } from "@github/copilot-sdk";
import { prisma } from "@terrablox/database";

import { decryptSecret, encryptSecret } from "@/lib/crypto/secret-box";
import { isKnownSkill } from "./skills";

/**
 * Per-user agent settings: what to tell the agent, and what it may reach.
 *
 * Everything a user types here ends up in their own prompt or in a request made
 * on their behalf, so validation is about protecting the user and this server —
 * not about protecting other users, who never see any of it.
 */

/** Long enough for real house rules, short enough not to crowd out the graph. */
export const MAX_INSTRUCTIONS_LENGTH = 4000;

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
  skills: string[];
  mcpServers: McpServerView[];
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
    // Filter on read as well as on write: a skill we retired should stop
    // applying immediately, not once someone next saves their settings.
    skills: (settings?.skills ?? []).filter(isKnownSkill),
    mcpServers: servers.map(toServerView),
  };
}

export async function saveAgentSettings(
  userId: string,
  input: { instructions: string; skills: string[] },
): Promise<void> {
  const instructions = input.instructions.trim();

  if (instructions.length > MAX_INSTRUCTIONS_LENGTH) {
    throw new AgentSettingsError(
      `Instructions are limited to ${MAX_INSTRUCTIONS_LENGTH} characters.`,
    );
  }

  const skills = [...new Set(input.skills)].filter(isKnownSkill);

  await prisma.agentSettings.upsert({
    where: { userId },
    create: { userId, instructions, skills },
    update: { instructions, skills },
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
