import "server-only";

/**
 * Just enough MCP to ask a server what tools it has.
 *
 * Deliberately not the official SDK. The one thing we need is `tools/list`, which
 * is three JSON-RPC messages over one HTTP endpoint; pulling in a client library
 * to make three requests would add a dependency to the deploy for code we would
 * still have to wrap in a timeout, a size cap and an SSRF check of our own.
 *
 * We do not *execute* tools here, and that boundary matters: calls are made by the
 * Copilot runtime inside a turn, where the permission handler counts and records
 * them. This module only reads a catalogue, so that the settings screen can offer
 * a switch per tool instead of one switch per server.
 *
 * Everything here treats the response as hostile. It is a third-party endpoint the
 * user pasted, so it gets a deadline, a byte ceiling, a field-by-field parse, and
 * no ability to make us follow it anywhere.
 */

/** One tool, as the server describes itself. */
export interface McpToolInfo {
  name: string;
  /** The server's display title, or its name when it offers none. */
  title: string;
  description: string;
  /**
   * The server's own `readOnlyHint`.
   *
   * Its claim, not our finding: nothing here verifies it, and a server that omits
   * annotations lands on `false` simply because it said nothing. Surfaced anyway,
   * because it is the only signal that separates a lookup from a call with an
   * effect on someone else's system, and a user deciding which tools to enable
   * deserves to see it.
   */
  readOnly: boolean;
}

export class McpClientError extends Error {}

/** Long enough for a cold serverless start, short enough not to hang a page. */
const REQUEST_TIMEOUT_MS = 10_000;

/** A tool catalogue is kilobytes. Anything past this is not one. */
const MAX_RESPONSE_BYTES = 1_000_000;

/** What a sane server advertises. Past this, something is wrong on their side. */
const MAX_TOOLS = 200;

const PROTOCOL_VERSION = "2025-06-18";

/**
 * Asks a server for its tools.
 *
 * Throws {@link McpClientError} with a sentence fit to show a user: this is
 * reached from a settings screen, where "connection refused" is the whole answer
 * and a stack trace is noise.
 */
export async function listMcpTools(input: {
  url: string;
  transport: string;
  headers: Record<string, string>;
}): Promise<McpToolInfo[]> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const post = async (body: unknown, sessionId?: string) => {
      const response = await fetch(input.url, {
        method: "POST",
        signal: controller.signal,
        // No redirect following. A redirect is how an allowed public URL becomes a
        // request to somewhere we refused at the door, and the SSRF check ran
        // against the address the user gave us.
        redirect: "manual",
        headers: {
          "Content-Type": "application/json",
          // Both, because a streamable-HTTP server may answer either way and
          // which one it picks is its choice, not ours.
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": PROTOCOL_VERSION,
          ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
          ...input.headers,
        },
        body: JSON.stringify(body),
      });

      return response;
    };

    const initResponse = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "terrablox", version: "1" },
      },
    });

    if (initResponse.status >= 300 && initResponse.status < 400) {
      throw new McpClientError(
        "The server redirected the request. Use the address it redirects to.",
      );
    }

    if (initResponse.status === 401 || initResponse.status === 403) {
      throw new McpClientError(
        "The server refused the credentials. Check the auth header.",
      );
    }

    if (!initResponse.ok) {
      throw new McpClientError(
        `The server answered ${initResponse.status} when asked to start a session.`,
      );
    }

    // Read before touching the body again: `initialize` is where a server that
    // speaks something else entirely gives itself away.
    const init = await readRpcResult(initResponse);

    if (!init || typeof init !== "object") {
      throw new McpClientError(
        "The server did not answer like an MCP server. Check the URL.",
      );
    }

    // Streamable HTTP hands out a session id in a header and expects it back on
    // every later request. Servers that do not use one simply omit it.
    const sessionId = initResponse.headers.get("Mcp-Session-Id") ?? undefined;

    // Required by the spec before ordinary requests. It is a notification, so
    // there is no reply to wait for and a server that ignores it is still fine.
    await post(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      sessionId,
    ).catch(() => undefined);

    const listResponse = await post(
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      sessionId,
    );

    if (!listResponse.ok) {
      throw new McpClientError(
        `The server answered ${listResponse.status} when asked for its tools.`,
      );
    }

    const result = await readRpcResult(listResponse);
    const tools = (result as { tools?: unknown } | null)?.tools;

    if (!Array.isArray(tools)) {
      throw new McpClientError("The server did not return a list of tools.");
    }

    return tools.slice(0, MAX_TOOLS).flatMap(toToolInfo);
  } catch (error) {
    if (error instanceof McpClientError) throw error;

    // An abort is our own deadline firing, which is worth saying plainly rather
    // than reporting as the generic failure it looks like.
    if (error instanceof Error && error.name === "AbortError") {
      throw new McpClientError(
        `The server did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds.`,
      );
    }

    throw new McpClientError(
      "The server could not be reached. Check the URL and that it is public.",
    );
  } finally {
    clearTimeout(deadline);
  }
}

/**
 * The `result` of a JSON-RPC reply, whether it arrived as JSON or as one SSE event.
 *
 * Streamable HTTP allows both for the same request, and which one a server picks
 * is not something the client controls — GitBook's answers with `text/event-stream`
 * for a plain request/response exchange, so handling only JSON would have failed
 * against the first real server this was pointed at.
 */
async function readRpcResult(response: Response): Promise<unknown> {
  const text = await readCapped(response);

  const payloads = response.headers
    .get("Content-Type")
    ?.includes("text/event-stream")
    ? sseData(text)
    : [text];

  for (const payload of payloads) {
    let message: unknown;

    try {
      message = JSON.parse(payload);
    } catch {
      continue;
    }

    const frame = message as {
      result?: unknown;
      error?: { message?: unknown };
    };

    if (frame.error) {
      const detail =
        typeof frame.error.message === "string" ? frame.error.message : null;

      throw new McpClientError(
        detail
          ? `The server replied: ${detail}`
          : "The server replied with an error.",
      );
    }

    if (frame.result !== undefined) return frame.result;
  }

  return null;
}

/** The `data:` payloads of an SSE body, in order. */
function sseData(body: string): string[] {
  const payloads: string[] = [];

  for (const line of body.split("\n")) {
    // Only `data:`. A well-formed stream also carries `event:` and `id:` lines,
    // and a comment line starts with a colon; none of them is JSON.
    if (line.startsWith("data:")) payloads.push(line.slice(5).trim());
  }

  return payloads;
}

/**
 * The body, refusing to buffer more than {@link MAX_RESPONSE_BYTES}.
 *
 * `response.text()` would read to the end, so a server streaming forever would be
 * held only by the request deadline while our memory grew the whole time. Reading
 * chunk by chunk means the ceiling is enforced on arrival.
 */
async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";

  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    bytes += value.byteLength;

    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new McpClientError(
        "The server sent far more data than a tool list.",
      );
    }

    text += decoder.decode(value, { stream: true });
  }

  return text + decoder.decode();
}

/** One entry of `tools/list`, or nothing when it is not usable. */
function toToolInfo(entry: unknown): McpToolInfo[] {
  if (!entry || typeof entry !== "object") return [];

  const raw = entry as {
    name?: unknown;
    title?: unknown;
    description?: unknown;
    annotations?: { title?: unknown; readOnlyHint?: unknown };
  };

  // The name is the only field we cannot do without: it is what the allow list is
  // written in, so a tool without one cannot be switched on or off.
  if (typeof raw.name !== "string" || !raw.name) return [];

  const title =
    typeof raw.annotations?.title === "string"
      ? raw.annotations.title
      : typeof raw.title === "string"
        ? raw.title
        : raw.name;

  return [
    {
      name: raw.name.slice(0, 200),
      title: title.slice(0, 200),
      description:
        typeof raw.description === "string"
          ? raw.description.slice(0, 2000)
          : "",
      readOnly: raw.annotations?.readOnlyHint === true,
    },
  ];
}
