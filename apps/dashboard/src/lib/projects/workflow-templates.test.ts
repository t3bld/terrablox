import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { PipelineContext } from "./deploy";
import {
  activeTemplates,
  DESTROY_CONFIRM_INPUT,
  dispatchInputs,
  findTemplate,
  resolveTemplateConfig,
  runConfirmed,
  TEMPLATE_DEFAULTS,
  type WorkflowTemplate,
} from "./workflow-templates";

const context: PipelineContext = {
  repoFullName: "porsche-code/terrablox-test",
  branch: "main",
  rootFolder: "infra",
  projectName: "terrablox-test",
  awsAccountId: "827063196867",
  awsRegion: "eu-central-1",
  awsRoleArn: "arn:aws:iam::827063196867:role/terrablox-test-deploy",
  stateBucket: "terrablox-test-tfstate-827063196867-p5snzd",
  stateKmsKeyArn: "arn:aws:kms:eu-central-1:827063196867:key/k",
};

function template(id: "plan" | "apply" | "destroy"): WorkflowTemplate {
  const found = findTemplate(id);
  if (!found) throw new Error(`no ${id} template`);
  return found;
}

describe("the destroy workflow", () => {
  const destroy = template("destroy");
  const yaml = destroy.render(context, TEMPLATE_DEFAULTS);

  it("is required, so every setup commits it", () => {
    expect(destroy.required).toBe(true);
    expect(destroy.destroysInfrastructure).toBe(true);
    expect(activeTemplates(TEMPLATE_DEFAULTS).map((t) => t.id)).toContain(
      "destroy",
    );
  });

  it("cannot be turned off by stored configuration", () => {
    const config = resolveTemplateConfig({ disabled: ["destroy"] });
    expect(config.disabled).not.toContain("destroy");
    expect(activeTemplates(config).map((t) => t.id)).toContain("destroy");
  });

  it("is valid YAML with the shape GitHub Actions expects", () => {
    const doc = parse(yaml);
    expect(
      doc.on.workflow_dispatch.inputs[DESTROY_CONFIRM_INPUT],
    ).toMatchObject({ required: true, type: "string" });
    expect(Object.keys(doc.on)).toEqual(["workflow_dispatch"]);
    const steps: { name?: string; uses?: string; run?: string }[] =
      doc.jobs.destroy.steps;
    expect(steps[0]?.name).toBe("Check the confirmation");
    expect(steps.at(-1)?.run?.trim()).toBe(
      "terraform apply -input=false destroy.tfplan",
    );
  });

  it("starts by hand only, with a required confirmation input", () => {
    expect(yaml).toContain("workflow_dispatch:");
    expect(yaml).toContain(`${DESTROY_CONFIRM_INPUT}:`);
    expect(yaml).toContain("required: true");
    expect(yaml).not.toMatch(/^\s+push:/m);
    expect(yaml).not.toMatch(/^\s+pull_request:/m);
  });

  it("checks the confirmation before it can reach AWS", () => {
    const guard = yaml.indexOf("Check the confirmation");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(yaml.indexOf("actions/checkout"));
    expect(guard).toBeLessThan(yaml.indexOf("configure-aws-credentials"));
    // Through env, never interpolated into the script.
    expect(yaml).toContain(`CONFIRM: \${{ inputs.${DESTROY_CONFIRM_INPUT} }}`);
    expect(yaml).toContain('if [ "$CONFIRM" != "$EXPECTED" ]');
    const repoName = "github.event.repository.name";
    expect(yaml).toContain(`EXPECTED: \${{ ${repoName} }}`);
  });

  it("applies exactly the destroy plan it published", () => {
    const plan = yaml.indexOf("terraform plan -destroy");
    const apply = yaml.indexOf("terraform apply -input=false destroy.tfplan");
    expect(plan).toBeGreaterThan(-1);
    expect(apply).toBeGreaterThan(plan);
    expect(yaml).toContain("GITHUB_STEP_SUMMARY");
    expect(yaml).not.toContain("-auto-approve");
  });

  it("queues behind an apply instead of racing it for the state lock", () => {
    const applyYaml = template("apply").render(context, TEMPLATE_DEFAULTS);
    const group = (text: string) => text.match(/group: (.+)/)?.[1];
    expect(group(yaml)).toBe("terraform-apply-main");
    expect(group(yaml)).toBe(group(applyYaml));
    expect(yaml).toContain("cancel-in-progress: false");
  });

  it("runs in the configuration's folder and federates like the others", () => {
    expect(yaml).toContain("working-directory: infra");
    expect(yaml).toContain("id-token: write");
    expect(yaml).toContain("aws-actions/configure-aws-credentials@v4");
  });
});

describe("confirming a run", () => {
  it("needs the project's exact name for a destroy only", () => {
    const destroy = template("destroy");
    expect(runConfirmed(destroy, "terrablox-test", "terrablox-test")).toBe(
      true,
    );
    expect(runConfirmed(destroy, "terrablox-test", "Terrablox-Test")).toBe(
      false,
    );
    expect(runConfirmed(destroy, "terrablox-test", undefined)).toBe(false);
    expect(runConfirmed(template("apply"), "terrablox-test", undefined)).toBe(
      true,
    );
  });

  it("passes the repository's name to the destroy, and nothing to the rest", () => {
    expect(
      dispatchInputs(template("destroy"), "porsche-code/terrablox-test"),
    ).toEqual({ [DESTROY_CONFIRM_INPUT]: "terrablox-test" });
    expect(
      dispatchInputs(template("plan"), "porsche-code/terrablox-test"),
    ).toBeUndefined();
  });
});
