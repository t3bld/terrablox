/**
 * The deployment workflows TerraBlox ships, as a catalogue rather than as code.
 *
 * These used to be four render functions called in a fixed order, which made
 * every choice a code change: the Terraform version, whether an apply waits for
 * an approval, whether anything runs on a schedule. A project that wanted none
 * of the cost tooling still got its workflow committed.
 *
 * So the shape is a catalogue the wizard can show and a small configuration the
 * project owns. The renderers stay pure functions of `(context, config)` — the
 * files still end up in Git, readable and reviewable, and a project stays
 * deployable if TerraBlox disappears.
 */

import {
  AWS_REGION_VARIABLE,
  AWS_ROLE_VARIABLE,
  COST_SNAPSHOT_PATH,
  DEFAULT_TERRAFORM_VERSION,
  INFRACOST_API_KEY_SECRET,
  type PipelineContext,
  WORKFLOW_DIR,
  workingDirectory,
} from "./deploy";

export type TemplateId = "plan" | "apply" | "cost";

/**
 * What a project decides about its workflows.
 *
 * Every field is optional: absent means "whatever the catalogue says", which is
 * what lets a default change reach projects that never configured it.
 */
export interface TemplateConfig {
  /** Template ids the project has turned off. Required ones are ignored here. */
  disabled?: TemplateId[];
  terraformVersion?: string;
  /** Apply runs in a GitHub environment, so it can be held for an approval. */
  requireApproval?: boolean;
  /** Cost estimates also refresh on a schedule, not only when asked. */
  scheduleRefresh?: boolean;
}

/** The config with every question answered, which is what renderers want. */
export interface ResolvedTemplateConfig {
  disabled: TemplateId[];
  terraformVersion: string;
  requireApproval: boolean;
  scheduleRefresh: boolean;
}

export const TEMPLATE_DEFAULTS: ResolvedTemplateConfig = {
  disabled: [],
  terraformVersion: DEFAULT_TERRAFORM_VERSION,
  // On by default: an apply with administrator permissions is exactly the thing
  // worth a second pair of eyes, and the environment is free to leave unguarded.
  requireApproval: true,
  scheduleRefresh: false,
};

export interface WorkflowTemplate {
  id: TemplateId;
  /** Where the file lands in the repository. */
  path: string;
  /** The `name:` inside the YAML, which is also what Actions displays. */
  name: string;
  summary: string;
  /**
   * Required templates cannot be turned off: without a plan and an apply there
   * is no deployment, and the tab would be offering buttons that do nothing.
   */
  required: boolean;
  /** Why a template might not be usable yet, e.g. a missing repository secret. */
  requires: string | null;
  render: (context: PipelineContext, config: ResolvedTemplateConfig) => string;
}

const GENERATED_HEADER = `# Managed by TerraBlox. Edits are kept, but regenerating the pipeline
# overwrites this file.`;

/**
 * The step every workflow starts with: federating into AWS.
 *
 * The role and region come from repository variables, so moving a project to
 * another account is a settings change rather than a commit. The rendered value
 * stays as a fallback for a repository where the variable was never written —
 * writing it needs a GitHub permission the installation may not have, and a
 * pipeline that broke for that reason would be hard to read from the logs.
 */
function awsCredentialsStep(context: PipelineContext): string {
  const role = context.awsRoleArn ?? "";

  return `      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: \${{ vars.${AWS_ROLE_VARIABLE} || '${role}' }}
          aws-region: \${{ vars.${AWS_REGION_VARIABLE} || '${context.awsRegion}' }}`;
}

function setupTerraform(
  config: ResolvedTemplateConfig,
  wrapper = true,
): string {
  return `      - uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: ${config.terraformVersion}${
            wrapper
              ? ""
              : `
          # The wrapper prefixes the output with its own logging, which would
          # end up in the JSON.
          terraform_wrapper: false`
          }`;
}

function renderPlan(
  context: PipelineContext,
  config: ResolvedTemplateConfig,
): string {
  const dir = workingDirectory(context.rootFolder);

  return `${GENERATED_HEADER}
name: Terraform Plan

# Started by hand only. Nothing here reacts to a push or a pull request, so
# reaching into AWS is always someone's decision rather than a side effect of
# committing.
on:
  workflow_dispatch:

# id-token is what lets the job exchange a GitHub token for AWS credentials.
permissions:
  contents: read
  id-token: write

jobs:
  plan:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: ${dir}
    steps:
      - uses: actions/checkout@v4

${awsCredentialsStep(context)}

${setupTerraform(config)}

      - run: terraform fmt -check -recursive

      - run: terraform init -input=false

      - run: terraform validate

      - name: Terraform plan
        id: plan
        run: terraform plan -no-color -input=false -out=tfplan

      # The run summary is where a manually started plan can be read at all:
      # there is no pull request to comment on.
      - name: Publish the plan
        if: always() && steps.plan.conclusion != 'skipped'
        env:
          PLAN: \${{ steps.plan.outputs.stdout }}
        run: |
          {
            echo '### Terraform plan'
            echo ''
            echo '\`\`\`terraform'
            printf '%s\\n' "\${PLAN:0:60000}"
            echo '\`\`\`'
          } >> "$GITHUB_STEP_SUMMARY"
`;
}

function renderApply(
  context: PipelineContext,
  config: ResolvedTemplateConfig,
): string {
  const dir = workingDirectory(context.rootFolder);

  // An environment is the only GitHub mechanism that can hold a job for a
  // human, so "require approval" and "use an environment" are the same switch.
  const environment = config.requireApproval
    ? `    # Protect this environment in GitHub to require a manual approval before
    # anything is changed in AWS.
    environment: production
`
    : "";

  return `${GENERATED_HEADER}
name: Terraform Apply

# Started by hand only. An apply changes real infrastructure, so it never
# follows a push — not even one to ${context.branch}.
on:
  workflow_dispatch:

permissions:
  contents: read
  id-token: write

# Two applies against the same state at once would fight over the lock, so runs
# queue instead of cancelling each other.
concurrency:
  group: terraform-apply-${context.branch}
  cancel-in-progress: false

jobs:
  apply:
    runs-on: ubuntu-latest
${environment}    defaults:
      run:
        working-directory: ${dir}
    steps:
      - uses: actions/checkout@v4

${awsCredentialsStep(context)}

${setupTerraform(config)}

      - run: terraform init -input=false

      # Validated before anything is created: a configuration error should stop
      # the run while it is still harmless, not half-way through an apply.
      - run: terraform validate

      - run: terraform apply -auto-approve -input=false
`;
}

/**
 * Prices the plan and publishes the result into the repository.
 *
 * Infracost is given a plan rather than the sources, which is the whole point:
 * every variable is resolved, `count` has a number, and an instance has a real
 * size. What it still cannot know is traffic, so usage-driven components come
 * back without a figure and are reported as such instead of being quietly
 * counted as zero.
 */
function renderCost(
  context: PipelineContext,
  config: ResolvedTemplateConfig,
): string {
  const dir = workingDirectory(context.rootFolder);

  const schedule = config.scheduleRefresh
    ? `
  # AWS prices move without the code moving.
  schedule:
    - cron: "0 7 1 * *"`
    : "";

  return `${GENERATED_HEADER}
name: Terraform Cost

on:
  # After an apply so the estimate follows what was actually deployed.
  workflow_run:
    workflows: ["Terraform Apply"]
    types: [completed]${schedule}
  workflow_dispatch:

permissions:
  contents: write
  id-token: write

concurrency:
  group: terrablox-cost
  cancel-in-progress: true

jobs:
  estimate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${context.branch}

      - name: Check for the Infracost API key
        run: |
          if [ -z "\${{ secrets.${INFRACOST_API_KEY_SECRET} }}" ]; then
            echo "::error::${INFRACOST_API_KEY_SECRET} is not set. Add it as a repository secret; a free key is available at infracost.io."
            exit 1
          fi

${awsCredentialsStep(context)}

${setupTerraform(config, false)}

      - uses: infracost/actions/setup@v3
        with:
          api-key: \${{ secrets.${INFRACOST_API_KEY_SECRET} }}

      - name: Price the plan
        working-directory: ${dir}
        run: |
          terraform init -input=false
          terraform plan -input=false -out=tfplan
          terraform show -json tfplan > "$RUNNER_TEMP/plan.json"
          infracost breakdown \\
            --path "$RUNNER_TEMP/plan.json" \\
            --format json \\
            --out-file "$RUNNER_TEMP/infracost.json"

      - name: Summarise the estimate
        run: |
          mkdir -p .terrablox
          jq '{
            version: 1,
            generatedAt: (now | todate),
            currency: (.currency // "USD"),
            totalMonthlyCost: (.totalMonthlyCost // null),
            resources: [
              .projects[]?.breakdown.resources[]? | {
                address: .name,
                name: .name,
                monthlyCost: (.monthlyCost // null)
              }
            ]
          }' "$RUNNER_TEMP/infracost.json" > ${COST_SNAPSHOT_PATH}

      - name: Publish the estimate
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add ${COST_SNAPSHOT_PATH}
          git diff --cached --quiet && exit 0
          git commit -m "chore(terrablox): update cost estimate [skip ci]"
          git pull --rebase --autostash origin ${context.branch}
          git push origin HEAD:${context.branch}
`;
}

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: "plan",
    path: `${WORKFLOW_DIR}/terraform-plan.yml`,
    name: "Terraform Plan",
    summary:
      "Formats, validates and plans, then puts the diff in the run summary. Changes nothing in AWS.",
    required: true,
    requires: null,
    render: renderPlan,
  },
  {
    id: "apply",
    path: `${WORKFLOW_DIR}/terraform-apply.yml`,
    name: "Terraform Apply",
    summary:
      "Validates and then applies. Queued rather than parallel, so two runs cannot fight over the state lock.",
    required: true,
    requires: null,
    render: renderApply,
  },
  {
    id: "cost",
    path: `${WORKFLOW_DIR}/terraform-cost.yml`,
    name: "Terraform Cost",
    summary:
      "Prices a real plan with Infracost and commits the estimate for the Costs tab.",
    required: false,
    requires: `the ${INFRACOST_API_KEY_SECRET} repository secret`,
    render: renderCost,
  },
];

export function findTemplate(id: TemplateId): WorkflowTemplate | undefined {
  return WORKFLOW_TEMPLATES.find((template) => template.id === id);
}

const TEMPLATE_IDS = new Set<string>(
  WORKFLOW_TEMPLATES.map((template) => template.id),
);

function isTemplateId(value: unknown): value is TemplateId {
  return typeof value === "string" && TEMPLATE_IDS.has(value);
}

/**
 * Reads the stored configuration, keeping nothing it does not recognise.
 *
 * The column is plain JSON that an older or newer build may have written, so an
 * unknown template id has to disappear rather than reach a renderer. Required
 * templates are filtered out of `disabled` here, which means the invariant holds
 * no matter what is in the database.
 */
export function resolveTemplateConfig(raw: unknown): ResolvedTemplateConfig {
  if (!raw || typeof raw !== "object") return { ...TEMPLATE_DEFAULTS };
  const record = raw as Record<string, unknown>;

  const disabled = Array.isArray(record.disabled)
    ? record.disabled.filter(isTemplateId).filter((id) => {
        const template = findTemplate(id);
        return template ? !template.required : false;
      })
    : TEMPLATE_DEFAULTS.disabled;

  return {
    disabled,
    terraformVersion:
      typeof record.terraformVersion === "string" &&
      /^\d+\.\d+\.\d+$/.test(record.terraformVersion)
        ? record.terraformVersion
        : TEMPLATE_DEFAULTS.terraformVersion,
    requireApproval:
      typeof record.requireApproval === "boolean"
        ? record.requireApproval
        : TEMPLATE_DEFAULTS.requireApproval,
    scheduleRefresh:
      typeof record.scheduleRefresh === "boolean"
        ? record.scheduleRefresh
        : TEMPLATE_DEFAULTS.scheduleRefresh,
  };
}

/** The templates this project actually wants, in catalogue order. */
export function activeTemplates(
  config: ResolvedTemplateConfig,
): WorkflowTemplate[] {
  return WORKFLOW_TEMPLATES.filter(
    (template) => template.required || !config.disabled.includes(template.id),
  );
}

/** Paths TerraBlox owns, including the ones a project has turned off. */
export function allTemplatePaths(): string[] {
  return WORKFLOW_TEMPLATES.map((template) => template.path);
}
