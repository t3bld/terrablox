/**
 * A role that lets an IAM-only sign-in run the deployment setup.
 *
 * The setup creates CloudFormation stacks holding an IAM role, an S3 bucket and
 * a KMS key, so it needs all four services in one session. Some organisations
 * split those across permission sets: one with IAM and nothing else, one like
 * PowerUser with everything except IAM. Neither can create the stacks alone.
 *
 * The IAM-only set can create a role, though, and a role's trust policy may name
 * the SSO role directly, which is enough for the same account to assume it. So a
 * sign-in that cannot use CloudFormation but can use IAM gets one of these, and
 * every AWS call Terrablox makes for it goes through the assumed role.
 *
 * One per SSO permission set and account, shared by every project in that
 * account. It is the user's capability, not a project's resource: each project
 * still gets its own deploy role, state bucket and key from its own stacks.
 *
 * No `server-only` marker, like the rest of this package: credentials are
 * parameters here, never stored.
 */
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import {
  CreateRoleCommand,
  DeleteRoleCommand,
  DeleteRolePolicyCommand,
  GetRoleCommand,
  IAMClient,
  PutRolePolicyCommand,
  UpdateAssumeRolePolicyCommand,
} from "@aws-sdk/client-iam";
import {
  AssumeRoleCommand,
  GetCallerIdentityCommand,
  STSClient,
} from "@aws-sdk/client-sts";
import { AwsConnectionError, READ_ONLY_POLICY_ARN } from "./connection";
import type { AwsSessionCredentials } from "./session";

const ROLE_PREFIX = "terrablox-setup-";
const INLINE_POLICY_NAME = "terrablox-setup";

/** Chained role sessions are capped at one hour by STS, whatever we ask for. */
const SESSION_DURATION_SECONDS = 900;

function sdkCredentials(credentials: AwsSessionCredentials) {
  return {
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
  };
}

function errorName(error: unknown): string {
  return typeof error === "object" && error !== null && "name" in error
    ? String((error as { name: unknown }).name)
    : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAccessDenied(error: unknown): boolean {
  const name = errorName(error);
  return (
    name === "AccessDenied" ||
    name === "AccessDeniedException" ||
    /not authorized/i.test(errorMessage(error))
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The role's name for one permission set.
 *
 * Per permission set rather than one fixed name, because the trust policy names
 * exactly one SSO role: two people signing in with different sets must not
 * overwrite each other's trust. 64 is IAM's limit for a role name.
 */
export function setupRoleName(ssoRoleName: string): string {
  const slug =
    ssoRoleName
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "sso";
  return `${ROLE_PREFIX}${slug}`.slice(0, 64).replace(/-+$/, "");
}

/**
 * What the role may do: exactly what the deployment setup and the State tab use.
 *
 * Scoped by the names Terrablox gives things, so the role cannot touch stacks,
 * roles or buckets that are not part of a project setup:
 * - stacks end in `-bootstrap` or `-state` (`bootstrapStackName`, `stateStackName`),
 * - deploy roles end in `-deploy` (`roleNameFrom`),
 * - state buckets contain `-tfstate-` (`newStateBucketName`).
 *
 * Still powerful, and deliberately so: the role stack attaches the deploy
 * permissions policy (AdministratorAccess by default) to the deploy role. That
 * is the setup working as designed, and the reason this role trusts only the
 * one SSO role that created it.
 *
 * KMS has no name to scope by before a key exists, so key actions are on `*`.
 * The state key's own policy is what limits who can use it afterwards.
 */
export function setupRolePolicy(accountId: string): string {
  const stack = (suffix: string) =>
    `arn:aws:cloudformation:*:${accountId}:stack/*-${suffix}/*`;

  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "BootstrapStacks",
        Effect: "Allow",
        Action: [
          "cloudformation:CreateStack",
          "cloudformation:UpdateStack",
          "cloudformation:DeleteStack",
          "cloudformation:DescribeStacks",
          "cloudformation:DescribeStackEvents",
          "cloudformation:DescribeStackResources",
          "cloudformation:GetTemplate",
        ],
        Resource: [stack("bootstrap"), stack("state")],
      },
      {
        Sid: "TemplateValidation",
        Effect: "Allow",
        Action: ["cloudformation:ValidateTemplate"],
        Resource: "*",
      },
      {
        Sid: "DeployRoles",
        Effect: "Allow",
        Action: [
          "iam:CreateRole",
          "iam:DeleteRole",
          "iam:GetRole",
          "iam:UpdateRole",
          "iam:UpdateRoleDescription",
          "iam:UpdateAssumeRolePolicy",
          "iam:TagRole",
          "iam:UntagRole",
          "iam:ListRoleTags",
          "iam:AttachRolePolicy",
          "iam:DetachRolePolicy",
          "iam:ListAttachedRolePolicies",
          "iam:PutRolePolicy",
          "iam:GetRolePolicy",
          "iam:DeleteRolePolicy",
          "iam:ListRolePolicies",
          "iam:ListInstanceProfilesForRole",
        ],
        Resource: `arn:aws:iam::${accountId}:role/*-deploy`,
      },
      {
        // One per account, shared by every project; see the role template.
        Sid: "GithubOidcProvider",
        Effect: "Allow",
        Action: [
          "iam:CreateOpenIDConnectProvider",
          "iam:GetOpenIDConnectProvider",
          "iam:AddClientIDToOpenIDConnectProvider",
          "iam:UpdateOpenIDConnectProviderThumbprint",
          "iam:TagOpenIDConnectProvider",
          "iam:UntagOpenIDConnectProvider",
          "iam:ListOpenIDConnectProviderTags",
        ],
        Resource: `arn:aws:iam::${accountId}:oidc-provider/token.actions.githubusercontent.com`,
      },
      {
        Sid: "ListOidcProviders",
        Effect: "Allow",
        Action: ["iam:ListOpenIDConnectProviders"],
        Resource: "*",
      },
      {
        Sid: "StateBuckets",
        Effect: "Allow",
        Action: "s3:*",
        Resource: ["arn:aws:s3:::*-tfstate-*", "arn:aws:s3:::*-tfstate-*/*"],
      },
      {
        Sid: "StateKeys",
        Effect: "Allow",
        Action: [
          "kms:CreateKey",
          "kms:DescribeKey",
          "kms:GetKeyPolicy",
          "kms:PutKeyPolicy",
          "kms:GetKeyRotationStatus",
          "kms:EnableKeyRotation",
          "kms:DisableKeyRotation",
          "kms:UpdateKeyDescription",
          "kms:EnableKey",
          "kms:ListResourceTags",
          "kms:TagResource",
          "kms:UntagResource",
          "kms:CreateAlias",
          "kms:UpdateAlias",
          "kms:DeleteAlias",
          "kms:ListAliases",
          // Reading the state, which is encrypted with the project's key.
          "kms:Decrypt",
          "kms:GenerateDataKey",
        ],
        Resource: "*",
      },
    ],
  });
}

function trustPolicy(ssoRoleArn: string): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { AWS: ssoRoleArn },
        Action: "sts:AssumeRole",
      },
    ],
  });
}

/**
 * Whether these credentials need a setup role to run the deployment setup.
 *
 * Asked by trying: describing a stack that does not exist answers "does not
 * exist" to a session that may use CloudFormation and `AccessDenied` to one that
 * may not. Anything else (throttling, a network error) answers "no", so a
 * passing hiccup never makes Terrablox create a role nobody needed.
 */
export async function needsSetupRole(
  credentials: AwsSessionCredentials,
  region: string,
): Promise<boolean> {
  const cfn = new CloudFormationClient({
    region,
    credentials: sdkCredentials(credentials),
  });
  try {
    await cfn.send(
      new DescribeStacksCommand({ StackName: "terrablox-permission-probe" }),
    );
    return false;
  } catch (error) {
    return isAccessDenied(error);
  }
}

/** The SSO role behind a session, with the path IAM needs in a trust policy. */
async function callerRoleArn(
  credentials: AwsSessionCredentials,
  region: string,
): Promise<string> {
  const sts = new STSClient({
    region,
    credentials: sdkCredentials(credentials),
  });
  const identity = await sts.send(new GetCallerIdentityCommand({}));
  const roleName = identity.Arn?.match(/:assumed-role\/([^/]+)\//)?.[1];
  if (!roleName) {
    throw new AwsConnectionError(
      "The sign-in is not an assumed role, so no setup role can trust it.",
      "unknown",
    );
  }
  // GetCallerIdentity drops the path (`/aws-reserved/sso.amazonaws.com/…`), and
  // a trust policy naming the role without it does not match.
  const iam = new IAMClient({
    region,
    credentials: sdkCredentials(credentials),
  });
  const role = await iam.send(new GetRoleCommand({ RoleName: roleName }));
  if (!role.Role?.Arn) {
    throw new AwsConnectionError(
      "IAM did not describe the SSO role.",
      "unknown",
    );
  }
  return role.Role.Arn;
}

/**
 * Creates the setup role, or brings an existing one back in line.
 *
 * Idempotent, and also the repair: the trust policy and the permissions are
 * rewritten every time. That covers a role somebody edited, and the case IAM
 * produces on its own: when a permission set is re-provisioned, its SSO role is
 * recreated with a new id, and a trust policy naming the old one stops matching
 * without anything visibly changing.
 *
 * Returns null when these credentials may not manage IAM roles. That is an
 * answer, not a failure: the caller then uses the sign-in as it is.
 */
export async function ensureSetupRole(
  credentials: AwsSessionCredentials,
  input: { accountId: string; ssoRoleName: string; region: string },
): Promise<string | null> {
  const iam = new IAMClient({
    region: input.region,
    credentials: sdkCredentials(credentials),
  });
  const roleName = setupRoleName(input.ssoRoleName);

  try {
    const ssoRoleArn = await callerRoleArn(credentials, input.region);
    const trust = trustPolicy(ssoRoleArn);

    let roleArn: string | undefined;
    try {
      const created = await iam.send(
        new CreateRoleCommand({
          RoleName: roleName,
          AssumeRolePolicyDocument: trust,
          Description:
            "Lets Terrablox run the deployment setup for an IAM-only SSO sign-in. Safe to delete; it is recreated on the next sign-in.",
          MaxSessionDuration: 3600,
          Tags: [
            { Key: "ManagedBy", Value: "Terrablox" },
            { Key: "TerrabloxPurpose", Value: "setup" },
          ],
        }),
      );
      roleArn = created.Role?.Arn;
    } catch (error) {
      if (errorName(error) !== "EntityAlreadyExistsException") throw error;
      await iam.send(
        new UpdateAssumeRolePolicyCommand({
          RoleName: roleName,
          PolicyDocument: trust,
        }),
      );
      roleArn = (await iam.send(new GetRoleCommand({ RoleName: roleName })))
        .Role?.Arn;
    }

    await iam.send(
      new PutRolePolicyCommand({
        RoleName: roleName,
        PolicyName: INLINE_POLICY_NAME,
        PolicyDocument: setupRolePolicy(input.accountId),
      }),
    );

    return roleArn ?? null;
  } catch (error) {
    if (isAccessDenied(error)) return null;
    throw new AwsConnectionError(
      `Could not prepare the setup role ${roleName}: ${errorMessage(error)}`,
      "unknown",
    );
  }
}

/**
 * Assumes the setup role with the sign-in's credentials.
 *
 * The same caps as an assumed connection role: reads get `ReadOnlyAccess` as a
 * session policy, an explicit policy replaces it, and only `write` drops it.
 * The SSO session alone could not be capped like this; the role can.
 *
 * Retried, because IAM is eventually consistent: a role that was created or had
 * its trust rewritten a moment ago is refused for a few seconds.
 */
export async function assumeSetupRole(
  credentials: AwsSessionCredentials,
  input: {
    roleArn: string;
    region: string;
    sessionSuffix: string;
    access: "read" | "write";
    sessionPolicy?: string;
    /** How long to keep retrying an `AccessDenied`, in milliseconds. */
    waitMs?: number;
  },
): Promise<AwsSessionCredentials> {
  const sts = new STSClient({
    region: input.region,
    credentials: sdkCredentials(credentials),
  });
  const deadline = Date.now() + (input.waitMs ?? 0);

  for (let attempt = 0; ; attempt++) {
    try {
      const assumed = await sts.send(
        new AssumeRoleCommand({
          RoleArn: input.roleArn,
          RoleSessionName: `terrablox-${input.sessionSuffix}`.slice(0, 64),
          DurationSeconds: SESSION_DURATION_SECONDS,
          ...(input.sessionPolicy
            ? { Policy: input.sessionPolicy }
            : {
                PolicyArns:
                  input.access === "write"
                    ? undefined
                    : [{ arn: READ_ONLY_POLICY_ARN }],
              }),
        }),
      );
      const c = assumed.Credentials;
      if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) {
        throw new AwsConnectionError(
          "AWS returned an incomplete session for the setup role.",
          "unknown",
        );
      }
      return {
        accessKeyId: c.AccessKeyId,
        secretAccessKey: c.SecretAccessKey,
        sessionToken: c.SessionToken,
        expiration: c.Expiration ?? null,
      };
    } catch (error) {
      if (error instanceof AwsConnectionError) throw error;
      if (isAccessDenied(error) && Date.now() < deadline) {
        await sleep(Math.min(1000 * 2 ** attempt, 4000));
        continue;
      }
      throw new AwsConnectionError(
        isAccessDenied(error)
          ? "AWS refused the Terrablox setup role. Disconnect and sign in again to recreate it."
          : errorMessage(error),
        isAccessDenied(error) ? "access-denied" : "unknown",
      );
    }
  }
}

/**
 * Removes the setup role. Best-effort: a role that is already gone is fine.
 *
 * Nothing depends on it once the setup has run. The deploy roles and state
 * buckets belong to the project stacks, and the next sign-in that needs a
 * setup role creates it again.
 */
export async function deleteSetupRole(
  credentials: AwsSessionCredentials,
  input: { roleArn: string; region: string },
): Promise<void> {
  const roleName = input.roleArn.split("/").pop();
  if (!roleName?.startsWith(ROLE_PREFIX)) return;

  const iam = new IAMClient({
    region: input.region,
    credentials: sdkCredentials(credentials),
  });
  const ignoreMissing = (error: unknown) => {
    if (errorName(error) !== "NoSuchEntityException") throw error;
  };

  await iam
    .send(
      new DeleteRolePolicyCommand({
        RoleName: roleName,
        PolicyName: INLINE_POLICY_NAME,
      }),
    )
    .catch(ignoreMissing);
  await iam
    .send(new DeleteRoleCommand({ RoleName: roleName }))
    .catch(ignoreMissing);
}
