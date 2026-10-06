import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/server";
import {
  CATALOGUE_ENTRIES,
  type CatalogueEntry,
  repoUrl,
  resolveCatalogueEntry,
  sortedInputs,
} from "@terrablox/catalogue";
import { closestName } from "@terrablox/terraform/identifier-suggest";
import { z } from "zod";

import { summariseCost } from "./cost.js";
import { renderStack } from "./render.js";
import type { Stack, StackProblem } from "./stack.js";
import { APP_HTML } from "./ui.generated.js";
import { checkStack, hasBlocking } from "./validate.js";

/**
 * The curated module library, served to whatever host the user already works in.
 *
 * What this is and is not worth being precise about, because the difference is the whole
 * design. The Terrablox harness *owns* its agent loop: the only route from a model to a
 * repository is through validated operations, so "a fixed set of edit operations, and
 * nothing else" is enforced there. Here we are a guest in somebody else's host. We can
 * offer the library and we can tell an agent the truth about a module's interface, but we
 * cannot stop it writing Terraform by hand and ignoring all of this. So the tools are
 * shaped as answers rather than as gates: `check_stack` is worth calling because it knows
 * something the model does not, not because anything forces the call.
 *
 * Everything is served from a committed snapshot. No database, no network, no credentials:
 * the server can run inside an editor on a laptop with no access to our infrastructure,
 * which is the only shape that works for a host that launches it as a child process.
 */

const STACK_SCHEMA = z.object({
  calls: z
    .array(
      z.object({
        module: z
          .string()
          .describe("Catalogue slug or display name, e.g. `vpc` or `rds`."),
        name: z
          .string()
          .describe('The `module "<label>"` block label this call becomes.'),
        arguments: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "Input name to raw HCL expression. Read another call's output by writing `module.<label>.<output>`, exactly as Terraform does.",
          ),
      }),
    )
    .describe("The module calls that make up the stack."),
});

/** One line per module: enough to choose from, not enough to wire with. */
function summariseEntry(entry: CatalogueEntry): string {
  const required = entry.inputs.filter((input) => input.required).length;
  return [
    `${entry.slug} — ${entry.name} @ ${entry.version}`,
    entry.description ? `  ${entry.description}` : null,
    `  ${entry.inputs.length + entry.omitted.inputs} inputs (${required} required), ${
      entry.outputs.length + entry.omitted.outputs
    } outputs, ${entry.resources.length} resource types`,
  ]
    .filter((line) => line !== null)
    .join("\n");
}

function describeEntry(entry: CatalogueEntry): string {
  const lines: string[] = [
    `# ${entry.name} (${entry.slug})`,
    "",
    entry.description ?? "No description provided.",
    "",
    `Source: ${entry.repo} at ${entry.version} — ${repoUrl(entry)}`,
    "Pin this exact tag; the catalogue is only true of this one.",
    "",
    "## Inputs",
  ];

  for (const input of sortedInputs(entry)) {
    const parts = [
      `- ${input.name}`,
      input.type ? `: ${input.type}` : "",
      input.required ? " (required)" : "",
      input.default !== null && !input.required
        ? ` — default ${input.default}`
        : "",
    ];
    lines.push(parts.join(""));
    if (input.description) lines.push(`    ${input.description}`);
  }

  if (entry.omitted.inputs > 0) {
    lines.push(
      "",
      `${entry.omitted.inputs} further inputs are not in this snapshot. Required ones are never omitted, so anything missing here is optional — but check ${entry.repo} before concluding an argument is invalid.`,
    );
  }

  lines.push("", "## Outputs");
  for (const output of entry.outputs) {
    lines.push(`- ${output.name}`);
    if (output.description) lines.push(`    ${output.description}`);
  }
  if (entry.outputs.length === 0) {
    lines.push("- none; nothing downstream can depend on this module.");
  }
  if (entry.omitted.outputs > 0) {
    lines.push("", `${entry.omitted.outputs} further outputs are not listed.`);
  }

  // No declared types for outputs: Terraform gives them none, and this snapshot does not
  // carry the value expression an inference would read. Saying nothing beats guessing.
  lines.push(
    "",
    "## Resource types",
    entry.resources.length
      ? entry.resources.map((type) => `- ${type}`).join("\n")
      : "- none",
  );

  return lines.join("\n");
}

function formatProblems(problems: readonly StackProblem[]): string {
  if (problems.length === 0) {
    return "No problems found against the declared interfaces. This is not a substitute for `terraform plan`, which sees the providers and the whole configuration.";
  }

  const lines = problems.map((problem) => {
    const mark = problem.severity === "blocking" ? "BLOCKING" : "WARNING";
    const caveat =
      problem.confidence === "unverifiable" ? " [unverifiable]" : "";
    return `- ${mark}${caveat} ${problem.kind}: ${problem.message}`;
  });

  const blocking = problems.filter((p) => p.severity === "blocking").length;

  return [
    `${problems.length} finding${problems.length === 1 ? "" : "s"}, ${blocking} blocking.`,
    "",
    ...lines,
  ].join("\n");
}

const APP_URI = "ui://terrablox/stack-review.html";

/** Builds the server. A factory, because `serveStdio` pins one instance per connection. */
export function createServer(): McpServer {
  const server = new McpServer({
    name: "terrablox-modules",
    version: "0.1.0",
  });

  // ---- Reading the catalogue ----------------------------------------------
  //
  // Prefixed `catalogue_`, and the prefix is load-bearing rather than decoration. The
  // dashboard serves its own MCP endpoint with a `list_modules` and a
  // `describe_module` that read the *user's imported library* out of Postgres. Someone
  // with both servers configured would otherwise see two tools of the same name giving
  // different answers, and no way to tell which was which — the host namespaces them by
  // server, which helps a human reading a config file and not at all a model choosing
  // between them. The name now says which library it reads.

  server.registerTool(
    "list_catalogue_modules",
    {
      title: "List catalogue modules",
      description:
        "The curated AWS module catalogue: every module, its pinned version, and how big its interface is. Each entry is a real repository at a real tag. Call this before proposing infrastructure, and prefer these over writing resources by hand — a module here has a known interface that `check_stack` can verify, and hand-written Terraform has none. Optionally filter by a word appearing in a slug, name or description.",
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe("Filter by substring, e.g. `rds` or `queue`."),
      }),
    },
    ({ query }) => {
      const needle = query?.trim().toLowerCase() ?? "";
      const matches = needle
        ? CATALOGUE_ENTRIES.filter(
            (entry) =>
              entry.slug.toLowerCase().includes(needle) ||
              entry.name.toLowerCase().includes(needle) ||
              (entry.description?.toLowerCase().includes(needle) ?? false),
          )
        : CATALOGUE_ENTRIES;

      if (matches.length === 0) {
        const suggestion = closestName(
          needle,
          CATALOGUE_ENTRIES.map((entry) => entry.slug),
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `Nothing matches "${query}"${
                suggestion ? `; did you mean "${suggestion}"?` : ""
              }. Call list_catalogue_modules with no query for all ${CATALOGUE_ENTRIES.length}.`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `${matches.length} of ${CATALOGUE_ENTRIES.length} modules.`,
              "",
              ...matches.map(summariseEntry),
            ].join("\n"),
          },
        ],
      };
    },
  );

  server.registerTool(
    "describe_catalogue_module",
    {
      title: "Describe module",
      description:
        "One module in full: every input with its declared type, whether it is required and what it defaults to; every output; and the resource types it creates. Call this before wiring a module rather than guessing an input or output name — a name from memory is usually nearly right, and nearly right is what fails at plan time.",
      inputSchema: z.object({
        module: z
          .string()
          .describe("Catalogue slug or display name, e.g. `vpc`."),
      }),
    },
    ({ module: wanted }) => {
      const entry = resolveCatalogueEntry(wanted);
      if (!entry) {
        const suggestion = closestName(
          wanted,
          CATALOGUE_ENTRIES.map((candidate) => candidate.slug),
        );
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `No module called "${wanted}" in the catalogue${
                suggestion ? `; did you mean "${suggestion}"?` : ""
              }. Call list_catalogue_modules for what is available.`,
            },
          ],
        };
      }

      return {
        content: [{ type: "text" as const, text: describeEntry(entry) }],
      };
    },
  );

  server.registerTool(
    "check_stack",
    {
      title: "Check stack",
      description:
        "Check a proposed set of module calls against the modules' real declared interfaces: arguments no module declares, required inputs left unset, values whose type cannot match, references to labels that are not in the stack, and outputs a module does not expose. Every finding is decided from the module's actual variables and outputs at its pinned tag. Call this before showing the user Terraform, and fix what it reports rather than describing it. Findings marked unverifiable are ones this catalogue genuinely cannot settle, because it holds only part of that module's interface — do not 'fix' those by deleting the argument.",
      inputSchema: z.object({ stack: STACK_SCHEMA }),
    },
    ({ stack }) => {
      const problems = checkStack(stack as Stack);
      return {
        content: [{ type: "text" as const, text: formatProblems(problems) }],
        structuredContent: { problems },
      };
    },
  );

  server.registerTool(
    "render_terraform",
    {
      title: "Render Terraform",
      description:
        "Write the stack out as Terraform, with every module source pinned to the tag the catalogue names. The version is never taken from you: an unpinned source is a configuration whose meaning changes when upstream releases. Refuses while any blocking problem stands, so call check_stack first — the refusal lists what to fix.",
      inputSchema: z.object({ stack: STACK_SCHEMA }),
    },
    ({ stack }) => {
      const problems = checkStack(stack as Stack);

      // Refusing rather than emitting with a warning attached. This is the one place the
      // server can act like the harness: code that cannot plan is not a useful artefact,
      // and handing it over means the user reviews something already known to be broken.
      if (hasBlocking(problems)) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: [
                "Not written: the stack has blocking problems.",
                "",
                formatProblems(problems),
              ].join("\n"),
            },
          ],
          structuredContent: { problems },
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `\`\`\`hcl\n${renderStack(stack as Stack)}\n\`\`\``,
          },
        ],
      };
    },
  );

  registerAppTool(
    server,
    "review_stack",
    {
      title: "Review stack",
      description:
        "Show the user an interactive review of a proposed stack: what each module call is, what the interface check found, what it would bill for, and the Terraform it renders to. Use this when presenting a stack to a person, rather than pasting a wall of HCL into the conversation. Call check_stack first if you want to act on the findings yourself — this one is for the human.",
      inputSchema: z.object({ stack: STACK_SCHEMA }),
      _meta: { ui: { resourceUri: APP_URI } },
    },
    ({ stack }) => {
      const typed = stack as Stack;
      const problems = checkStack(typed);
      const costs = summariseCost(typed);
      const blocking = hasBlocking(problems);

      const calls = typed.calls.map((call) => {
        const entry = resolveCatalogueEntry(call.module);
        return {
          name: call.name,
          module: call.module,
          resolved: entry
            ? {
                slug: entry.slug,
                title: entry.name,
                version: entry.version,
                repo: entry.repo,
              }
            : null,
          arguments: call.arguments ?? {},
        };
      });

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Stack review: ${typed.calls.length} module call${typed.calls.length === 1 ? "" : "s"}, ${problems.length} finding${problems.length === 1 ? "" : "s"}${blocking ? " including blocking ones" : ""}.`,
              "",
              formatProblems(problems),
            ].join("\n"),
          },
        ],
        // What the UI renders. Sent alongside the text rather than instead of it, because a
        // host that cannot render the app must still be able to show the answer.
        structuredContent: {
          calls,
          problems,
          costs,
          terraform: blocking ? null : renderStack(typed),
        },
      };
    },
  );

  registerAppResource(
    server,
    "Stack review",
    APP_URI,
    {
      // No `csp` at all, which is the tightest setting rather than the absence of one:
      // omitted means no network connections and no external resources. The panel is
      // self-contained — styles and script are inlined at build time — so there is nothing
      // to allow, and listing empty arrays would only look like a policy that had been
      // considered and left blank.
      _meta: {},
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: RESOURCE_MIME_TYPE,
          text: APP_HTML,
        },
      ],
    }),
  );

  return server;
}
