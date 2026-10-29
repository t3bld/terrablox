/**
 * The deployment workflows Terrablox ships, as a catalogue rather than as code.
 *
 * These used to be four render functions called in a fixed order, which made
 * every choice a code change: the Terraform version, whether an apply waits for
 * an approval, whether anything runs on a schedule. A project that wanted none
 * of the cost tooling still got its workflow committed.
 *
 * So the shape is a catalogue the wizard can show and a small configuration the
 * project owns. The renderers stay pure functions of `(context, config)` — the
 * files still end up in Git, readable and reviewable, and a project stays
 * deployable if Terrablox disappears.
 */

import {
  AWS_REGION_VARIABLE,
  AWS_ROLE_VARIABLE,
  DEFAULT_TERRAFORM_VERSION,
  type PipelineContext,
  WORKFLOW_DIR,
  workingDirectory,
} from "./deploy";

export type TemplateId = "plan" | "apply";

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
}

/** The config with every question answered, which is what renderers want. */
export interface ResolvedTemplateConfig {
  disabled: TemplateId[];
  terraformVersion: string;
}

export const TEMPLATE_DEFAULTS: ResolvedTemplateConfig = {
  disabled: [],
  terraformVersion: DEFAULT_TERRAFORM_VERSION,
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

const GENERATED_HEADER = `# Managed by Terrablox. Edits are kept, but regenerating the pipeline
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

/**
 * One git authentication step per private module library the project uses.
 *
 * The job's GITHUB_TOKEN can only read this repository, so `terraform init`
 * cannot clone modules from another organisation's private repositories. A
 * user-created repository secret holds a token that can; Terrablox never sees
 * or writes it.
 *
 * Scoped as `http.https://github.com/<org>/.extraheader` rather than a global
 * `url.insteadOf`: `actions/checkout` persists the job token as the host-wide
 * extraheader, and git applies the most specific `http.<url>` match, so the
 * org-scoped header wins for that org and reaches no other URL.
 *
 * Fails fast with a readable message when the secret is missing — the step is
 * only rendered for projects that need it, and a 404 inside `terraform init`
 * says nothing about why.
 */
function privateModulesSteps(context: PipelineContext): string {
  return (context.privateModules ?? [])
    .map(
      (
        library,
      ) => `      # Modules in ${library.org} are private, and this job's GITHUB_TOKEN can only
      # read this repository. The header is scoped to that organisation's URLs, so
      # no other clone sees the token.
      - name: Authenticate Git for ${library.libraryName} modules
        env:
          MODULES_TOKEN: \${{ secrets.${library.secretName} }}
        run: |
          if [ -z "$MODULES_TOKEN" ]; then
            echo "::error::Add the repository secret ${library.secretName}: a token that can read the module repositories in ${library.org}. terraform init cannot fetch them without it."
            exit 1
          fi
          header="$(printf 'x-access-token:%s' "$MODULES_TOKEN" | base64 -w0)"
          echo "::add-mask::$header"
          git config --global "http.https://github.com/${library.org}/.extraheader" "AUTHORIZATION: basic $header"`,
    )
    .join("\n\n");
}

/** The init step, preceded by any private module authentication. */
function terraformInit(context: PipelineContext): string {
  const steps = privateModulesSteps(context);
  return `${steps ? `${steps}\n\n` : ""}      - run: terraform init -input=false`;
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

${terraformInit(context)}

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

/**
 * The apply, with no GitHub environment on the job.
 *
 * An environment used to be rendered here, behind a "hold apply for an approval"
 * switch — it is the only GitHub mechanism that can pause a job for a human. The
 * switch is gone, so the job runs when someone starts it. Anyone who wants the
 * pause back adds `environment:` to this file and protects it in the repository's
 * settings; nothing else in the pipeline reads it.
 */
function renderApply(
  context: PipelineContext,
  config: ResolvedTemplateConfig,
): string {
  const dir = workingDirectory(context.rootFolder);

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
    defaults:
      run:
        working-directory: ${dir}
    steps:
      - uses: actions/checkout@v4

${awsCredentialsStep(context)}

${setupTerraform(config)}

${terraformInit(context)}

      # Validated before anything is created: a configuration error should stop
      # the run while it is still harmless, not half-way through an apply.
      - run: terraform validate

      - run: terraform apply -auto-approve -input=false
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
    // `requireApproval` and `scheduleRefresh` used to be read here. A project that
    // still has them in its stored JSON is not migrated: dropping a key that is no
    // longer asked about is what "absent means whatever the catalogue says" is for,
    // and the column keeps whatever it holds until the next write rewrites it.
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

/**
 * Files Terrablox generated in an earlier version and no longer offers.
 *
 * Ownership outlives the template. A `terraform-cost.yml` committed while pricing
 * was still part of the pipeline is sitting in those repositories now, and it runs
 * on `workflow_run` after every apply — so forgetting it would not remove it, it
 * would only stop anyone from seeing it. Listed here, the next pipeline write
 * deletes it, because {@link allTemplatePaths} is what that diff is taken against.
 */
const RETIRED_TEMPLATE_PATHS = [`${WORKFLOW_DIR}/terraform-cost.yml`];

/** Paths Terrablox owns: the current templates, the ones a project turned off, and
 * the ones it used to write at all. */
export function allTemplatePaths(): string[] {
  return [
    ...WORKFLOW_TEMPLATES.map((template) => template.path),
    ...RETIRED_TEMPLATE_PATHS,
  ];
}
