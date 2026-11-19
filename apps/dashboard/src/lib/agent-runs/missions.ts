/**
 * The missions Agent mode offers.
 *
 * A fixed catalogue rather than a free-text prompt: each entry is a mission the
 * harness is written for, so a run always starts from a brief that has been
 * thought through. The server only accepts an id from this list and builds the
 * mission text itself.
 */

export type AgentMissionId =
  | "migrate-app"
  | "mvp-prototype"
  | "architecture-from-documents"
  | "review-harden";

/** A source the mission cannot work without. */
export type AgentMissionRequirement = "appRepo" | "documents";

export interface AgentMission {
  id: AgentMissionId;
  title: string;
  /** One sentence for the card. */
  summary: string;
  /** What the agent is told. */
  mission: string;
  requires: AgentMissionRequirement | null;
}

export const AGENT_MISSIONS: readonly AgentMission[] = [
  {
    id: "migrate-app",
    title: "Migrate the linked application",
    summary:
      "Works out what the application needs at runtime and builds a production-ready AWS architecture for it.",
    mission:
      "Migrate the linked application to AWS. Work out from its repository what it needs at runtime (compute, data stores, queues, secrets, networking) and build a production-ready target architecture for it, using managed services where they fit.",
    requires: "appRepo",
  },
  {
    id: "mvp-prototype",
    title: "Low-cost prototype of the linked application",
    summary:
      "The cheapest setup that runs the application for a handful of test users. No scaling, no high availability.",
    mission: [
      "Build a minimal, low-cost prototype environment for the linked application, so it can be tried out cheaply before a full migration. It only has to serve a handful of test users.",
      "Work out from the repository what the application needs at runtime, and give it exactly that, at the smallest size that works:",
      "- One environment, one region, one availability zone. No high availability, no autoscaling, no multi-AZ databases, no read replicas.",
      "- Prefer options that cost little or nothing when idle: serverless or scale-to-zero compute and databases where the application allows it, otherwise the smallest instance sizes (Graviton where possible).",
      "- Keep the network minimal and avoid fixed hourly costs such as NAT gateways, load balancers or interface endpoints unless the application cannot run without them.",
      "- Keep the basics that are cheap and hard to add later: encryption at rest, secrets in a secrets store rather than in code, and nothing reachable from the internet that does not need to be.",
      "Record each cost-driven shortcut as a decision, with what would have to change for production. Finish with a short list of those changes, so the prototype can later grow into a proper migration.",
    ].join("\n"),
    requires: "appRepo",
  },
  {
    id: "architecture-from-documents",
    title: "Architecture from documents",
    summary:
      "Extracts the requirements from the uploaded documents and designs an architecture that meets them.",
    mission:
      "Read the uploaded project documents, extract the functional and non-functional requirements, and design and build a target architecture that meets them. Record every significant decision with the alternatives you rejected.",
    requires: "documents",
  },
  {
    id: "review-harden",
    title: "Review and harden",
    summary:
      "Finds gaps in security, availability and cost in the current setup and fixes them.",
    mission:
      "Review the current infrastructure in this project for gaps in security, availability and cost, and fix what you find. Explain each change and anything you deliberately left as it is.",
    requires: null,
  },
];

export function findMission(id: string): AgentMission | null {
  return AGENT_MISSIONS.find((entry) => entry.id === id) ?? null;
}

/** The catalogue title for a stored mission text, for runs started from it. */
export function missionTitle(mission: string): string {
  const known = AGENT_MISSIONS.find((entry) => entry.mission === mission);
  if (known) return known.title;
  const firstLine = mission.split("\n")[0]?.trim() ?? "";
  return firstLine.length > 80
    ? `${firstLine.slice(0, 77).trimEnd()}…`
    : firstLine;
}

/** Why a mission cannot start on this project, or null when it can. */
export function missionUnavailable(
  mission: AgentMission,
  sources: { appRepoFullName: string | null; documentCount: number },
): string | null {
  if (mission.requires === "appRepo" && !sources.appRepoFullName) {
    return "Link an application repository to the project first.";
  }
  if (mission.requires === "documents" && sources.documentCount === 0) {
    return "Upload at least one document to the project first.";
  }
  return null;
}
