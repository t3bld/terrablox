/**
 * The files a project needs before `terraform apply` can run in CI.
 *
 * Everything here is rendered from the project's own settings and committed to
 * the repository, so the pipeline stays readable and reviewable in Git rather
 * than living in this app's database. Nothing secret is written: the workflow
 * assumes an IAM role through GitHub's OIDC provider, which means there are no
 * long-lived AWS keys to store, rotate or leak.
 */

export const WORKFLOW_DIR = ".github/workflows";
export const PLAN_WORKFLOW_PATH = `${WORKFLOW_DIR}/terraform-plan.yml`;
export const APPLY_WORKFLOW_PATH = `${WORKFLOW_DIR}/terraform-apply.yml`;
export const STATE_WORKFLOW_PATH = `${WORKFLOW_DIR}/terraform-state.yml`;
export const COST_WORKFLOW_PATH = `${WORKFLOW_DIR}/terraform-cost.yml`;
export const BACKEND_FILE = "backend.tf";

/**
 * Where the pipeline publishes its inventory of deployed resources.
 *
 * In the repository rather than in this app's database, because the pipeline is
 * the only thing holding AWS credentials. TerraBlox reads the inventory through
 * the same GitHub token it already uses for the code, which keeps the promise
 * that it never needs access to the account it deploys into.
 */
export const STATE_SNAPSHOT_PATH = ".terrablox/state.json";

/**
 * Where the pipeline publishes its cost estimate.
 *
 * Priced in the pipeline for the same reason the state is read there: the
 * estimate is only meaningful against a real `terraform plan`, and only the
 * pipeline can produce one. A plan resolves what the module view cannot —
 * variables, `count`, instance sizes — so the figures here are grounded in what
 * would actually be created rather than in assumptions.
 */
export const COST_SNAPSHOT_PATH = ".terrablox/cost.json";

/** The repository secret Infracost needs to price a plan. */
export const INFRACOST_API_KEY_SECRET = "INFRACOST_API_KEY";

export const DEFAULT_TERRAFORM_VERSION = "1.9.8";

/** The single audience and issuer GitHub Actions uses for AWS federation. */
export const GITHUB_OIDC_PROVIDER = "token.actions.githubusercontent.com";

export interface DeploySettings {
  awsAccountId: string | null;
  awsRegion: string;
  awsRoleArn: string | null;
  stateBucket: string | null;
  stateLockTable: string | null;
}

export interface PipelineContext extends DeploySettings {
  repoFullName: string;
  branch: string;
  /** Repository-relative folder holding the root configuration. */
  rootFolder: string;
  projectName: string;
  terraformVersion?: string;
}

/** `.` is where Terraform lives by default, but Actions wants a real path. */
function workingDirectory(rootFolder: string): string {
  const trimmed = rootFolder
    .trim()
    .replace(/^\.\/?/, "")
    .replace(/\/+$/, "");
  return trimmed === "" ? "." : trimmed;
}

function pathFilter(rootFolder: string): string {
  const dir = workingDirectory(rootFolder);
  return dir === "." ? "**.tf" : `${dir}/**`;
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project"
  );
}

/** Terraform state keys are paths; keep them free of anything that needs escaping. */
function stateKey(projectName: string): string {
  return `${slugify(projectName)}/terraform.tfstate`;
}

const GENERATED_HEADER = `# Managed by TerraBlox. Edits are kept, but regenerating the pipeline
# overwrites this file.`;

export function renderPlanWorkflow(context: PipelineContext): string {
  const dir = workingDirectory(context.rootFolder);
  const version = context.terraformVersion ?? DEFAULT_TERRAFORM_VERSION;

  return `${GENERATED_HEADER}
name: Terraform Plan

on:
  pull_request:
    paths:
      - "${pathFilter(context.rootFolder)}"
  workflow_dispatch:

# id-token is what lets the job exchange a GitHub token for AWS credentials.
permissions:
  contents: read
  id-token: write
  pull-requests: write

jobs:
  plan:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: ${dir}
    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${context.awsRoleArn ?? "<set the IAM role in TerraBlox>"}
          aws-region: ${context.awsRegion}

      - uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: ${version}

      - run: terraform fmt -check -recursive

      - run: terraform init -input=false

      - run: terraform validate

      - name: Terraform plan
        id: plan
        run: terraform plan -no-color -input=false -out=tfplan

      - name: Comment plan on the pull request
        if: github.event_name == 'pull_request'
        uses: actions/github-script@v7
        env:
          PLAN: \${{ steps.plan.outputs.stdout }}
        with:
          script: |
            const plan = (process.env.PLAN || '').slice(0, 60000);
            await github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: '### Terraform plan\\n\\n\`\`\`terraform\\n' + plan + '\\n\`\`\`',
            });
`;
}

export function renderApplyWorkflow(context: PipelineContext): string {
  const dir = workingDirectory(context.rootFolder);
  const version = context.terraformVersion ?? DEFAULT_TERRAFORM_VERSION;

  return `${GENERATED_HEADER}
name: Terraform Apply

on:
  push:
    branches:
      - ${context.branch}
    paths:
      - "${pathFilter(context.rootFolder)}"
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
    # Protect this environment in GitHub to require a manual approval before
    # anything is changed in AWS.
    environment: production
    defaults:
      run:
        working-directory: ${dir}
    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${context.awsRoleArn ?? "<set the IAM role in TerraBlox>"}
          aws-region: ${context.awsRegion}

      - uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: ${version}

      - run: terraform init -input=false

      - run: terraform apply -auto-approve -input=false
`;
}

/**
 * Publishes an inventory of what is actually deployed.
 *
 * Only identifiers are extracted — address, type, id, ARN — never attribute
 * values. Terraform state holds generated passwords and private keys in clear
 * text, so the summary is built from an allow-list: a resource type this filter
 * has never seen contributes its name and nothing else, rather than leaking
 * whatever it happens to store.
 */
export function renderStateWorkflow(context: PipelineContext): string {
  const dir = workingDirectory(context.rootFolder);
  const version = context.terraformVersion ?? DEFAULT_TERRAFORM_VERSION;

  return `${GENERATED_HEADER}
name: Terraform State

on:
  # After every apply so the inventory follows the account instead of lagging
  # behind it, and daily to pick up changes made outside Terraform.
  workflow_run:
    workflows: ["Terraform Apply"]
    types: [completed]
  schedule:
    - cron: "0 6 * * *"
  workflow_dispatch:

permissions:
  contents: write
  id-token: write

concurrency:
  group: terrablox-state
  cancel-in-progress: true

jobs:
  snapshot:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${context.branch}

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${context.awsRoleArn ?? "<set the IAM role in TerraBlox>"}
          aws-region: ${context.awsRegion}

      - uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: ${version}
          # The wrapper prefixes the output with its own logging, which would
          # end up in the JSON.
          terraform_wrapper: false

      - name: Read the remote state
        working-directory: ${dir}
        run: |
          terraform init -input=false
          terraform show -json > "$RUNNER_TEMP/state.json"

      - name: Summarise the state
        run: |
          mkdir -p .terrablox
          jq 'def modules: ., (.child_modules[]? | modules);
            {
              version: 1,
              generatedAt: (now | todate),
              terraformVersion: (.terraform_version // null),
              resources: [
                .values.root_module? | modules | .resources[]? | {
                  address: .address,
                  type: .type,
                  name: .name,
                  mode: .mode,
                  provider: .provider_name,
                  index: (.index // null),
                  id: (.values.id? // null),
                  arn: (.values.arn? // null)
                }
              ],
              outputs: [
                (.values.outputs? // {}) | to_entries[] | {
                  name: .key,
                  sensitive: (.value.sensitive // false),
                  value: (
                    if (.value.sensitive // false) then null
                    else ((.value.value | tostring)[0:200])
                    end
                  )
                }
              ]
            }' "$RUNNER_TEMP/state.json" > ${STATE_SNAPSHOT_PATH}

      - name: Publish the snapshot
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add ${STATE_SNAPSHOT_PATH}
          git diff --cached --quiet && exit 0
          git commit -m "chore(terrablox): update state snapshot [skip ci]"
          # The apply that triggered this run may have been overtaken by another
          # push, and a rejected push would silently lose the snapshot.
          git pull --rebase --autostash origin ${context.branch}
          git push origin HEAD:${context.branch}
`;
}

/**
 * Prices the plan and publishes the result beside the state snapshot.
 *
 * Infracost is given a plan rather than the sources, which is the whole point:
 * every variable is resolved, `count` has a number, and an instance has a real
 * size. What it still cannot know is traffic, so usage-driven components come
 * back without a figure and are reported as such instead of being quietly
 * counted as zero.
 *
 * Prices change without the code changing, so this also runs on a schedule.
 */
export function renderCostWorkflow(context: PipelineContext): string {
  const dir = workingDirectory(context.rootFolder);
  const version = context.terraformVersion ?? DEFAULT_TERRAFORM_VERSION;

  return `${GENERATED_HEADER}
name: Terraform Cost

on:
  # After an apply so the estimate follows what was actually deployed, and
  # monthly because AWS prices move on their own.
  workflow_run:
    workflows: ["Terraform Apply"]
    types: [completed]
  schedule:
    - cron: "0 7 1 * *"
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

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${context.awsRoleArn ?? "<set the IAM role in TerraBlox>"}
          aws-region: ${context.awsRegion}

      - uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: ${version}
          # The wrapper prefixes the output with its own logging, which would
          # end up in the JSON.
          terraform_wrapper: false

      - uses: infracost/actions/setup@v3
        with:
          api-key: \${{ secrets.${INFRACOST_API_KEY_SECRET} }}

      - name: Plan
        working-directory: ${dir}
        run: |
          terraform init -input=false
          terraform plan -input=false -out=tfplan
          terraform show -json tfplan > "$RUNNER_TEMP/plan.json"

      - name: Price the plan
        run: |
          infracost breakdown \\
            --path "$RUNNER_TEMP/plan.json" \\
            --format json \\
            --out-file "$RUNNER_TEMP/infracost.json"

      - name: Summarise the estimate
        run: |
          mkdir -p .terrablox
          jq 'def components($prefix):
              ( .costComponents[]? | {
                  name: ($prefix + .name),
                  unit: .unit,
                  monthlyQuantity: (.monthlyQuantity // null),
                  monthlyCost: (.monthlyCost // null)
                } ),
              ( .subresources[]? | components($prefix + .name + " · ") );
            {
              version: 1,
              generatedAt: (now | todate),
              currency: (.currency // "USD"),
              totalMonthlyCost: (.totalMonthlyCost // null),
              detectedResources: (.summary.totalDetectedResources // null),
              supportedResources: (.summary.totalSupportedResources // null),
              unsupportedResources: (.summary.totalUnsupportedResources // null),
              noPriceResources: (.summary.totalNoPriceResources // null),
              resources: [
                .projects[]? | .breakdown.resources[]? | {
                  name: .name,
                  monthlyCost: (.monthlyCost // null),
                  components: [ components("") ]
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

export function renderBackendFile(context: PipelineContext): string {
  if (!context.stateBucket) return "";

  const lock = context.stateLockTable
    ? `\n    dynamodb_table = "${context.stateLockTable}"`
    : "";

  return `# Managed by TerraBlox.
# Remote state is what makes the pipeline reproducible: without it every run
# starts empty and tries to create the whole stack again.
terraform {
  backend "s3" {
    bucket         = "${context.stateBucket}"
    key            = "${stateKey(context.projectName)}"
    region         = "${context.awsRegion}"
    encrypt        = true${lock}
  }
}
`;
}

/**
 * The IAM trust policy the deployment role needs.
 *
 * Shown rather than created: TerraBlox has no AWS credentials, and handing it
 * any would defeat the point of federating in the first place.
 */
export function renderTrustPolicy(params: {
  awsAccountId: string | null;
  repoFullName: string;
  branch: string;
}): string {
  const account = params.awsAccountId ?? "<your-account-id>";

  return JSON.stringify(
    {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: {
            Federated: `arn:aws:iam::${account}:oidc-provider/${GITHUB_OIDC_PROVIDER}`,
          },
          Action: "sts:AssumeRoleWithWebIdentity",
          Condition: {
            StringEquals: {
              [`${GITHUB_OIDC_PROVIDER}:aud`]: "sts.amazonaws.com",
            },
            // Scoped to this repository so no other repository can assume the
            // role, and to the deployment branch plus pull requests so a fork
            // cannot reach it either.
            StringLike: {
              [`${GITHUB_OIDC_PROVIDER}:sub`]: [
                `repo:${params.repoFullName}:ref:refs/heads/${params.branch}`,
                `repo:${params.repoFullName}:pull_request`,
                `repo:${params.repoFullName}:environment:production`,
              ],
            },
          },
        },
      ],
    },
    null,
    2,
  );
}

/** Settings that must be filled in before the pipeline can do anything. */
export function missingDeploySettings(settings: DeploySettings): string[] {
  const missing: string[] = [];
  if (!settings.awsRoleArn) missing.push("IAM role ARN");
  if (!settings.awsRegion) missing.push("AWS region");
  if (!settings.stateBucket) missing.push("Terraform state bucket");
  return missing;
}

/** The stack that owns the prerequisites, so they can be updated or removed together. */
export function bootstrapStackName(projectName: string): string {
  return `terrablox-${slugify(projectName)}-bootstrap`;
}

/** Re-running the stack must hit the same role, not create a second one. */
function roleNameFrom(roleArn: string | null, projectName: string): string {
  const fromArn = roleArn?.split("/").pop()?.trim();
  return fromArn && fromArn.length > 0
    ? fromArn
    : `terrablox-${slugify(projectName)}-deploy`;
}

/**
 * The account-side prerequisites as one CloudFormation stack.
 *
 * The pipeline can only assume a role that somebody created first, and doing
 * that by hand in the console is where projects stall and where over-permissive
 * roles get made. Handing out a stack keeps that first step reviewable, exactly
 * repeatable and removable, and it keeps TerraBlox out of the account: the user
 * runs it with their own credentials, so this app still holds none.
 *
 * `\${` escapes are CloudFormation's own `!Sub` variables, not interpolation.
 */
export function renderBootstrapTemplate(context: PipelineContext): string {
  const roleName = roleNameFrom(context.awsRoleArn, context.projectName);
  const bucket = context.stateBucket ?? "<set the state bucket in TerraBlox>";

  const lockTableResource = context.stateLockTable
    ? `
  # Without a lock table two applies can write the state at the same time and
  # the loser's resources become invisible to Terraform.
  LockTable:
    Type: AWS::DynamoDB::Table
    DeletionPolicy: Retain
    UpdateReplacePolicy: Retain
    Properties:
      TableName: ${context.stateLockTable}
      BillingMode: PAY_PER_REQUEST
      AttributeDefinitions:
        - AttributeName: LockID
          AttributeType: S
      KeySchema:
        - AttributeName: LockID
          KeyType: HASH
`
    : "";

  const lockStatement = context.stateLockTable
    ? `
              - Effect: Allow
                Action:
                  - dynamodb:GetItem
                  - dynamodb:PutItem
                  - dynamodb:DeleteItem
                Resource: !GetAtt LockTable.Arn`
    : "";

  const lockOutput = context.stateLockTable
    ? `

  LockTableName:
    Description: Value for the "Lock table" field in TerraBlox.
    Value: !Ref LockTable`
    : "";

  return `AWSTemplateFormatVersion: "2010-09-09"
Description: >-
  TerraBlox deployment prerequisites for ${context.projectName}
  (${context.repoFullName}). Creates the GitHub OIDC trust, the deployment role
  and the Terraform state backend. Managed by TerraBlox.

Parameters:
  CreateOidcProvider:
    Type: String
    AllowedValues: ["yes", "no"]
    Default: "yes"
    Description: >-
      An account can hold only one identity provider per URL. Set this to "no"
      if another stack already registered token.actions.githubusercontent.com.

  PermissionsPolicyArn:
    Type: String
    Default: arn:aws:iam::aws:policy/ReadOnlyAccess
    Description: >-
      What the role may do besides reading and writing state. The default is
      enough for "terraform plan" and deliberately not enough for "apply" —
      replace it with a policy scoped to what this project actually deploys.

Conditions:
  WithOidcProvider: !Equals [!Ref CreateOidcProvider, "yes"]

Resources:
  GithubOidcProvider:
    Type: AWS::IAM::OIDCProvider
    Condition: WithOidcProvider
    Properties:
      Url: https://${GITHUB_OIDC_PROVIDER}
      ClientIdList:
        - sts.amazonaws.com
      # AWS verifies GitHub's certificate chain itself, but the field is still
      # required, so this is GitHub's long-standing root thumbprint.
      ThumbprintList:
        - 6938fd4d98bab03faadb97b34396831e3780aea1

  StateBucket:
    Type: AWS::S3::Bucket
    # Deleting the state does not delete the infrastructure it tracks, it only
    # makes Terraform forget about it. Keep the bucket even if the stack goes.
    DeletionPolicy: Retain
    UpdateReplacePolicy: Retain
    Properties:
      BucketName: ${bucket}
      # Every apply overwrites the state; versions are the only way back after
      # a bad run.
      VersioningConfiguration:
        Status: Enabled
      BucketEncryption:
        ServerSideEncryptionConfiguration:
          - ServerSideEncryptionByDefault:
              SSEAlgorithm: AES256
      PublicAccessBlockConfiguration:
        BlockPublicAcls: true
        BlockPublicPolicy: true
        IgnorePublicAcls: true
        RestrictPublicBuckets: true

  StateBucketPolicy:
    Type: AWS::S3::BucketPolicy
    Properties:
      Bucket: !Ref StateBucket
      PolicyDocument:
        Version: "2012-10-17"
        Statement:
          # State holds generated passwords and private keys in clear text.
          - Sid: DenyInsecureTransport
            Effect: Deny
            Principal: "*"
            Action: s3:*
            Resource:
              - !GetAtt StateBucket.Arn
              - !Sub "\${StateBucket.Arn}/*"
            Condition:
              Bool:
                aws:SecureTransport: false
${lockTableResource}
  DeployRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: ${roleName}
      Description: Assumed by GitHub Actions to run Terraform for ${context.projectName}.
      # One hour is longer than a healthy apply and short enough that a leaked
      # token expires before it is useful.
      MaxSessionDuration: 3600
      AssumeRolePolicyDocument:
        Version: "2012-10-17"
        Statement:
          - Effect: Allow
            Principal:
              Federated: !If
                - WithOidcProvider
                - !Ref GithubOidcProvider
                - !Sub "arn:\${AWS::Partition}:iam::\${AWS::AccountId}:oidc-provider/${GITHUB_OIDC_PROVIDER}"
            Action: sts:AssumeRoleWithWebIdentity
            Condition:
              StringEquals:
                "${GITHUB_OIDC_PROVIDER}:aud": sts.amazonaws.com
              # Scoped to this repository and these refs, so neither another
              # repository nor a fork's pull request can assume the role.
              StringLike:
                "${GITHUB_OIDC_PROVIDER}:sub":
                  - "repo:${context.repoFullName}:ref:refs/heads/${context.branch}"
                  - "repo:${context.repoFullName}:pull_request"
                  - "repo:${context.repoFullName}:environment:production"
      ManagedPolicyArns:
        - !Ref PermissionsPolicyArn
      Policies:
        - PolicyName: terraform-state
          PolicyDocument:
            Version: "2012-10-17"
            Statement:
              - Effect: Allow
                Action: s3:ListBucket
                Resource: !GetAtt StateBucket.Arn
              - Effect: Allow
                Action:
                  - s3:GetObject
                  - s3:PutObject
                  - s3:DeleteObject
                Resource: !Sub "\${StateBucket.Arn}/${stateKey(context.projectName)}"${lockStatement}

Outputs:
  DeployRoleArn:
    Description: Value for the "Deployment role ARN" field in TerraBlox.
    Value: !GetAtt DeployRole.Arn

  StateBucketName:
    Description: Value for the "State bucket" field in TerraBlox.
    Value: !Ref StateBucket${lockOutput}
`;
}

/** The one command that turns the template into the prerequisites. */
export function renderBootstrapCommand(context: PipelineContext): string {
  return [
    "aws cloudformation deploy \\",
    `  --stack-name ${bootstrapStackName(context.projectName)} \\`,
    "  --template-file terrablox-bootstrap.yml \\",
    "  --capabilities CAPABILITY_NAMED_IAM \\",
    `  --region ${context.awsRegion}`,
  ].join("\n");
}
