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
export const BACKEND_FILE = "backend.tf";

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

/**
 * Repository variables the generated workflows read at run time.
 *
 * Defined here rather than next to the GitHub client because they are part of
 * the contract of the rendered YAML: whoever changes a name has to change the
 * workflow in the same edit, or the pipeline silently falls back.
 *
 * Variables, not secrets: a role ARN and a bucket name are not credentials, and
 * a secret could never be read back to show the user what is configured.
 */
export const AWS_ROLE_VARIABLE = "TERRABLOX_AWS_ROLE_ARN";
export const AWS_REGION_VARIABLE = "TERRABLOX_AWS_REGION";
export const STATE_BUCKET_VARIABLE = "TERRABLOX_STATE_BUCKET";

/**
 * What the deployment role may do, beyond reading and writing its own state.
 *
 * Administrator, because Terraform can be asked to create anything and a role
 * scoped narrower fails halfway through an apply with a permission error rather
 * than a plan. The consequence is deliberate and worth stating plainly: anyone
 * who can push to the repository, or start a workflow in it, can do anything in
 * this AWS account. The role is a CloudFormation parameter precisely so it can
 * be narrowed later without regenerating anything.
 */
export const DEPLOY_PERMISSIONS_POLICY_ARN =
  "arn:aws:iam::aws:policy/AdministratorAccess";

/** CloudFormation parameter names the bootstrap template accepts. */
export const PERMISSIONS_POLICY_PARAMETER = "PermissionsPolicyArn";
export const CREATE_OIDC_PARAMETER = "CreateOidcProvider";

export interface DeploySettings {
  awsAccountId: string | null;
  awsRegion: string;
  awsRoleArn: string | null;
  stateBucket: string | null;
  stateLockTable: string | null;
  /** Set once the state stack has run; the backend cannot encrypt without it. */
  stateKmsKeyArn: string | null;
}

/** The stack that owns the state, separate from the one that owns the role. */
export const STATE_BUCKET_OUTPUT_KEY = "StateBucketName";
export const LOCK_TABLE_OUTPUT_KEY = "LockTableName";
export const KMS_KEY_OUTPUT_KEY = "StateKmsKeyArn";

export interface PipelineContext extends DeploySettings {
  repoFullName: string;
  branch: string;
  /** Repository-relative folder holding the root configuration. */
  rootFolder: string;
  projectName: string;
  terraformVersion?: string;
}

/** `.` is where Terraform lives by default, but Actions wants a real path. */
export function workingDirectory(rootFolder: string): string {
  const trimmed = rootFolder
    .trim()
    .replace(/^\.\/?/, "")
    .replace(/\/+$/, "");
  return trimmed === "" ? "." : trimmed;
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
export function stateKey(projectName: string): string {
  return `${slugify(projectName)}/terraform.tfstate`;
}

/**
 * A state bucket name nobody has to invent.
 *
 * Asking for one is the step the setup used to stall on: the name has to be
 * globally unique across all of S3, so the obvious guesses are taken and the
 * error only appears once CloudFormation is already running. The account id
 * makes it unique without being secret — it is in every ARN the pipeline logs.
 *
 * Bucket names are capped at 63 characters, hence the truncated slug.
 */
export function defaultStateBucket(
  projectName: string,
  accountId: string,
): string {
  const slug = slugify(projectName).slice(0, 24).replace(/-+$/, "");
  return `terrablox-tfstate-${accountId}-${slug}`;
}

/** DynamoDB is far more relaxed about names, so this one only has to be stable. */
export function defaultLockTable(projectName: string): string {
  return `terrablox-${slugify(projectName)}-tflock`;
}

export function renderBackendFile(context: PipelineContext): string {
  if (!context.stateBucket) return "";

  const lock = context.stateLockTable
    ? `\n    dynamodb_table = "${context.stateLockTable}"`
    : "";

  // Naming the key rather than relying on the bucket default: the default only
  // applies to objects S3 encrypts on its own, and a backend that silently fell
  // back to SSE-S3 would look identical from here while being a different
  // guarantee.
  const kms = context.stateKmsKeyArn
    ? `\n    kms_key_id     = "${context.stateKmsKeyArn}"`
    : "";

  return `# Managed by TerraBlox.
# Remote state is what makes the pipeline reproducible: without it every run
# starts empty and tries to create the whole stack again.
terraform {
  backend "s3" {
    bucket         = "${context.stateBucket}"
    key            = "${stateKey(context.projectName)}"
    region         = "${context.awsRegion}"
    encrypt        = true${kms}${lock}
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
            // Scoped to this repository and to the deployment branch, which is
            // the only ref a manually started run can use. Pull requests are
            // deliberately absent: nothing runs on them, and a fork's PR must
            // never reach a role with these permissions.
            StringLike: {
              [`${GITHUB_OIDC_PROVIDER}:sub`]: [
                `repo:${params.repoFullName}:ref:refs/heads/${params.branch}`,
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
  if (!settings.stateKmsKeyArn) missing.push("state encryption key");
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

/** The stack that owns the state, so it can outlive the role that writes it. */
export function stateStackName(projectName: string): string {
  return `terrablox-${slugify(projectName)}-state`;
}

/** An alias is what a person reads in the console; the ARN is what policies use. */
export function defaultKmsAlias(projectName: string): string {
  return `alias/terrablox-${slugify(projectName)}-state`;
}

/**
 * The identity half of the prerequisites: the OIDC trust and the deploy role.
 *
 * Split from the state stack on purpose. The two have opposite lifetimes — a
 * role can be deleted and rebuilt at will, while deleting the state bucket makes
 * Terraform forget about infrastructure that is still running. Keeping them in
 * one stack meant every change to either put the other at risk.
 *
 * The role's state permissions are therefore written against names rather than
 * `!GetAtt`: this stack may well be created before the bucket exists.
 *
 * `\${` escapes are CloudFormation's own `!Sub` variables, not interpolation.
 */
export function renderBootstrapTemplate(context: PipelineContext): string {
  const roleName = roleNameFrom(context.awsRoleArn, context.projectName);
  const bucket = context.stateBucket ?? "";

  // Without a bucket name there is nothing to scope to yet, and a policy naming
  // an empty ARN is invalid. The role is still useful: it can be created first
  // and updated once the state stack has run.
  const statePolicy = bucket
    ? `
      Policies:
        - PolicyName: terraform-state
          PolicyDocument:
            Version: "2012-10-17"
            Statement:
              - Effect: Allow
                Action: s3:ListBucket
                Resource: !Sub "arn:\${AWS::Partition}:s3:::${bucket}"
              - Effect: Allow
                Action:
                  - s3:GetObject
                  - s3:PutObject
                  - s3:DeleteObject
                Resource: !Sub "arn:\${AWS::Partition}:s3:::${bucket}/${stateKey(context.projectName)}"
              # The state is encrypted with a customer-managed key, so writing it
              # needs the key as well as the object. Scoped by ViaService rather
              # than by key ARN because this stack does not know the key id yet.
              - Effect: Allow
                Action:
                  - kms:Encrypt
                  - kms:Decrypt
                  - kms:ReEncrypt*
                  - kms:GenerateDataKey*
                  - kms:DescribeKey
                Resource: "*"
                Condition:
                  StringEquals:
                    kms:ViaService: !Sub "s3.\${AWS::Region}.amazonaws.com"${
                      context.stateLockTable
                        ? `
              - Effect: Allow
                Action:
                  - dynamodb:GetItem
                  - dynamodb:PutItem
                  - dynamodb:DeleteItem
                Resource: !Sub "arn:\${AWS::Partition}:dynamodb:\${AWS::Region}:\${AWS::AccountId}:table/${context.stateLockTable}"`
                        : ""
                    }`
    : "";

  return `AWSTemplateFormatVersion: "2010-09-09"
Description: >-
  TerraBlox deployment role for ${context.projectName}
  (${context.repoFullName}). Creates the GitHub OIDC trust and the role that
  GitHub Actions assumes to run Terraform. Managed by TerraBlox.

Parameters:
  CreateOidcProvider:
    Type: String
    AllowedValues: ["yes", "no"]
    Default: "yes"
    Description: >-
      An account can hold only one identity provider per URL. Set this to "no"
      if another stack already registered ${GITHUB_OIDC_PROVIDER}.

  PermissionsPolicyArn:
    Type: String
    Default: ${DEPLOY_PERMISSIONS_POLICY_ARN}
    Description: >-
      What the role may do besides reading and writing state. Administrator by
      default, because Terraform can be asked to create anything and a narrower
      role fails part-way through an apply. This also means anyone who can push
      to ${context.repoFullName}, or start a workflow in it, can do anything in
      this account. Replace it with a policy scoped to what this project really
      deploys once that list has settled.

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
              # Scoped to this repository and to the deployment branch, the only
              # ref a manually started run can use. Pull requests are left out
              # on purpose so a fork's PR can never assume this role.
              StringLike:
                "${GITHUB_OIDC_PROVIDER}:sub":
                  - "repo:${context.repoFullName}:ref:refs/heads/${context.branch}"
                  - "repo:${context.repoFullName}:environment:production"
      ManagedPolicyArns:
        - !Ref PermissionsPolicyArn${statePolicy}

Outputs:
  DeployRoleArn:
    Description: Value for the "Deployment role ARN" field in TerraBlox.
    Value: !GetAtt DeployRole.Arn
`;
}

/**
 * The Terraform state backend as its own stack: a KMS key, the bucket it
 * encrypts, and the lock table.
 *
 * Its own key rather than S3's default encryption, because the two answer
 * different questions. SSE-S3 protects the bytes at rest from AWS's side; a
 * customer-managed key makes reading the state an auditable, revocable grant —
 * every read shows up in CloudTrail against a key the account owns, and taking
 * the grant away locks everyone out including this app. Terraform state holds
 * generated passwords and private keys in clear text, which is the kind of
 * material that deserves that.
 *
 * Everything here is `Retain`. Deleting the state does not delete the
 * infrastructure it tracks, it only makes Terraform forget about it — and a key
 * that is gone makes the existing objects unreadable forever.
 */
export function renderStateTemplate(context: PipelineContext): string {
  const bucket = context.stateBucket;
  if (!bucket) {
    throw new Error("The state stack needs a bucket name.");
  }

  const alias = defaultKmsAlias(context.projectName);
  const roleName = roleNameFrom(context.awsRoleArn, context.projectName);

  const lockTable = context.stateLockTable
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

  const lockOutput = context.stateLockTable
    ? `

  LockTableName:
    Description: The DynamoDB table that holds the state lock.
    Value: !Ref LockTable`
    : "";

  return `AWSTemplateFormatVersion: "2010-09-09"
Description: >-
  TerraBlox Terraform state backend for ${context.projectName}
  (${context.repoFullName}). Creates the KMS key, the encrypted state bucket and
  the lock table. Kept separate from the deployment role because deleting state
  loses track of running infrastructure. Managed by TerraBlox.

Resources:
  StateKey:
    Type: AWS::KMS::Key
    DeletionPolicy: Retain
    UpdateReplacePolicy: Retain
    Properties:
      Description: Encrypts the Terraform state for ${context.projectName}.
      EnableKeyRotation: true
      # Long enough to notice a mistake, which is the only reason this window
      # exists: a deleted key makes every existing state version unreadable.
      PendingWindowInDays: 30
      KeyPolicy:
        Version: "2012-10-17"
        Statement:
          # Without this the key is unmanageable: KMS does not fall back to IAM
          # for the key itself, so locking out the account root is permanent.
          - Sid: AllowAccountAdministration
            Effect: Allow
            Principal:
              AWS: !Sub "arn:\${AWS::Partition}:iam::\${AWS::AccountId}:root"
            Action: "kms:*"
            Resource: "*"
          # The pipeline writes the state through this key.
          - Sid: AllowDeployRole
            Effect: Allow
            Principal:
              AWS: !Sub "arn:\${AWS::Partition}:iam::\${AWS::AccountId}:role/${roleName}"
            Action:
              - kms:Encrypt
              - kms:Decrypt
              - kms:ReEncrypt*
              - kms:GenerateDataKey*
              - kms:DescribeKey
            Resource: "*"

  StateKeyAlias:
    Type: AWS::KMS::Alias
    Properties:
      AliasName: ${alias}
      TargetKeyId: !Ref StateKey

  StateBucket:
    Type: AWS::S3::Bucket
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
              SSEAlgorithm: aws:kms
              KMSMasterKeyID: !GetAtt StateKey.Arn
            # Without a bucket key every object costs a separate KMS call, which
            # a state file read on every page load would notice.
            BucketKeyEnabled: true
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
          # An unencrypted PUT would leave a version of the state in the clear,
          # which the bucket default cannot prevent on its own.
          - Sid: DenyUnencryptedWrites
            Effect: Deny
            Principal: "*"
            Action: s3:PutObject
            Resource: !Sub "\${StateBucket.Arn}/*"
            Condition:
              StringNotEquals:
                s3:x-amz-server-side-encryption: aws:kms
${lockTable}
Outputs:
  ${STATE_BUCKET_OUTPUT_KEY}:
    Description: The bucket holding the Terraform state.
    Value: !Ref StateBucket

  ${KMS_KEY_OUTPUT_KEY}:
    Description: The key the state is encrypted with. Reading it needs kms:Decrypt here.
    Value: !GetAtt StateKey.Arn${lockOutput}
`;
}

/** The one command that turns a template into the thing it describes. */
export function renderBootstrapCommand(context: PipelineContext): string {
  return [
    "aws cloudformation deploy \\",
    `  --stack-name ${bootstrapStackName(context.projectName)} \\`,
    "  --template-file terrablox-role.yml \\",
    "  --capabilities CAPABILITY_NAMED_IAM \\",
    `  --region ${context.awsRegion}`,
  ].join("\n");
}

export function renderStateCommand(context: PipelineContext): string {
  return [
    "aws cloudformation deploy \\",
    `  --stack-name ${stateStackName(context.projectName)} \\`,
    "  --template-file terrablox-state.yml \\",
    `  --region ${context.awsRegion}`,
  ].join("\n");
}
