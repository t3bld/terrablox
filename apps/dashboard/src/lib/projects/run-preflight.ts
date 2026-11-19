import type { Project } from "@terrablox/database";
import {
  describeAwsValueProblems,
  findAwsValueProblems,
} from "./aws-value-guard";
import { readProjectFiles } from "./service";
import type { WorkflowTemplate } from "./workflow-templates";

/**
 * Why a run should not start, or null when it may.
 *
 * Reads the configuration on the branch the run will check out and looks for
 * values AWS would reject part-way through an apply. Edits made in Terrablox
 * are already refused on commit; this catches the ones pushed to the
 * repository directly.
 *
 * Only before an apply: a plan cannot hit these, and a destroy has to stay
 * possible whatever the configuration says. Best-effort, so a read failure
 * never blocks a deploy. Shared by the Deploy tab's route and the MCP tool, so
 * neither way in can skip it.
 */
export async function runPreflightRefusal(
  token: string,
  project: Project,
  template: WorkflowTemplate,
): Promise<string | null> {
  if (!template.changesInfrastructure || template.destroysInfrastructure) {
    return null;
  }

  try {
    const { files } = await readProjectFiles(token, project);
    const problems = await findAwsValueProblems(files);
    if (problems.length === 0) return null;

    return `${template.name} was not started, because AWS would reject ${
      problems.length === 1 ? "a value" : `${problems.length} values`
    } part-way through and leave the deployment half done. ${describeAwsValueProblems(problems)}`;
  } catch {
    return null;
  }
}
