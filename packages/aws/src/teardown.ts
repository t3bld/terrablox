import {
  DescribeKeyCommand,
  KMSClient,
  ScheduleKeyDeletionCommand,
} from "@aws-sdk/client-kms";
import {
  DeleteBucketCommand,
  DeleteObjectsCommand,
  GetBucketEncryptionCommand,
  GetBucketTaggingCommand,
  HeadBucketCommand,
  ListBucketsCommand,
  ListObjectVersionsCommand,
  type ObjectIdentifier,
  S3Client,
} from "@aws-sdk/client-s3";
import { AwsConnectionError } from "./connection";
import { type ProjectAwsSession, toClientCredentials } from "./session";

/**
 * Removing what the state stack leaves behind on purpose.
 *
 * The state stack marks its bucket and key `Retain`, so deleting the stack is
 * safe on its own and never loses state. Tearing a whole setup down is the one
 * case where the user wants exactly that loss, and CloudFormation cannot do it:
 * it will not delete a bucket that still holds objects, and a retained resource
 * is not deleted at all. So this does it directly, and only for buckets the
 * project's own stack provably created.
 */

/** The tag CloudFormation puts on every resource it creates. */
const STACK_NAME_TAG = "aws:cloudformation:stack-name";

/** KMS's minimum. A key cannot be deleted immediately. */
export const KEY_DELETION_WINDOW_DAYS = 7;

function s3(session: ProjectAwsSession): S3Client {
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asConnectionError(error: unknown, what: string): AwsConnectionError {
  return new AwsConnectionError(
    `Could not ${what}: ${errorMessage(error)}`,
    errorName(error) === "AccessDenied" ? "denied" : "failed",
  );
}

/** Whether the bucket is there and readable from this session. */
export async function bucketExists(
  session: ProjectAwsSession,
  bucket: string,
): Promise<boolean> {
  try {
    await s3(session).send(new HeadBucketCommand({ Bucket: bucket }));
    return true;
  } catch {
    return false;
  }
}

/**
 * State buckets in this account and region that one of the given stacks created.
 *
 * Two filters, and the second is the one that makes this safe to delete from.
 * The prefix only narrows the listing: it is derived from the project's name, and
 * two projects can share a name. The CloudFormation tag is the proof of ownership,
 * because a stack name can only exist once per account and region.
 *
 * Exists because deleting the state stack used to clear the project's pointer to
 * the bucket while the bucket itself stayed behind, so nothing in the app knew
 * about it any more.
 */
export async function findStackBuckets(
  session: ProjectAwsSession,
  input: { prefix: string; stackNames: string[] },
): Promise<string[]> {
  const client = s3(session);
  const candidates: string[] = [];

  try {
    let token: string | undefined;
    do {
      const page = await client.send(
        new ListBucketsCommand({
          Prefix: input.prefix,
          BucketRegion: session.region,
          ContinuationToken: token,
          MaxBuckets: 1000,
        }),
      );
      for (const bucket of page.Buckets ?? []) {
        if (bucket.Name?.startsWith(input.prefix)) {
          candidates.push(bucket.Name);
        }
      }
      token = page.ContinuationToken;
    } while (token);
  } catch (error) {
    throw asConnectionError(error, "list the account's S3 buckets");
  }

  const owned: string[] = [];
  for (const name of candidates) {
    try {
      const tagging = await client.send(
        new GetBucketTaggingCommand({ Bucket: name }),
      );
      const stack = tagging.TagSet?.find(
        (tag) => tag.Key === STACK_NAME_TAG,
      )?.Value;
      if (stack && input.stackNames.includes(stack)) owned.push(name);
    } catch {
      // No tags, or not readable: not provably ours, so not ours to delete.
    }
  }
  return owned;
}

/** The customer-managed key a bucket encrypts with by default, if any. */
export async function bucketKmsKey(
  session: ProjectAwsSession,
  bucket: string,
): Promise<string | null> {
  try {
    const result = await s3(session).send(
      new GetBucketEncryptionCommand({ Bucket: bucket }),
    );
    for (const rule of result.ServerSideEncryptionConfiguration?.Rules ?? []) {
      const key = rule.ApplyServerSideEncryptionByDefault?.KMSMasterKeyID;
      if (key) return key;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Deletes every object version and delete marker, then the bucket.
 *
 * Versions as well as objects: the state bucket is versioned, and S3 refuses to
 * delete a bucket that still holds old versions. Idempotent, so a teardown that
 * was interrupted half-way can simply be run again.
 */
export async function deleteBucketCompletely(
  session: ProjectAwsSession,
  bucket: string,
): Promise<void> {
  const client = s3(session);

  try {
    let keyMarker: string | undefined;
    let versionMarker: string | undefined;
    do {
      const page = await client.send(
        new ListObjectVersionsCommand({
          Bucket: bucket,
          KeyMarker: keyMarker,
          VersionIdMarker: versionMarker,
          MaxKeys: 1000,
        }),
      );

      const objects: ObjectIdentifier[] = [
        ...(page.Versions ?? []),
        ...(page.DeleteMarkers ?? []),
      ].flatMap((entry) =>
        entry.Key ? [{ Key: entry.Key, VersionId: entry.VersionId }] : [],
      );

      if (objects.length > 0) {
        const result = await client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: objects, Quiet: true },
          }),
        );
        const failed = result.Errors?.[0];
        if (failed) {
          throw new Error(
            `${failed.Key ?? "an object"}: ${failed.Message ?? failed.Code ?? "refused"}`,
          );
        }
      }

      keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
      versionMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
    } while (keyMarker);

    await client.send(new DeleteBucketCommand({ Bucket: bucket }));
  } catch (error) {
    if (errorName(error) === "NoSuchBucket") return;
    throw asConnectionError(error, `delete the bucket ${bucket}`);
  }
}

/**
 * Schedules a customer-managed key for deletion after the shortest window KMS
 * allows.
 *
 * Scheduled rather than deleted because KMS offers nothing else, and the window
 * is the only undo: until it ends, the key can be restored in the console. A key
 * that AWS manages, or one already pending deletion, is left alone.
 */
export async function scheduleKeyDeletion(
  session: ProjectAwsSession,
  keyArn: string,
): Promise<{ scheduled: boolean; deletionDate: string | null }> {
  // The key's own region, which is the bucket's, and normally the session's.
  const region = keyArn.startsWith("arn:")
    ? (keyArn.split(":")[3] ?? session.region)
    : session.region;
  const kms = new KMSClient({
    region,
    credentials: toClientCredentials(session),
  });

  try {
    const described = await kms.send(new DescribeKeyCommand({ KeyId: keyArn }));
    const metadata = described.KeyMetadata;
    if (!metadata || metadata.KeyManager !== "CUSTOMER") {
      return { scheduled: false, deletionDate: null };
    }
    if (metadata.KeyState === "PendingDeletion") {
      return {
        scheduled: true,
        deletionDate: metadata.DeletionDate?.toISOString() ?? null,
      };
    }

    const result = await kms.send(
      new ScheduleKeyDeletionCommand({
        KeyId: keyArn,
        PendingWindowInDays: KEY_DELETION_WINDOW_DAYS,
      }),
    );
    return {
      scheduled: true,
      deletionDate: result.DeletionDate?.toISOString() ?? null,
    };
  } catch (error) {
    if (errorName(error) === "NotFoundException") {
      return { scheduled: false, deletionDate: null };
    }
    throw asConnectionError(error, "schedule the state key for deletion");
  }
}
