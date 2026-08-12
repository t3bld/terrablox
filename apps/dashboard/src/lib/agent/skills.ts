import "server-only";

/**
 * The skills TerraBlox ships.
 *
 * Content lives in code rather than in the database on purpose: a skill is a
 * piece of our product, so improving one should improve it for every user in
 * the next deploy, not require a data migration. Users choose which apply to
 * them; they do not author the text, which also means no user-supplied
 * instructions ever reach another user's agent.
 *
 * These are injected into the system prompt rather than loaded through the
 * SDK's `skillDirectories`. That option reads directories on the runtime host,
 * and the agent deliberately runs with no filesystem access at all — keeping
 * the text in the prompt avoids reopening that door for a handful of
 * paragraphs we already control.
 */

export interface AgentSkill {
  /** Stable identifier, stored per user. Renaming one silently disables it. */
  id: string;
  name: string;
  /** Shown in settings so a user can tell whether it applies to them. */
  description: string;
  /** Injected verbatim when enabled. */
  content: string;
}

export const AGENT_SKILLS: AgentSkill[] = [
  {
    id: "terraform-conventions",
    name: "Terraform conventions",
    description:
      "Naming, tagging and file layout rules applied when adding or renaming modules.",
    content: [
      "## Terraform conventions",
      "",
      "- Module instance names are lowercase, hyphen-separated, and describe the role rather than the resource type: `payments-api`, not `ecs-service-1`.",
      "- Prefer an existing module from the library over introducing a new source.",
      "- Keep one concern per module instance; if a name needs an 'and', it is two modules.",
    ].join("\n"),
  },
  {
    id: "aws-landing-zone",
    name: "AWS landing zone",
    description:
      "Assume the standard account layout: shared VPC, private subnets, no public databases.",
    content: [
      "## AWS landing zone",
      "",
      "- Workloads run in private subnets. Never place a database or cache in a public subnet.",
      "- Ingress arrives through a load balancer; do not attach public IPs to compute.",
      "- Networking comes from the shared VPC module rather than being defined per service.",
    ].join("\n"),
  },
  {
    id: "least-privilege",
    name: "Least privilege",
    description:
      "Prefer narrow IAM and security group rules when wiring modules together.",
    content: [
      "## Least privilege",
      "",
      "- Connect two modules with the narrowest rule that makes the connection work.",
      "- Do not widen an existing rule to solve a new problem; add a specific one.",
      "- Call out in your reply whenever a change broadens access, and say why it was needed.",
    ].join("\n"),
  },
];

/** Skill ids that still exist, so a stored selection cannot resurrect a removed one. */
export function resolveSkills(ids: string[]): AgentSkill[] {
  return AGENT_SKILLS.filter((skill) => ids.includes(skill.id));
}

export function isKnownSkill(id: string): boolean {
  return AGENT_SKILLS.some((skill) => skill.id === id);
}
