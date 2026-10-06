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
 * Terraform versions a project may pin its pipeline to, newest first.
 *
 * A fixed list rather than a free-text box, which is what this used to be: a typo
 * there became a `setup-terraform` step that failed on a version nobody publishes,
 * and the run had already federated into AWS by the time it did.
 *
 * The newest patch of each supported minor line, taken from HashiCorp's releases —
 * older patches are not offered because pinning to a superseded one only opts out
 * of fixes. Add to the front as new versions ship; the first entry is the default.
 */
export const TERRAFORM_VERSIONS = ["1.16.0", "1.15.9", "1.14.9"] as const;

export const DEFAULT_TERRAFORM_VERSION: string = TERRAFORM_VERSIONS[0];

/** Whether a stored version is still one this pipeline knows how to install. */
export function isKnownTerraformVersion(value: string): boolean {
  return (TERRAFORM_VERSIONS as readonly string[]).includes(value);
}

/** The single audience and issuer GitHub Actions uses for AWS federation. */
/**
 * Re-exported so the templates below and their readers keep one import.
 *
 * Defined in `@terrablox/aws/github-oidc`, which is a module with no imports at all —
 * because the IAM code that looks the provider up needs the same constant, and putting it
 * beside that code would ship the AWS SDK to the browser through the deployment wizard.
 */
export { GITHUB_OIDC_PROVIDER } from "@terrablox/aws/github-oidc";

import { GITHUB_OIDC_PROVIDER } from "@terrablox/aws/github-oidc";

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
  /** Set once the state stack has run; the backend cannot encrypt without it. */
  stateKmsKeyArn: string | null;
}

/**
 * The stack that owns the state, separate from the one that owns the role.
 *
 * There was a `LockTableName` here too. Locking moved into the bucket, so the
 * stack has no table to report — and the `projects.state_lock_table` column is
 * left as it is rather than migrated: it records the table an older project
 * created and still has sitting in its account.
 */
export const STATE_BUCKET_OUTPUT_KEY = "StateBucketName";
export const KMS_KEY_OUTPUT_KEY = "StateKmsKeyArn";

export interface PipelineContext extends DeploySettings {
  repoFullName: string;
  branch: string;
  /** Repository-relative folder holding the root configuration. */
  rootFolder: string;
  projectName: string;
  terraformVersion?: string;
  /**
   * The KMS alias the state stack owns, once the project has pinned one.
   *
   * Passed in rather than derived here, because deriving it from the name means it
   * changes when the name does — and an alias that changes is CloudFormation
   * creating a second one on the next update while the first keeps pointing at the
   * key. The old derivation stays as the fallback for a project that has not been
   * set up yet, which is the only case with nothing to preserve.
   */
  stateKmsAlias?: string | null;
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

/**
 * A project name that is safe to drop into a YAML scalar.
 *
 * Every identifier below is slugified — stack names, bucket names, role names, state
 * keys — but the human-readable name also appears in `Description:` fields, and there
 * it was interpolated raw. A project name is a free-text column, so a name containing
 * a newline broke out of the scalar and could append arbitrary `Resources:` to a
 * CloudFormation template that the user is then told to deploy into their own account
 * with administrator permissions.
 *
 * Slugifying would fix it and make the descriptions unreadable, which is the wrong
 * trade for the one field whose job is to be read. So: collapse all whitespace to
 * single spaces (which removes the newlines and tabs that carry the injection), drop
 * control characters, and cap the length. What survives is still the user's name.
 *
 * The result is only safe for *inline* use inside a block scalar or after
 * `JSON.stringify`. It is deliberately not quoted here — see {@link yamlQuoted} for
 * the plain-scalar case, which needs quoting for a leading `*`, `&` or `!` too.
 */
function yamlInline(value: string, max = 120): string {
  const flattened = value
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const capped =
    flattened.length > max
      ? `${flattened.slice(0, max - 1).trim()}…`
      : flattened;

  return capped || "this project";
}

/**
 * The same value as a quoted YAML scalar.
 *
 * YAML 1.2 is a superset of JSON, so a JSON string literal is always a valid
 * double-quoted scalar — which makes `JSON.stringify` the correct escaper here rather
 * than a hand-rolled one. Used where the value stands alone after a key, since in
 * that position a leading `!`, `&`, `*` or `#` would otherwise be read as YAML syntax
 * rather than as text.
 */
function yamlQuoted(value: string, max = 120): string {
  return JSON.stringify(yamlInline(value, max));
}

/**
 * A project slug that is valid as a CloudFormation stack name.
 *
 * Stack names have to begin with a letter, which every name here used to get for
 * free from a hardcoded `terrablox-` in front. Now that the project's own name
 * leads, a project called `2024-platform` would produce a name CloudFormation
 * rejects — and it would be rejected at create time, after the wizard had already
 * told the user to expect a stack.
 *
 * Only stack names need this. Buckets may begin with a digit, and so may IAM roles,
 * DynamoDB tables and KMS aliases.
 */
function stackSlug(projectName: string): string {
  const slug = slugify(projectName);
  // 128 is CloudFormation's ceiling; this leaves room for `tf-` and `-bootstrap`,
  // the longest suffix any caller adds. A project name is a free-text column, so
  // the limit is reachable without anybody doing anything strange.
  const capped = truncateSlug(slug, 115);
  return /^[a-z]/.test(capped) ? capped : `tf-${capped}`;
}

/** Cuts to `max` without leaving a trailing separator, which reads as a typo. */
function truncateSlug(slug: string, max: number): string {
  return slug.length <= max ? slug : slug.slice(0, max).replace(/-+$/, "");
}

/**
 * Terraform state keys are paths; keep them free of anything that needs escaping.
 *
 * Untruncated, and it must stay that way. Unlike every name below, this one is
 * recomputed on every read rather than stored on the project, so shortening it
 * would point an existing project at a key that has no state in it — which reads
 * to Terraform as an empty state, and to the State tab as an account with nothing
 * in it.
 */
export function stateKey(projectName: string): string {
  return `${slugify(projectName)}/terraform.tfstate`;
}

/**
 * Characters a bucket discriminator is drawn from.
 *
 * Lower case and digits only, which is all an S3 bucket name allows, and no
 * separators so the token cannot end up looking like part of the project's name.
 */
const DISCRIMINATOR_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** How many characters of it. 36^6 is about two billion — plenty to not repeat. */
const DISCRIMINATOR_LENGTH = 6;

/**
 * A short random tail, so the same project can mint a second bucket name.
 *
 * `globalThis.crypto` rather than `node:crypto`: this module is imported by the
 * deploy wizard, which is a client component, and a Node built-in in that import
 * graph breaks the browser build. The Web Crypto API is present on both sides.
 *
 * Modulo bias is left alone deliberately. This is a uniqueness token, not a secret;
 * nothing is protected by its being uniformly distributed.
 */
function bucketDiscriminator(): string {
  const bytes = new Uint8Array(DISCRIMINATOR_LENGTH);
  globalThis.crypto.getRandomValues(bytes);

  let out = "";
  for (const byte of bytes) {
    out += DISCRIMINATOR_ALPHABET[byte % DISCRIMINATOR_ALPHABET.length];
  }
  return out;
}

/**
 * Mints a state bucket name nobody has to invent.
 *
 * Named `new…` rather than `default…` because it is not a derivation: two calls
 * give two answers. Call it once, store the result, and read the stored one
 * forever after — which is what {@link https://en.wikipedia.org/wiki/Idempotence
 * the first apply} does.
 *
 * Asking the user for one is the step the setup used to stall on: the name has to
 * be globally unique across all of S3, so the obvious guesses are taken and the
 * error only appears once CloudFormation is already running.
 *
 * Three parts, and each earns its place. The project's name leads, because that is
 * what the reader looks for in a console listing. The account id makes the name
 * globally unique, so two people who both call a project `infrastructure` do not
 * race for one bucket; it is not a secret either, as it appears in every ARN the
 * pipeline logs. And the random tail is what makes the name *re-mintable*: the
 * bucket is set to retain, so deleting the state stack leaves it standing, and a
 * fully derived name meant the next create collided with the bucket its own
 * predecessor left behind — a dead end that could only be escaped by deleting the
 * bucket in the AWS console. With a tail, starting over is starting over.
 *
 * The slug is capped so the whole name fits S3's 63 characters: 35 leaves exactly
 * room for `-tfstate-`, the twelve digits of an account id, and the tail. Still
 * wide enough that a name carrying an environment on the end — `…-staging` against
 * `…-prod` — survives intact, which a tighter cap would truncate into a collision.
 */
export function newStateBucketName(
  projectName: string,
  accountId: string,
): string {
  const slug = truncateSlug(slugify(projectName), 35);
  return `${slug}-tfstate-${accountId}-${bucketDiscriminator()}`;
}

/**
 * The lock file S3-native locking writes, beside the state it guards.
 *
 * Terraform's own naming, not ours: it appends `.tflock` to the state key. Derived
 * here because two places need to agree on it — the backend does not name it, and
 * the deploy role has to be allowed to write and delete exactly this object.
 */
export function lockFileKey(projectName: string): string {
  return `${stateKey(projectName)}.tflock`;
}

/**
 * What may appear inside a double-quoted HCL string in a generated file.
 *
 * Bucket names and KMS ARNs are validated at the API boundary, so by the time they
 * arrive here they already match a pattern. This is the second lock on the same door,
 * and it is worth having because *this* function is the one that emits HCL: a future
 * caller that reads these values from somewhere other than the validated route — a
 * migration, an import, a fixture — would otherwise reintroduce the injection
 * silently. Throwing is right rather than escaping: neither value has any legitimate
 * reason to contain a quote or a newline, so a value that does is a bug upstream, and
 * writing an escaped version of it into `backend.tf` would hide that bug behind a
 * Terraform error nobody can trace back to here.
 */
const HCL_SAFE = /^[A-Za-z0-9:._\-/]+$/;

function hclLiteral(value: string, field: string): string {
  if (!HCL_SAFE.test(value)) {
    throw new Error(
      `Refusing to write ${field} into backend.tf: ${JSON.stringify(value)} contains characters that are not valid in this position.`,
    );
  }
  return value;
}

export function renderBackendFile(context: PipelineContext): string {
  if (!context.stateBucket) return "";

  const bucket = hclLiteral(context.stateBucket, "the state bucket");

  // Naming the key rather than relying on the bucket default: the default only
  // applies to objects S3 encrypts on its own, and a backend that silently fell
  // back to SSE-S3 would look identical from here while being a different
  // guarantee.
  const kms = context.stateKmsKeyArn
    ? `\n    kms_key_id     = "${hclLiteral(context.stateKmsKeyArn, "the KMS key ARN")}"`
    : "";

  return `# Managed by Terrablox.
# Remote state is what makes the pipeline reproducible: without it every run
# starts empty and tries to create the whole stack again.
terraform {
  backend "s3" {
    bucket         = "${bucket}"
    key            = "${stateKey(context.projectName)}"
    region         = "${hclLiteral(context.awsRegion, "the AWS region")}"
    encrypt        = true${kms}
    # Locking, so two applies cannot write this state at once. S3 does it itself
    # through a conditional write on ${lockFileKey(context.projectName)};
    # a DynamoDB table used to be the only way and is deprecated since 1.11.
    use_lockfile   = true
  }
}
`;
}

/**
 * The IAM trust policy the deployment role needs.
 *
 * Shown rather than created: Terrablox has no AWS credentials, and handing it
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
  return `${stackSlug(projectName)}-bootstrap`;
}

/**
 * Re-running the stack must hit the same role, not create a second one.
 *
 * 57 keeps `-deploy` inside IAM's 64-character limit for a role name — the
 * tightest ceiling of any name here.
 */
function roleNameFrom(roleArn: string | null, projectName: string): string {
  const fromArn = roleArn?.split("/").pop()?.trim();
  return fromArn && fromArn.length > 0
    ? fromArn
    : `${truncateSlug(slugify(projectName), 57)}-deploy`;
}

/** The stack that owns the state, so it can outlive the role that writes it. */
export function stateStackName(projectName: string): string {
  return `${stackSlug(projectName)}-state`;
}

/**
 * An alias is what a person reads in the console; the ARN is what policies use.
 * 242 keeps `alias/` and `-tfstate` inside KMS's 256.
 */
export function defaultKmsAlias(projectName: string): string {
  return `alias/${truncateSlug(slugify(projectName), 242)}-tfstate`;
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
              # Two objects, not one: the state, and the lock file S3-native
              # locking writes beside it. Without the second entry every run
              # fails on acquiring the lock rather than on the state — and a
              # rollback then cannot delete it either, which leaves the state
              # locked until someone removes the object by hand.
              - Effect: Allow
                Action:
                  - s3:GetObject
                  - s3:PutObject
                  - s3:DeleteObject
                Resource:
                  - !Sub "arn:\${AWS::Partition}:s3:::${bucket}/${stateKey(context.projectName)}"
                  - !Sub "arn:\${AWS::Partition}:s3:::${bucket}/${lockFileKey(context.projectName)}"
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
                    kms:ViaService: !Sub "s3.\${AWS::Region}.amazonaws.com"`
    : "";

  return `AWSTemplateFormatVersion: "2010-09-09"
Description: >-
  Terrablox deployment role for ${yamlInline(context.projectName)}
  (${context.repoFullName}). Creates the GitHub OIDC trust and the role that
  GitHub Actions assumes to run Terraform. Managed by Terrablox.

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
    # The one resource in this stack that does not belong to this project.
    #
    # IAM allows exactly one identity provider per URL per account, so every
    # Terrablox project in an account shares this one -- and it is owned by
    # whichever project's stack happened to create it first. Without Retain,
    # deleting *that* project's role stack deletes the provider, and every other
    # project's role in the account stops being assumable at once: their trust
    # policies name a federated principal that no longer exists, and STS answers
    # "Not authorized to perform sts:AssumeRoleWithWebIdentity" -- a message that
    # points at the role, which is where nobody will find the cause.
    #
    # Retaining it is safe, and specifically does not create the usual orphan
    # problem: every apply asks IAM whether the provider is already there, in
    # hasGithubOidcProvider, and passes CreateOidcProvider "no" when it is. So a
    # retained provider is adopted by the next stack instead of colliding with it.
    DeletionPolicy: Retain
    UpdateReplacePolicy: Retain
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
      Description: ${yamlQuoted(`Assumed by GitHub Actions to run Terraform for ${context.projectName}.`, 200)}
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
    Description: Value for the "Deployment role ARN" field in Terrablox.
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

  const alias = context.stateKmsAlias ?? defaultKmsAlias(context.projectName);
  const roleName = roleNameFrom(context.awsRoleArn, context.projectName);

  // No lock table. Locking is the bucket's own job now — `use_lockfile` in the
  // backend has S3 do it with a conditional write — so there is one resource fewer
  // to create, to pay for, and to trip over when this stack is rebuilt: a retained
  // table keeps its name, and the name is what a fresh create collides with.
  return `AWSTemplateFormatVersion: "2010-09-09"
Description: >-
  Terrablox Terraform state backend for ${yamlInline(context.projectName)}
  (${context.repoFullName}). Creates the KMS key and the encrypted state bucket.
  Kept separate from the deployment role because deleting state loses track of
  running infrastructure. Managed by Terrablox.

Resources:
  StateKey:
    Type: AWS::KMS::Key
    DeletionPolicy: Retain
    UpdateReplacePolicy: Retain
    Properties:
      Description: ${yamlQuoted(`Encrypts the Terraform state for ${context.projectName}.`, 200)}
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

Outputs:
  ${STATE_BUCKET_OUTPUT_KEY}:
    Description: The bucket holding the Terraform state.
    Value: !Ref StateBucket

  ${KMS_KEY_OUTPUT_KEY}:
    Description: The key the state is encrypted with. Reading it needs kms:Decrypt here.
    Value: !GetAtt StateKey.Arn
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
