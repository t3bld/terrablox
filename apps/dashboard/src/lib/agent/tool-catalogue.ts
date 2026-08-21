/**
 * What the project agent can do, declared once.
 *
 * Separate from the agent itself so that settings and API routes can name and
 * gate tools without importing the Copilot SDK — and so the agent can validate
 * a deny list without depending on the settings store that produced it.
 *
 * The `modules` and `locals` groups carry the same five verbs, in the same order:
 * add, remove, connect, disconnect, edit. A module and a variable are different
 * things the agent does the same five things to, and a reader scanning the
 * settings screen should not have to work out which of two lists a given verb
 * landed in.
 *
 * The other three groups are not like them, and share the property worth knowing
 * before reading `buildTools`: they queue no mutation and cost no operation
 * budget, because they change nothing.
 *
 *   library    looks a module up before placing it. The prompt can only afford a
 *              line per module, so anything more has to be asked for.
 *   review     asks what the queued edits add up to, and states a plan before
 *              making them. Both exist because a turn that cannot check itself
 *              ends when it runs out of steps rather than when the work is done.
 *   app-repo   reads the linked application's own repository, read-only.
 *
 * `name` is stored in the deny list, so renaming one re-enables it for anyone who
 * had it switched off. Worth it once, to get the vocabulary right.
 */

/** Tool definitions, in the shape function-calling APIs expect. */
export const PROJECT_AGENT_TOOLS = [
  // ---- Looking a module up ------------------------------------------------
  // The library reaches the prompt as one line per module, which is enough to
  // choose from and not enough to wire with. This is where the rest of a module
  // lives: its inputs with their types and defaults, its outputs, and what its
  // resources do to a bill. Lazy on purpose — a catalogue's worth of ports in
  // every prompt would crowd out the project the user asked about.
  {
    name: "describe_module",
    group: "library",
    label: "Describe Module",
    summary:
      "Read a module's inputs, outputs and cost drivers before using it.",
    description:
      "Look up one module in full: every input with its declared type, whether it is required and what it defaults to; every output with its inferred type; and which of its resources bill by the hour rather than by usage. Accepts a library id, the name of a module on the canvas, or a library module's name. Call this before `connect`, rather than guessing an output name — a wrong port name is committed as written and only fails at plan time.",
    parameters: {
      type: "object",
      properties: {
        module: {
          type: "string",
          description:
            "Library module id, a block label on the canvas, or a module name.",
        },
      },
      required: ["module"],
    },
  },
  // ---- Planning and checking ----------------------------------------------
  {
    name: "propose_plan",
    group: "review",
    label: "Propose Plan",
    summary:
      "State which modules to add and how to wire them, before building.",
    description:
      "Write down what you intend to build before building it: the modules to add, and which output feeds which input. Recorded in the turn's trail, so the user can see the intent and stop you while it is still cheap. Use it for anything beyond a single edit. If the plan is large, present it and ask the user to confirm instead of building it in the same turn.",
    parameters: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "One or two sentences on what this will build and why.",
        },
        modules: {
          type: "array",
          description: "Library modules to add, with the label each will get.",
          items: {
            type: "object",
            properties: {
              moduleId: { type: "string" },
              name: { type: "string" },
              purpose: { type: "string" },
            },
            required: ["moduleId"],
          },
        },
        wiring: {
          type: "array",
          description: "Connections to make, as target input to source output.",
          items: {
            type: "object",
            properties: {
              target: { type: "string" },
              targetInput: { type: "string" },
              source: { type: "string" },
              sourceOutput: { type: "string" },
            },
            required: ["target", "targetInput"],
          },
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "review_project",
    group: "review",
    label: "Review Project",
    summary:
      "Check what the queued edits add up to, before finishing the turn.",
    description:
      "Report the project as it will be once this turn's edits are committed: which required inputs are still unset and what could fill them, arguments no module declares, references to modules or variables that do not exist, values whose type cannot match, and variables nothing reads. Your edits are not applied while you work, so this is the only way to see your own result. Call it after making changes and before answering, and fix what it reports rather than describing it.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "add_module",
    group: "modules",
    label: "Add Module",
    summary: "Place a module from your library on the canvas.",
    description:
      "Instantiate a module from the user's library as a new `module` block.",
    parameters: {
      type: "object",
      properties: {
        moduleId: { type: "string", description: "Library module id." },
        name: { type: "string", description: "Block label to use." },
      },
      required: ["moduleId"],
    },
  },
  {
    name: "remove_module",
    group: "modules",
    label: "Remove Module",
    summary: "Delete a module and every reference to it. Destructive.",
    description:
      "Delete a `module` block and every argument elsewhere that referenced it.",
    parameters: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "connect",
    group: "modules",
    label: "Connect Module",
    summary: "Wire one module's output into another module's input.",
    description:
      "Set an input of one module to an output of another, i.e. `target.targetInput = module.source.sourceOutput`.",
    parameters: {
      type: "object",
      properties: {
        source: { type: "string" },
        sourceOutput: { type: "string" },
        target: { type: "string" },
        targetInput: { type: "string" },
      },
      required: ["source", "sourceOutput", "target", "targetInput"],
    },
  },
  {
    name: "disconnect",
    group: "modules",
    label: "Disconnect Module",
    summary: "Remove a wire between two modules.",
    description:
      "Clear an input of a module that is fed by another module's output. Use `disconnect_local` for an input fed by a variable.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string" },
        targetInput: { type: "string" },
      },
      required: ["target", "targetInput"],
    },
  },
  {
    name: "edit_module",
    group: "modules",
    label: "Edit Module",
    summary: "Rename a module, or set what its inputs hold.",
    description:
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Terraform interpolation shown to the model, not a JavaScript placeholder.
      'Change a module block in place. Pass `newName` to rename it and rewrite every reference to it. Pass `arguments` to set inputs to raw HCL: a bare string is quoted for you, while `var.env`, `["a", "b"]` or `"${local.prefix}-web"` are written through unchanged. Both may be given in one call. To point an input at another module or a variable use `connect` or `connect_local` instead, which validate that the target exists.',
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Module block to change." },
        newName: { type: "string", description: "New block label." },
        arguments: {
          type: "array",
          description: "Inputs to set on this module.",
          items: {
            type: "object",
            properties: {
              input: { type: "string" },
              value: {
                type: "string",
                description: "HCL expression or plain value.",
              },
            },
            required: ["input", "value"],
          },
        },
      },
      required: ["name"],
    },
  },
  {
    name: "add_local",
    group: "locals",
    label: "Add Variable",
    summary: "Declare a variable, optionally wiring it into a module input.",
    description:
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Terraform interpolation shown to the model, not a JavaScript placeholder.
      'Declare a named value in a `locals` block. The value is a raw HCL expression: a bare string is quoted for you, while `module.vpc.id`, `[80, 443]` or `"${var.env}-web"` are written through unchanged. Pass `connectTo` to wire it into a module input in the same edit, which is what the canvas does when a variable is created from an unfilled input.',
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Variable name: letters, digits and underscores.",
        },
        value: {
          type: "string",
          description: "HCL expression or plain value.",
        },
        connectTo: {
          type: "object",
          description: "Module input to feed with this variable.",
          properties: {
            target: { type: "string" },
            targetInput: { type: "string" },
          },
          required: ["target", "targetInput"],
        },
      },
      required: ["name", "value"],
    },
  },
  {
    name: "remove_local",
    group: "locals",
    label: "Remove Variable",
    summary: "Delete a variable and every reference to it. Destructive.",
    description:
      "Delete a local and every module argument that read it, so the configuration still plans.",
    parameters: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "connect_local",
    group: "locals",
    label: "Connect Variable",
    summary: "Point a module input at a variable.",
    description:
      "Set an input of a module to a local, i.e. `target.targetInput = local.<local>`.",
    parameters: {
      type: "object",
      properties: {
        local: { type: "string" },
        target: { type: "string" },
        targetInput: { type: "string" },
      },
      required: ["local", "target", "targetInput"],
    },
  },
  {
    name: "disconnect_local",
    group: "locals",
    label: "Disconnect Variable",
    summary: "Stop a module input from reading a variable.",
    description:
      "Clear an input of a module that is fed by a local. Use `disconnect` for an input fed by another module.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string" },
        targetInput: { type: "string" },
      },
      required: ["target", "targetInput"],
    },
  },
  {
    name: "edit_local",
    group: "locals",
    label: "Edit Variable",
    summary: "Rename a variable, or change what it holds.",
    description:
      "Change a local in place. Pass `newName` to rename it and rewrite every `local.<name>` reference. Pass `value` to replace its expression. Both may be given in one call.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Variable to change." },
        newName: { type: "string" },
        value: {
          type: "string",
          description: "HCL expression or plain value.",
        },
      },
      required: ["name"],
    },
  },
  // ---- The linked application ---------------------------------------------
  // The only tools here that read instead of queueing an edit, and the only ones
  // that reach outside the project's own repository. Both are limited to the one
  // repository the user linked, and neither can write: infrastructure that fits
  // an application has to be derived from how that application is built, which
  // is a question about someone else's code and none of our business to change.
  {
    name: "list_app_files",
    group: "app-repo",
    label: "List Application Files",
    summary: "See the file tree of the linked application repository.",
    description:
      "List file paths in the linked application repository. Start here to work out what the application is — its language, framework, containerisation and data stores are usually visible from the file names alone. Pass `path` to list one subtree instead of the whole repository, which is how to get past the entry limit on a large codebase. Dependency directories such as `node_modules` and build output are not listed.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Repository-relative directory to list, e.g. `services/api`. Omit for the repository root.",
        },
      },
      required: [],
    },
  },
  {
    name: "read_app_file",
    group: "app-repo",
    label: "Read Application File",
    summary: "Read one file from the linked application repository.",
    description:
      "Read a single file from the linked application repository. Use it on the files that state what the application needs at runtime — Dockerfile, docker-compose.yml, package.json, pyproject.toml, go.mod, pom.xml, .env.example, Helm values, CI workflows — and on the code that reveals ports, queues, buckets and databases. Long files are truncated. Call `list_app_files` first rather than guessing paths.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Repository-relative file path, e.g. `Dockerfile`.",
        },
      },
      required: ["path"],
    },
  },
] as const;

export type ProjectAgentToolName = (typeof PROJECT_AGENT_TOOLS)[number]["name"];

export function isKnownTool(name: string): name is ProjectAgentToolName {
  return PROJECT_AGENT_TOOLS.some((tool) => tool.name === name);
}
