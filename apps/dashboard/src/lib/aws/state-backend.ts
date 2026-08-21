import "server-only";

import {
  CreateBucketCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutBucketEncryptionCommand,
  PutBucketVersioningCommand,
  PutPublicAccessBlockCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import { AwsConnectionError } from "./connection";
import { type ProjectAwsSession, toClientCredentials } from "./credentials";

/**
 * The Terraform state backend, seen through the AWS API instead of through the
 * pipeline.
 *
 * Until now the only thing that knew whether the backend existed was a
 * workflow run, so a misconfigured bucket surfaced as a failed apply minutes
 * later. Asking S3 directly turns that into an answer the settings page can
 * give while the user is still looking at the field they typed it into.
 */

/** Bucket names are DNS labels; S3 rejects anything else with a vague error. */
const BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

export function isValidBucketName(value: string): boolean {
  return BUCKET_NAME_PATTERN.test(value) && !value.includes("..");
}

export interface StateBackendStatus {
  bucket: string;
  key: string;
  region: string;
  /** Null when the bucket exists but belongs to somebody else. */
  exists: boolean;
  versioning: boolean;
  /** The state object itself, absent before the first successful apply. */
  state: { size: number; lastModified: string | null } | null;
  /** Set when the account could be reached but this bucket could not be read. */
  problem: string | null;
}

function client(session: ProjectAwsSession): S3Client {
  return new S3Client({
    region: session.region,
    credentials: toClientCredentials(session),
  });
}

function errorName(error: unknown): string {
  return typeof error === "object" && error !== null && "name" in error
    ? String((error as { name: unknown }).name)
    : "";
}

/**
 * Reports what is actually in the account, without creating anything.
 *
 * Runs on a read-only session, so it is safe to call on every page load: the
 * worst it can do is say "not there yet".
 */
export async function inspectStateBackend(
  session: ProjectAwsSession,
  input: { bucket: string; key: string },
): Promise<StateBackendStatus> {
  const base: StateBackendStatus = {
    bucket: input.bucket,
    key: input.key,
    region: session.region,
    exists: false,
    versioning: false,
    state: null,
    problem: null,
  };

  if (!isValidBucketName(input.bucket)) {
    return { ...base, problem: "That is not a valid S3 bucket name." };
  }

  const s3 = client(session);

  try {
    await s3.send(new HeadBucketCommand({ Bucket: input.bucket }));
  } catch (error) {
    const name = errorName(error);
    if (name === "NotFound" || name === "NoSuchBucket") return base;
    if (name === "Forbidden" || name === "AccessDenied") {
      return {
        ...base,
        problem:
          "That bucket exists but this account may not read it. It probably belongs to someone else — pick another name.",
      };
    }
    return {
      ...base,
      problem:
        error instanceof Error ? error.message : "Could not reach the bucket.",
    };
  }

  // Versioning is the only way back from a bad apply, so it is worth reporting
  // separately rather than folding into "exists".
  let versioning = false;
  try {
    const result = await s3.send(
      new GetBucketVersioningCommand({ Bucket: input.bucket }),
    );
    versioning = result.Status === "Enabled";
  } catch {
    // A bucket readable but not describable is still usable for state.
  }

  let state: StateBackendStatus["state"] = null;
  try {
    const head = await s3.send(
      new HeadObjectCommand({ Bucket: input.bucket, Key: input.key }),
    );
    state = {
      size: head.ContentLength ?? 0,
      lastModified: head.LastModified?.toISOString() ?? null,
    };
  } catch {
    // No state object yet simply means nothing has been applied.
  }

  return { ...base, exists: true, versioning, state };
}

/** The state object as bytes, plus how current it is. */
export interface StateObject {
  body: string;
  lastModified: string | null;
}

/**
 * Reads the state object itself.
 *
 * The one call in the app that retrieves unredacted Terraform state, which is
 * why it wants a session narrowed to exactly this object — see
 * `stateReadPolicy`. The body goes straight to a parser that keeps identifiers
 * and drops everything else; it must not be returned to a client or logged.
 *
 * The size cap is a guard, not a limit anybody should hit: a state large enough
 * to trip it would take the tab down anyway, and refusing is more useful than
 * running out of memory.
 */
const MAX_STATE_BYTES = 32 * 1024 * 1024;

export async function readStateObject(
  session: ProjectAwsSession,
  input: { bucket: string; key: string },
): Promise<StateObject | null> {
  if (!isValidBucketName(input.bucket)) {
    throw new AwsConnectionError(
      "That is not a valid S3 bucket name.",
      "invalid",
    );
  }

  try {
    const result = await client(session).send(
      new GetObjectCommand({ Bucket: input.bucket, Key: input.key }),
    );

    if ((result.ContentLength ?? 0) > MAX_STATE_BYTES) {
      throw new AwsConnectionError(
        "That Terraform state is too large to read here. Use the AWS console.",
        "too-large",
      );
    }

    const body = await result.Body?.transformToString();
    if (!body) return null;

    return {
      body,
      lastModified: result.LastModified?.toISOString() ?? null,
    };
  } catch (error) {
    if (error instanceof AwsConnectionError) throw error;

    const name = errorName(error);
    // Nothing applied yet is the ordinary early state, not a failure.
    if (name === "NoSuchKey" || name === "NotFound") return null;

    if (name === "AccessDenied") {
      throw new AwsConnectionError(
        "The connected AWS identity may not read the Terraform state. It needs s3:GetObject on the state object and kms:Decrypt on the key that encrypts it — with IAM Identity Center, that has to come from the permission set you signed in with.",
        "denied",
      );
    }

    if (name === "NoSuchBucket") {
      throw new AwsConnectionError(
        "The state bucket does not exist. Run the state step in the Deploy tab.",
        "invalid",
      );
    }

    throw new AwsConnectionError(
      error instanceof Error ? error.message : "Could not read the state.",
      "unknown",
    );
  }
}

/**
 * Creates the state bucket the pipeline expects, hardened the same way the
 * bootstrap template does it.
 *
 * Deliberately separate from {@link inspectStateBackend} and reachable only
 * from an explicit user action: this is the one place the website writes to a
 * customer account outside the pipeline, and it should stay easy to find.
 */
export async function createStateBucket(
  session: ProjectAwsSession,
  input: { bucket: string },
): Promise<void> {
  if (!isValidBucketName(input.bucket)) {
    throw new AwsConnectionError(
      "That is not a valid S3 bucket name. Use lowercase letters, digits and dashes.",
      "invalid",
    );
  }

  const s3 = client(session);

  try {
    await s3.send(
      new CreateBucketCommand({
        Bucket: input.bucket,
        // us-east-1 is the one region S3 rejects as a location constraint.
        CreateBucketConfiguration:
          session.region === "us-east-1"
            ? undefined
            : { LocationConstraint: session.region as never },
      }),
    );
  } catch (error) {
    const name = errorName(error);
    if (name === "BucketAlreadyOwnedByYou") return;
    if (name === "BucketAlreadyExists") {
      throw new AwsConnectionError(
        "That bucket name is taken by another AWS account. S3 names are global — choose another.",
        "duplicate",
      );
    }
    if (name === "AccessDenied") {
      throw new AwsConnectionError(
        "The connected role may not create buckets. Widen its policy or create the bucket yourself.",
        "denied",
      );
    }
    throw new AwsConnectionError(
      error instanceof Error ? error.message : "Could not create the bucket.",
      "unknown",
    );
  }

  // Every apply overwrites the state, and it holds generated passwords in clear
  // text; a bucket without these two is a bucket nobody should keep state in.
  await s3.send(
    new PutBucketVersioningCommand({
      Bucket: input.bucket,
      VersioningConfiguration: { Status: "Enabled" },
    }),
  );

  await s3.send(
    new PutBucketEncryptionCommand({
      Bucket: input.bucket,
      ServerSideEncryptionConfiguration: {
        Rules: [
          { ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
        ],
      },
    }),
  );

  await s3.send(
    new PutPublicAccessBlockCommand({
      Bucket: input.bucket,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    }),
  );
}
