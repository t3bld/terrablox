import "server-only";

import { randomBytes } from "node:crypto";

import {
  AssumeRoleCommand,
  GetCallerIdentityCommand,
  STSClient,
} from "@aws-sdk/client-sts";

/**
 * Cross-account access to a customer's AWS account.
 *
 * TerraBlox never receives AWS keys. The customer creates a role in their own
 * account that trusts this app's principal, and every request exchanges that
 * trust for a session that lives for minutes. Nothing to store, nothing to
 * rotate, and the customer can revoke it by deleting one role.
 */

/**
 * Who the customer's role must trust: this app's own AWS identity.
 *
 * It is a property of the deployment, not of the user — everyone on one
 * instance assumes roles as the same principal — so it can never be a
 * per-session value. The app already holds AWS credentials to do the assuming,
 * so it asks AWS who those credentials are instead of making an operator paste
 * in an ARN.
 */

let cachedPrincipal: string | null | undefined;

export async function resolveTerraBloxPrincipal(): Promise<string | null> {
  if (cachedPrincipal !== undefined) return cachedPrincipal;

  try {
    // GetCallerIdentity is global, so any region answers; the SDK just needs
    // one, and its own resolution chain (environment, shared config, instance
    // metadata) is the right place to find it.
    const sts = new STSClient({});
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    cachedPrincipal = identity.Arn ? toTrustPrincipal(identity.Arn) : null;
  } catch {
    // No credentials wired up yet: the account card still explains what to do.
    cachedPrincipal = null;
  }

  return cachedPrincipal;
}

/**
 * Whether this instance can assume anything at all, answered before the user
 * invests a device login in finding out.
 *
 * The role a connection creates has to name a principal in its trust policy,
 * so an instance without an AWS identity of its own cannot produce a usable
 * connection — a fact worth stating on the settings page rather than at the
 * end of the flow.
 */
export async function describeAppIdentity(): Promise<{
  configured: boolean;
  principalArn: string | null;
}> {
  const principalArn = await resolveTerraBloxPrincipal();
  return { configured: principalArn !== null, principalArn };
}

/**
 * A trust policy names the role, not the momentary session.
 *
 * Under a task or instance role, GetCallerIdentity answers with an assumed-role
 * ARN (`…:assumed-role/Name/session`), which IAM rejects as a Principal.
 * Rewrite it to the role it came from; user and root ARNs are already valid and
 * pass straight through.
 */
function toTrustPrincipal(callerArn: string): string {
  const assumed = callerArn.match(
    /^arn:(aws(?:-[a-z]+)*):sts::(\d{12}):assumed-role\/([^/]+)\//,
  );
  if (!assumed) return callerArn;

  const [, partition, account, roleName] = assumed;
  return `arn:${partition}:iam::${account}:role/${roleName}`;
}

/** Sessions are only used for reads inside one request; minutes are plenty. */
const SESSION_DURATION_SECONDS = 900;

/**
 * Read-only even if the customer's role is not.
 *
 * A session policy can only narrow what the role already allows, so this caps
 * the damage of a customer who attached AdministratorAccess to the role and of
 * any future bug in this app that calls a mutating API by mistake.
 */
const READ_ONLY_POLICY_ARN = "arn:aws:iam::aws:policy/ReadOnlyAccess";

const ROLE_ARN_PATTERN =
  /^arn:aws(-[a-z]+)*:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/;

/** AWS accepts far more, but anything else here is a typo or an injection try. */
const REGION_PATTERN = /^[a-z]{2}(-[a-z]+)+-\d$/;

export function isValidRoleArn(value: string): boolean {
  return ROLE_ARN_PATTERN.test(value.trim());
}

export function isValidRegion(value: string): boolean {
  return REGION_PATTERN.test(value.trim());
}

/**
 * The secret that ties a role to one TerraBlox connection.
 *
 * Random rather than derived from the user or account id: a guessable external
 * id is the same as none at all, because the whole point is that a third party
 * cannot make TerraBlox assume a role it learned the ARN of.
 */
export function generateExternalId(): string {
  return randomBytes(24).toString("base64url");
}

export class AwsConnectionError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "AwsConnectionError";
    this.code = code;
  }
}

export interface AssumedIdentity {
  accountId: string;
  arn: string;
  userId: string;
}

/** A short-lived session, in the shape every AWS SDK client accepts. */
export interface AwsSessionCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: Date | null;
}

/** Turns AWS's wording into something a user can act on. */
function describeFailure(error: unknown): AwsConnectionError {
  const name =
    typeof error === "object" && error !== null && "name" in error
      ? String((error as { name: unknown }).name)
      : "";

  if (name === "AccessDenied" || name === "AccessDeniedException") {
    return new AwsConnectionError(
      "AWS refused the role. Check that the trust policy names this app's principal and the exact external ID shown here.",
      "access-denied",
    );
  }

  if (name === "CredentialsProviderError") {
    return new AwsConnectionError(
      "This TerraBlox instance has no AWS credentials of its own, so it cannot assume a role. Give the app an AWS identity (a task role or access keys).",
      "not-configured",
    );
  }

  return new AwsConnectionError(
    error instanceof Error ? error.message : "Could not reach AWS.",
    "unknown",
  );
}

export interface AssumeConnectionParams {
  roleArn: string;
  externalId: string;
  region: string;
  /** Ends up in CloudTrail on the customer's side, so keep it identifying. */
  sessionSuffix: string;
  /**
   * Anything the app does on its own initiative reads; only an action the user
   * asked for by name may write, and it has to say so here.
   */
  access?: "read" | "write";
  /**
   * An inline session policy, used instead of the read-only cap.
   *
   * Only for reads that the managed `ReadOnlyAccess` policy cannot express.
   * Reading the Terraform state is the case this exists for: the object is
   * encrypted with a customer-managed key, and `ReadOnlyAccess` deliberately
   * excludes `kms:Decrypt`, so a capped session gets `AccessDenied` on every
   * `GetObject`. A policy naming that one object and that one key is narrower
   * than the cap it replaces, not wider — which is the only reason this is
   * allowed to exist.
   */
  sessionPolicy?: string;
}

/**
 * A session that may read exactly one object, decrypting it with exactly one key.
 *
 * Written out rather than assembled from `ReadOnlyAccess` because the two
 * cannot be combined: session policies intersect, so adding `kms:Decrypt`
 * alongside the managed policy would still be denied by it.
 */
export function stateReadPolicy(params: {
  bucket: string;
  key: string;
  kmsKeyArn: string | null;
}): string {
  const statements: unknown[] = [
    {
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:GetObjectVersion"],
      Resource: `arn:aws:s3:::${params.bucket}/${params.key}`,
    },
    {
      Effect: "Allow",
      Action: "s3:ListBucket",
      Resource: `arn:aws:s3:::${params.bucket}`,
    },
  ];

  // Absent on a bucket that still uses S3-managed encryption, where the object
  // needs no key of its own.
  if (params.kmsKeyArn) {
    statements.push({
      Effect: "Allow",
      Action: ["kms:Decrypt", "kms:DescribeKey"],
      Resource: params.kmsKeyArn,
    });
  }

  return JSON.stringify({ Version: "2012-10-17", Statement: statements });
}

/**
 * Assumes the connected role and hands back the session itself.
 *
 * Separate from {@link assumeConnection} because callers that want to *read
 * something* need the credentials, not just the identity, and re-implementing
 * the read-only cap per caller is how that cap eventually gets forgotten.
 */
export async function assumeConnectionSession(
  params: AssumeConnectionParams,
): Promise<AwsSessionCredentials> {
  if (!isValidRoleArn(params.roleArn)) {
    throw new AwsConnectionError(
      "That is not a valid IAM role ARN.",
      "invalid",
    );
  }

  if (!isValidRegion(params.region)) {
    throw new AwsConnectionError("That is not a valid AWS region.", "invalid");
  }

  const sts = new STSClient({ region: params.region });

  try {
    const assumed = await sts.send(
      new AssumeRoleCommand({
        RoleArn: params.roleArn,
        ExternalId: params.externalId,
        // Truncated because AWS rejects session names over 64 characters.
        RoleSessionName: `terrablox-${params.sessionSuffix}`.slice(0, 64),
        DurationSeconds: SESSION_DURATION_SECONDS,
        // An explicit policy replaces the cap rather than joining it: session
        // policies intersect, so the two together would deny what the caller
        // asked for.
        ...(params.sessionPolicy
          ? { Policy: params.sessionPolicy }
          : {
              // A write session is still bounded by whatever the customer's role
              // allows; dropping the cap only stops this app from vetoing itself.
              PolicyArns:
                params.access === "write"
                  ? undefined
                  : [{ arn: READ_ONLY_POLICY_ARN }],
            }),
      }),
    );

    const credentials = assumed.Credentials;
    if (
      !credentials?.AccessKeyId ||
      !credentials.SecretAccessKey ||
      !credentials.SessionToken
    ) {
      throw new AwsConnectionError(
        "AWS returned an incomplete session.",
        "unknown",
      );
    }

    return {
      accessKeyId: credentials.AccessKeyId,
      secretAccessKey: credentials.SecretAccessKey,
      sessionToken: credentials.SessionToken,
      expiration: credentials.Expiration ?? null,
    };
  } catch (error) {
    if (error instanceof AwsConnectionError) throw error;
    throw describeFailure(error);
  }
}

/**
 * Assumes the connected role and reports who we became.
 *
 * Also the verification step: if this succeeds, the trust policy and the
 * external ID line up, which is the only proof that matters.
 */
export async function assumeConnection(
  params: AssumeConnectionParams,
): Promise<AssumedIdentity> {
  const credentials = await assumeConnectionSession(params);

  try {
    const scoped = new STSClient({
      region: params.region,
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        sessionToken: credentials.sessionToken,
      },
    });

    const identity = await scoped.send(new GetCallerIdentityCommand({}));

    if (!identity.Account || !identity.Arn || !identity.UserId) {
      throw new AwsConnectionError(
        "AWS did not report an identity for the session.",
        "unknown",
      );
    }

    return {
      accountId: identity.Account,
      arn: identity.Arn,
      userId: identity.UserId,
    };
  } catch (error) {
    if (error instanceof AwsConnectionError) throw error;
    throw describeFailure(error);
  }
}

/**
 * The role the customer has to create, as a CloudFormation stack.
 *
 * Read-only on purpose. Changing infrastructure stays with the pipeline, where
 * it is written down in Terraform and leaves a run log, instead of happening
 * through an API call nobody reviewed.
 */
export function renderConnectionTemplate(params: {
  externalId: string;
  principalArn: string | null;
  label: string;
}): string {
  const principal = params.principalArn ?? "<TerraBlox principal ARN>";

  return `AWSTemplateFormatVersion: "2010-09-09"
Description: >-
  Read-only access for TerraBlox${params.label ? ` (${params.label})` : ""}.
  Creates one role that TerraBlox can assume to show what exists in this
  account. It grants no permission to change anything.

Resources:
  TerraBloxReadRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: terrablox-read
      Description: Assumed by TerraBlox to read this account's inventory.
      MaxSessionDuration: 3600
      AssumeRolePolicyDocument:
        Version: "2012-10-17"
        Statement:
          - Effect: Allow
            Principal:
              AWS: ${principal}
            Action: sts:AssumeRole
            Condition:
              StringEquals:
                # Unique to this connection. Without it, anyone who learns the
                # role ARN could have TerraBlox assume it for them.
                sts:ExternalId: "${params.externalId}"
      ManagedPolicyArns:
        - ${READ_ONLY_POLICY_ARN}

Outputs:
  RoleArn:
    Description: Paste this back into TerraBlox.
    Value: !GetAtt TerraBloxReadRole.Arn
`;
}
