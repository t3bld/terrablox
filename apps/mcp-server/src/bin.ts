import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { createServer } from "./server.js";

/**
 * The executable an MCP host launches.
 *
 * stdio is the transport because that is what a host launching a child process speaks:
 * JSON-RPC arrives on stdin and leaves on stdout. The consequence runs through this whole
 * package — **nothing may write to stdout** except the protocol. A stray `console.log`
 * does not produce a log line, it produces a parse error at the other end and a server the
 * editor reports as broken. Diagnostics go to stderr, which hosts collect as the server's
 * log.
 *
 * `serveStdio` takes a factory rather than an instance: it pins one server per connection
 * so that a 2025-era client and a 2026-era one can be served from the same binary without
 * either being told about the other.
 */

const handle = serveStdio(() => createServer());

// A host stops a server by closing the pipe or signalling it. Without this the process
// lingers after the editor has moved on, holding a stdin nobody will write to again.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void handle.close().finally(() => process.exit(0));
  });
}
