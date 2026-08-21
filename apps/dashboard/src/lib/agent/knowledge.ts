/**
 * What the project agent is allowed to know.
 *
 * Each source gates a block of context in the system prompt, and in two cases
 * the tools that act on it. Switching one off does not politely ask the model to
 * ignore something — the data never reaches the session, so the agent genuinely
 * cannot use it. That distinction is the whole point: a switch that only changed
 * the prompt would be a suggestion, and a model under pressure ignores
 * suggestions.
 *
 * Every source is on unless a user turns it off, which is why the stored shape is
 * a deny list. See `AgentSettings.disabledKnowledge`.
 *
 * No `server-only`: this is a catalogue of ids and labels with no secrets and no
 * database access, and the settings UI needs the same list the agent uses.
 */

/** The modules a project may instantiate. Without it, nothing can be added. */
export const KNOWLEDGE_MODULE_LIBRARY = "module-library";

/** The Terraform already in the repository: modules, wiring, unset inputs. */
export const KNOWLEDGE_PROJECT_REPO = "project-repo";

/**
 * The application the infrastructure is for, read from its own repository.
 *
 * Only ever available when a project has actually been linked to one. Switching
 * it off withholds the read tools as well, which is the whole source: unlike the
 * other two, none of this arrives as prompt text — the agent has to go and look.
 */
export const KNOWLEDGE_APP_REPO = "app-repo";

export interface KnowledgeSource {
  /** Stable identifier, stored per user. Renaming one silently re-enables it. */
  id: string;
  name: string;
  /** Shown in settings, so it has to say what is lost by switching this off. */
  description: string;
}

export const AGENT_KNOWLEDGE: KnowledgeSource[] = [
  {
    id: KNOWLEDGE_MODULE_LIBRARY,
    name: "Module library",
    description:
      "The modules available to place on the canvas. Without it the agent cannot add modules at all.",
  },
  {
    id: KNOWLEDGE_PROJECT_REPO,
    name: "Project repository",
    description:
      "The Terraform already in the repository. Without it the agent cannot see, wire or change what exists.",
  },
  {
    id: KNOWLEDGE_APP_REPO,
    name: "Application repository",
    description:
      "The linked application's own repository, which the agent may read to see how the application is built. Read-only, and only when a project has one linked.",
  },
];

export function isKnownKnowledge(id: string): boolean {
  return AGENT_KNOWLEDGE.some((source) => source.id === id);
}

/**
 * Whether a source is available, given the user's deny list.
 *
 * Takes the deny list rather than a set of enabled ids so that call sites read
 * the way the storage works, and an unrecognised id in the column cannot
 * accidentally switch something off.
 */
export function knowledgeEnabled(
  disabled: string[] | undefined,
  id: string,
): boolean {
  return !(disabled ?? []).includes(id);
}
