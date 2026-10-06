# @terrablox/mcp-server

Serves the curated Terraform module library to any MCP host — GitHub Copilot in VS Code,
Claude Desktop, or anything else speaking the protocol — with an interactive review panel.

Reads no database, opens no sockets, holds no credentials. Everything comes from a
committed snapshot of the `terrablox-aws-*` repositories at their pinned tags, so the
server can run as a child process of an editor on a laptop that has no access to any
Terrablox infrastructure.

## What this is, and what it is not

The Terrablox harness owns its agent loop: the only route from a model to a repository is
through validated operations, so "a fixed set of edit operations, and nothing else" is
something it can actually enforce. Here we are a guest in somebody else's host. This
server can offer the library and tell an agent the truth about a module's interface. It
cannot stop that agent ignoring all of it and writing Terraform from memory.

So the tools are shaped as answers rather than as gates. `check_stack` is worth calling
because it knows something the model does not — the real declared inputs and outputs of a
real module at a real tag — not because anything compels the call. If you need the
guarantee rather than the help, that is the harness, not this.

It is also not `terraform validate`. That needs the providers downloaded and the whole
configuration in hand, it runs later, and nothing here replaces it. What this checks is the
subset decidable from a module's interface, which happens to be the subset agents get
wrong: an argument that was never declared, an output that does not exist, a required input
quietly left unset.

## Tools

| Tool | What it does |
| --- | --- |
| `list_catalogue_modules` | The catalogue: every module, its pinned version, the size of its interface. Optional substring filter. |
| `describe_catalogue_module` | One module in full — inputs with declared types, defaults and requiredness; outputs; resource types. |

The `catalogue_` prefix matters. A Terrablox dashboard serves its own MCP endpoint at
`/api/mcp`, with a `list_modules` and a `describe_module` that read the signed-in user's
*imported* library from the database. Both servers configured at once would otherwise
offer two tools of the same name returning different lists, and the host's per-server
namespacing helps a person reading a config file rather than a model choosing a tool.
| `check_stack` | Checks proposed module calls against the real interfaces. The reason this server exists. |
| `render_terraform` | Writes the stack out with every source pinned to its tag. Refuses while blocking problems stand. |
| `review_stack` | The same review as an interactive panel, for showing a person. Renders as an MCP App. |

`check_stack` reports: `unknown-module`, `duplicate-label`, `invalid-label`,
`missing-input`, `unknown-argument`, `type-mismatch`, `dangling-module`, `unknown-output`,
`self-reference`.

### The one caveat worth reading

The snapshot keeps at most forty inputs and forty outputs per module, and a few modules
declare far more — `vpc` has 236 inputs. For those, "this argument is not declared" is not
something the snapshot can settle, so such findings come back as `warning` with
`confidence: "unverifiable"`, naming the omission and the repository to check. They are
never `blocking`, because telling an agent to delete a legitimate argument is worse than
saying nothing.

Required inputs are exempt, and by construction rather than by luck: the snapshot sorts
required inputs first, so the cap cannot hide one. `checkRequired` verifies that invariant
per module instead of trusting it — if the last input kept is still a required one, the
list may have been cut mid-way and the report says so.

## Build

```sh
pnpm --filter @terrablox/mcp-server build
```

esbuild rather than `tsc`, because the consumer is `node` — launched by an editor that knows
nothing about pnpm workspaces. The libraries under `packages/` ship raw TypeScript for a
bundler to compile, so emitted JavaScript still importing `@terrablox/catalogue` would
resolve to nothing on someone else's machine. Bundling flattens the whole workspace graph
into a single `dist/bin.js` with no runtime dependencies, which is also what would make
`npx terrablox-mcp` possible outside this repo. The review panel is bundled and inlined into
one HTML document in the same pass, because a `ui://` resource is a single string handed
over `resources/read` — there is no second file it could fetch.

## Why this lives under `apps/`

It is a library in most respects — pure functions over a committed snapshot, with two of its
four source files under test — so `packages/` would be the obvious home. It sits here for one
concrete reason: the dashboard's `Dockerfile` copies `packages/` into the production image
wholesale, and only `apps/dashboard` out of `apps/`. Anything under `packages/` therefore
ships to every self-hoster whether the dashboard imports it or not, and this server is not
part of what a customer runs. The marketing site is here for the same reason.

The consequence to know: the dashboard must not import from here. It does not, and if it
ever needed the same tool definitions, the right move would be to lift those into a package
rather than to reach across. `vitest.config.ts` puts this workspace in the alias-free
project for the same reason — it resolves like a library, wherever the folder sits.

## GitHub Copilot in VS Code

Workspace configuration, in `.vscode/mcp.json`:

```json
{
  "servers": {
    "terrablox-modules": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/apps/mcp-server/dist/bin.js"]
    }
  }
}
```

Then open the Chat view in Agent mode and ask for infrastructure; the tools appear under
**Configure Tools**. VS Code renders MCP Apps, so `review_stack` shows the panel inline.

Two things worth knowing. The Agent Host does not read `.vscode/mcp.json` — for
configuration that also works there, put the same `servers` block in a workspace
`.mcp.json` or in `~/.copilot/mcp-config.json`. And because this server needs neither the
network nor the file system, it is a good candidate for VS Code's sandbox: add
`"sandboxEnabled": true` to the server entry, on macOS and Linux.

Note that Copilot Extensions built as GitHub Apps were shut down on 10 November 2025. MCP
is the supported way to add tools to Copilot, which is why this is an MCP server and not a
GitHub App.

## Claude Desktop

Claude Desktop uses `mcpServers` rather than `servers`, and takes no `type` field. Settings
→ Developer → Edit Config:

```json
{
  "mcpServers": {
    "terrablox-modules": {
      "command": "node",
      "args": ["/absolute/path/to/terrablox/apps/mcp-server/dist/bin.js"]
    }
  }
}
```

No `${workspaceFolder}` here, so the path has to be absolute. Restart the app afterwards.

Caveat on the panel: MCP Apps from *locally configured* servers are reported not to render
in Claude at the time of writing — the remote-connector path is reached from Anthropic's
own network, and a local stdio server is not. The tools work either way, and every one of
them returns readable text alongside the structured content precisely so that a host which
cannot draw the panel still shows the answer.

## Anything else

Any MCP host that launches a stdio child process works the same way: run
`node dist/bin.js`. Nothing is host-specific except the shape of the config file.

## Developing

`stdout` belongs to JSON-RPC. A stray `console.log` does not produce a log line, it
produces a parse error at the other end and a server the editor reports as broken. Write
diagnostics to `stderr`, which hosts collect as the server log.

To exercise the built server the way a host would:

```sh
pnpm --filter @terrablox/mcp-server probe
```

`probe.mjs` drives `dist/bin.js` over stdio with a real MCP client: lists tools and
resources, calls each tool, and prints what comes back. It is worth more than it looks —
compiling proves nothing about a protocol server, and the first run of this found two real
bugs that `tsc` was never going to see: rendered HCL with an unquoted string, and a
reference check that silently stopped early.

Unit tests run from the repository root with `pnpm test`, and deliberately assert against
the real catalogue rather than fixtures. A regenerated snapshot can therefore break one,
which is the correct outcome: it means a module's interface moved.
