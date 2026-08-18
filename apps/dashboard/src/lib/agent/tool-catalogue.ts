/**
 * What the project agent can do, declared once.
 *
 * Separate from the agent itself so that settings and API routes can name and
 * gate tools without importing the Copilot SDK — and so the agent can validate
 * a deny list without depending on the settings store that produced it.
 */

/** Tool definitions, in the shape function-calling APIs expect. */
export const PROJECT_AGENT_TOOLS = [
  {
    name: "add_module",
    label: "Add module",
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
    label: "Remove module",
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
    label: "Connect",
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
    label: "Disconnect",
    summary: "Remove a wire between two modules.",
    description: "Remove an argument from a module block.",
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
    name: "rename_module",
    label: "Rename module",
    summary: "Rename a module and update everything pointing at it.",
    description: "Rename a module block and update every reference to it.",
    parameters: {
      type: "object",
      properties: { name: { type: "string" }, newName: { type: "string" } },
      required: ["name", "newName"],
    },
  },
] as const;

export type ProjectAgentToolName = (typeof PROJECT_AGENT_TOOLS)[number]["name"];

export function isKnownTool(name: string): name is ProjectAgentToolName {
  return PROJECT_AGENT_TOOLS.some((tool) => tool.name === name);
}
