import type { ProjectAgentToolName } from "@terrablox/agent-harness/tool-catalogue";

/**
 * The names the MCP endpoint shares with the harness's own tool catalogue.
 *
 * One vocabulary on purpose: the same project is edited by our agent inside the harness and
 * by a foreign agent through the endpoint, and two sets of verbs for one set of operations
 * is how a transcript stops being readable. `satisfies` is what enforces it — rename a tool
 * in `@terrablox/agent-harness/tool-catalogue` and this stops compiling, which is the only
 * moment anyone would otherwise notice. Verified by renaming `connect` and watching it fail.
 *
 * In its own module rather than beside the server, because a list of names should not need
 * a database to read: importing the server pulls in Prisma and the auth chain, and a test
 * of this constant then fails for want of `BETTER_AUTH_SECRET`.
 *
 * The *schemas* are deliberately not shared, and this is the place to say why. The harness
 * declares raw JSON Schema because that is what the function-calling API takes; the
 * endpoint declares zod because that is what the MCP SDK takes. More importantly the
 * parameters genuinely differ: every tool there carries a `projectId`, because a caller
 * from outside has to say which project it means, while the harness knows that from the
 * turn. Sharing them would mean one declaration, a transform in each direction, and an
 * injected field — machinery to deduplicate objects with five keys.
 *
 * The descriptions are separate for a third reason: a foreign agent arrives without our
 * operating rules in its context, so a description written for the harness would be
 * addressed to a reader that is not there.
 */
export const SHARED_VOCABULARY = [
  "describe_module",
  "add_module",
  "remove_module",
  "connect",
  "disconnect",
  "auto_connect",
  "add_local",
  "remove_local",
  "connect_local",
  "record_decision",
] as const satisfies readonly ProjectAgentToolName[];
