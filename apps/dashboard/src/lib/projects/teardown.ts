import {
  deleteBootstrapStack,
  describeBootstrapStack,
} from "@terrablox/aws/bootstrap";
import type { ProjectAwsSession } from "@terrablox/aws/session";
import { readStateObject } from "@terrablox/aws/state-backend";
import {
  bucketExists,
  bucketKmsKey,
  deleteBucketCompletely,
  findStackBuckets,
  KEY_DELETION_WINDOW_DAYS,
  scheduleKeyDeletion,
} from "@terrablox/aws/teardown";
import type { Project } from "@terrablox/database";
import { database } from "@/lib/database";
import { stateBucketPrefix, stateKey, stateStackName } from "./deploy";
import { roleStackNameOf, stateStackNameOf } from "./deploy-service";
import { parseTerraformState } from "./tfstate";

/**
 * Removing a project's whole deployment setup from AWS, so it can be built again
 * from nothing.
 *
 * Deleting one stack at a time could not do that. The state stack retains its
 * bucket and key, and deleting it also made the project forget the bucket's name,
 * so the bucket stayed in the account with nothing left that knew about it. A
 * teardown covers both stacks and everything they retain, and it finds buckets an
 * earlier setup left behind by the tag CloudFormation put on them.
 *
 * It runs in phases because CloudFormation deletes asynchronously, and the bucket
 * has to wait for its stack: the stack's bucket policy is deleted with the stack,
 * and deleting the bucket underneath it can fail the stack's own deletion.
 * Every call does what is possible right now and says what is left, so the
 * caller repeats it until it reports `done`, and an interrupted teardown resumes
 * by running it again.
 *
 * The account's GitHub identity provider is left alone. It is shared by every
 * project in the account and retained by design.
 */

export interface TeardownBucket {
  name: string;
  kmsKeyArn: string | null;
  /** Left behind by an earlier setup: the project no longer records it. */
  orphaned: boolean;
  /**
   * Managed resources the Terraform state in it still tracks, or null when the
   * state could not be read. Infrastructure keeps running after a teardown;
   * Terraform just stops knowing it exists.
   */
  trackedResources: number | null;
}

export interface TeardownPlan {
  roleStack: { name: string; status: string } | null;
  stateStack: { name: string; status: string } | null;
  buckets: TeardownBucket[];
  keyDeletionDays: number;
}

export interface TeardownProgress {
  done: boolean;
  /** Stacks CloudFormation is still deleting. */
  waitingFor: string[];
  deletedBuckets: string[];
  scheduledKeys: { arn: string; deletionDate: string | null }[];
  /** Stacks this call asked CloudFormation to delete. */
  requestedDeletes: string[];
  /** Why a stack could not be deleted, when CloudFormation said so. */
  problems: string[];
}

/** The names this project's state stack has had, current one first. */
function stateStackNames(project: Project): string[] {
  return [
    ...new Set([stateStackNameOf(project), stateStackName(project.name)]),
  ];
}

/**
 * The project's state buckets that are still in the account.
 *
 * The recorded bucket, plus any bucket an earlier setup of this project's state
 * stack created. Buckets another project records as its own are excluded even
 * when the tag matches, as a second guard against deleting the wrong state.
 */
async function leftoverBuckets(
  session: ProjectAwsSession,
  project: Project,
): Promise<{ name: string; kmsKeyArn: string | null }[]> {
  const names = new Set<string>();

  if (
    project.stateBucket &&
    (await bucketExists(session, project.stateBucket))
  ) {
    names.add(project.stateBucket);
  }

  if (session.accountId) {
    const found = await findStackBuckets(session, {
      prefix: stateBucketPrefix(project.name, session.accountId),
      stackNames: stateStackNames(project),
    });
    for (const name of found) names.add(name);
  }

  if (names.size === 0) return [];

  const claimed = await database.project.findMany({
    where: { stateBucket: { in: [...names] }, id: { not: project.id } },
    select: { stateBucket: true },
  });
  for (const other of claimed) {
    if (other.stateBucket) names.delete(other.stateBucket);
  }

  return Promise.all(
    [...names].map(async (name) => ({
      name,
      kmsKeyArn:
        (await bucketKmsKey(session, name)) ??
        (name === project.stateBucket ? project.stateKmsKeyArn : null),
    })),
  );
}

/** Buckets an earlier setup left behind, which this project no longer records. */
export async function orphanedStateBuckets(
  session: ProjectAwsSession,
  project: Project,
): Promise<string[]> {
  const buckets = await leftoverBuckets(session, project);
  return buckets
    .map((bucket) => bucket.name)
    .filter((name) => name !== project.stateBucket);
}

async function countTrackedResources(
  session: ProjectAwsSession,
  bucket: string,
  key: string,
): Promise<number | null> {
  try {
    const object = await readStateObject(session, { bucket, key });
    if (!object) return 0;
    const snapshot = parseTerraformState(object.body, {
      lastModified: object.lastModified,
    });
    return snapshot
      ? snapshot.resources.filter((resource) => resource.mode === "managed")
          .length
      : null;
  } catch {
    return null;
  }
}

/** What a teardown would remove. Read-only. */
export async function teardownPlan(
  session: ProjectAwsSession,
  project: Project,
): Promise<TeardownPlan> {
  const [role, state, buckets] = await Promise.all([
    describeBootstrapStack(session, roleStackNameOf(project)),
    describeBootstrapStack(session, stateStackNameOf(project)),
    leftoverBuckets(session, project),
  ]);

  const key = stateKey(project.name);

  return {
    roleStack: role ? { name: role.stackName, status: role.status } : null,
    stateStack: state ? { name: state.stackName, status: state.status } : null,
    buckets: await Promise.all(
      buckets.map(async (bucket) => ({
        ...bucket,
        orphaned: bucket.name !== project.stateBucket,
        trackedResources: await countTrackedResources(
          session,
          bucket.name,
          key,
        ),
      })),
    ),
    keyDeletionDays: KEY_DELETION_WINDOW_DAYS,
  };
}

/**
 * Does the next part of the teardown and reports what is left.
 *
 * Clears the project's pointers only once everything is gone. Clearing them
 * earlier is what lost track of the bucket before, and it would also stop an
 * interrupted teardown from finding the stacks it still has to wait for.
 */
export async function advanceTeardown(
  session: ProjectAwsSession,
  project: Project,
  /**
   * Ask CloudFormation again for a stack whose deletion failed.
   *
   * Only on an explicit retry. Retrying on its own turned a stack that cannot be
   * deleted into a loop of requests, each failing the same way, with the reason
   * replaced by "in progress" half the time.
   */
  options: { retryFailed?: boolean } = {},
): Promise<TeardownProgress> {
  const problems: string[] = [];
  const waitingFor: string[] = [];
  const requestedDeletes: string[] = [];

  const stacks = await Promise.all(
    [roleStackNameOf(project), stateStackNameOf(project)].map((name) =>
      describeBootstrapStack(session, name),
    ),
  );

  for (const stack of stacks) {
    if (!stack) continue;
    waitingFor.push(stack.stackName);

    // Anything still moving is waited out rather than interrupted. CloudFormation
    // refuses to delete a stack mid-update, and a rollback in progress would
    // only fail the request; the next round finds it settled.
    if (stack.status.endsWith("_IN_PROGRESS")) continue;
    if (stack.status === "DELETE_FAILED" && !options.retryFailed) {
      problems.push(
        `${stack.stackName}: ${stack.statusReason ?? "CloudFormation could not delete it."}`,
      );
      continue;
    }
    await deleteBootstrapStack(session, stack.stackName);
    requestedDeletes.push(stack.stackName);
  }

  const stateStackGone = stacks[1] === null;
  const deletedBuckets: string[] = [];
  const scheduledKeys: TeardownProgress["scheduledKeys"] = [];

  if (stateStackGone) {
    for (const bucket of await leftoverBuckets(session, project)) {
      await deleteBucketCompletely(session, bucket.name);
      deletedBuckets.push(bucket.name);

      // After the bucket, never before: a key scheduled for deletion is
      // disabled at once, and the bucket's objects would then be unreadable in
      // the window in which a failed delete could still leave them behind.
      if (bucket.kmsKeyArn) {
        const result = await scheduleKeyDeletion(session, bucket.kmsKeyArn);
        if (result.scheduled) {
          scheduledKeys.push({
            arn: bucket.kmsKeyArn,
            deletionDate: result.deletionDate,
          });
        }
      }
    }

    // A key the project recorded whose bucket is already gone.
    if (
      project.stateKmsKeyArn &&
      !scheduledKeys.some((key) => key.arn === project.stateKmsKeyArn)
    ) {
      const result = await scheduleKeyDeletion(session, project.stateKmsKeyArn);
      if (result.scheduled) {
        scheduledKeys.push({
          arn: project.stateKmsKeyArn,
          deletionDate: result.deletionDate,
        });
      }
    }
  }

  const done = waitingFor.length === 0;

  if (done) {
    await database.project.update({
      where: { id: project.id },
      data: {
        awsRoleArn: null,
        stateBucket: null,
        stateLockTable: null,
        stateKmsKeyArn: null,
        roleStackName: null,
        stateStackName: null,
        stateKmsAlias: null,
      },
    });
  }

  return {
    done,
    waitingFor,
    deletedBuckets,
    scheduledKeys,
    requestedDeletes,
    problems,
  };
}
