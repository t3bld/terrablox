import "server-only";

import {
  AwsConnectionError,
  assumeConnectionSession,
} from "@terrablox/aws/connection";
import type { AwsSessionCredentials } from "@terrablox/aws/session";
import {
  assumeSetupRole,
  deleteSetupRole,
  ensureSetupRole,
  needsSetupRole,
} from "@terrablox/aws/setup-role";
import { getSsoRoleCredentials } from "@terrablox/aws/sso";
import type { AwsConnection, Project } from "@terrablox/database";
import { decryptSecret } from "@/lib/crypto/secret-box";
import { database } from "@/lib/database";

/**
 * One place that answers "can this request talk to the customer's AWS account,
 * and with whose hands?".
 *
 * Every AWS call the website makes goes through here, so the read-only cap in
 * {@link assumeConnectionSession} can never be bypassed by a new feature that
 * builds its own client. Sessions live for the length of one request and are
 * never written down.
 */

/**
 * Turns a stored connection into live credentials, whichever way it was made.
 *
 * In `sso` mode the requested access level is advisory: the permission set the
 * user signed in with is the real limit, and Terrablox cannot narrow it the way
 * it narrows an assumed role. The exception is a sign-in with a setup role
 * (`ssoSetupRoleArn`): that role is assumed, so the same caps apply to it.
 */
export async function sessionForConnection(
  connection: AwsConnection,
  options: {
    region: string;
    sessionSuffix: string;
    access: "read" | "write";
    /** Replaces the read-only cap; see {@link assumeConnectionSession}. */
    sessionPolicy?: string;
  },
): Promise<AwsSessionCredentials> {
  if (connection.credentialMode !== "sso") {
    return assumeConnectionSession({
      roleArn: connection.roleArn,
      externalId: connection.externalId,
      region: options.region,
      sessionSuffix: options.sessionSuffix,
      access: options.access,
      sessionPolicy: options.sessionPolicy,
    });
  }

  if (
    !connection.ssoRegion ||
    !connection.ssoAccessTokenCiphertext ||
    !connection.ssoRoleName ||
    !connection.accountId
  ) {
    throw new AwsConnectionError(
      "That AWS connection is incomplete. Sign in again to reconnect it.",
      "invalid",
    );
  }

  if (
    connection.ssoExpiresAt &&
    connection.ssoExpiresAt.getTime() < Date.now()
  ) {
    throw new AwsConnectionError(
      "That AWS sign-in has expired. Sign in again to reconnect the account.",
      "expired",
    );
  }

  const accessToken = decryptSecret(connection.ssoAccessTokenCiphertext);

  // Reported as expired rather than as a fault, and deliberately: a token stored
  // under an older BETTER_AUTH_SECRET is exactly as useful as one that ran out,
  // and signing in again is the cure the user already knows for that state. The
  // alternative — an "internal error" — sends them looking for a bug in AWS.
  if (!accessToken) {
    throw new AwsConnectionError(
      "That AWS sign-in can no longer be read. Sign in again to reconnect the account.",
      "expired",
    );
  }

  const signIn = await getSsoRoleCredentials({
    ssoRegion: connection.ssoRegion,
    accessToken,
    accountId: connection.accountId,
    roleName: connection.ssoRoleName,
  });
  if (!connection.ssoSetupRoleArn) return signIn;

  // An IAM-only permission set: every call goes through the setup role, with
  // the same read cap an assumed connection role gets.
  const assume = (roleArn: string, waitMs?: number) =>
    assumeSetupRole(signIn, {
      roleArn,
      region: options.region,
      sessionSuffix: options.sessionSuffix,
      access: options.access,
      sessionPolicy: options.sessionPolicy,
      waitMs,
    });
  try {
    return await assume(connection.ssoSetupRoleArn);
  } catch (error) {
    if (!(error instanceof AwsConnectionError)) throw error;
    if (error.code !== "access-denied") throw error;
    // Refused: the role was deleted, edited, or its trust names an SSO role that
    // was re-provisioned under a new id. The sign-in can repair all three, so it
    // does, once, and waits out IAM's propagation.
    const repaired = await ensureSetupRole(signIn, {
      accountId: connection.accountId,
      ssoRoleName: connection.ssoRoleName,
      region: options.region,
    });
    if (!repaired) throw error;
    if (repaired !== connection.ssoSetupRoleArn) {
      await database.awsConnection.update({
        where: { id: connection.id },
        data: { ssoSetupRoleArn: repaired },
      });
    }
    return assume(repaired, SETUP_ROLE_PROPAGATION_MS);
  }
}

/**
 * Deletes the setup roles of connections that are about to be removed.
 *
 * Best-effort and silent: disconnecting must work with an expired sign-in too,
 * and a role left behind is harmless (it trusts only that SSO role, and the next
 * sign-in rewrites it). A role still used by a connection that stays, such as a
 * colleague's sign-in with the same permission set, is left alone.
 */
export async function removeSetupRoles(
  connections: AwsConnection[],
): Promise<void> {
  const leaving = new Set(connections.map((entry) => entry.id));

  for (const connection of connections) {
    const roleArn = connection.ssoSetupRoleArn;
    if (!roleArn || !connection.accountId) continue;
    try {
      const stillUsed = await database.awsConnection.count({
        where: { ssoSetupRoleArn: roleArn, id: { notIn: [...leaving] } },
      });
      if (stillUsed > 0) continue;

      const accessToken = connection.ssoAccessTokenCiphertext
        ? decryptSecret(connection.ssoAccessTokenCiphertext)
        : null;
      if (
        !accessToken ||
        !connection.ssoRegion ||
        !connection.ssoRoleName ||
        (connection.ssoExpiresAt &&
          connection.ssoExpiresAt.getTime() < Date.now())
      ) {
        continue;
      }

      const signIn = await getSsoRoleCredentials({
        ssoRegion: connection.ssoRegion,
        accessToken,
        accountId: connection.accountId,
        roleName: connection.ssoRoleName,
      });
      await deleteSetupRole(signIn, { roleArn, region: connection.region });
    } catch (error) {
      console.warn(
        `[aws] Could not delete the setup role ${roleArn}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}

/** How long a freshly written setup role may take before STS accepts it. */
export const SETUP_ROLE_PROPAGATION_MS = 20_000;

/**
 * Decides, at sign-in, whether this permission set needs a setup role, and
 * prepares it if so. Returns its ARN, or null when the sign-in is used as is.
 *
 * Null for a set that can use CloudFormation (it needs no help) and for one that
 * cannot manage IAM either (it cannot be helped; the setup then reports the
 * missing permission). Waits until the role can be assumed, so the first click
 * in the Deploy tab does not land in IAM's propagation delay.
 */
export async function prepareSetupRole(input: {
  credentials: AwsSessionCredentials;
  accountId: string;
  ssoRoleName: string;
  region: string;
}): Promise<string | null> {
  if (!(await needsSetupRole(input.credentials, input.region))) return null;

  const roleArn = await ensureSetupRole(input.credentials, input);
  if (!roleArn) return null;

  await assumeSetupRole(input.credentials, {
    roleArn,
    region: input.region,
    sessionSuffix: "setup-check",
    access: "read",
    waitMs: SETUP_ROLE_PROPAGATION_MS,
  });
  return roleArn;
}

export interface ProjectAwsSession {
  credentials: AwsSessionCredentials;
  region: string;
  accountId: string | null;
  /** The connection that produced the session, for error messages. */
  connectionLabel: string;
}

/** Why the account is unreachable, phrased so the UI can act on it. */
export type ProjectAwsSessionResult =
  | { ok: true; session: ProjectAwsSession }
  | {
      ok: false;
      reason: "no-connection" | "unverified" | "failed";
      message: string;
    };

/**
 * Picks the connection that belongs to a project.
 *
 * Matching on the account id rather than letting the user pick: a project is
 * pinned to one AWS account by its pipeline and its state bucket, so any other
 * connection would read the wrong infrastructure and look like a bug.
 *
 * A project without an account id is not connected. There used to be a fallback
 * to "any connection this user has", which quietly gave one project the
 * credentials of another — precisely wrong for someone with two projects
 * deploying into two accounts, which is the normal case.
 */
export async function resolveProjectAwsSession(
  userId: string,
  project: Project,
  access: "read" | "write" = "read",
  /**
   * Narrows the session to one purpose instead of the read-only cap.
   *
   * In `sso` mode this is ignored (unless the sign-in has a setup role), because
   * those credentials come from a permission set rather than from an assumed role — the caller has to be able
   * to explain an `AccessDenied` that Terrablox cannot prevent there.
   */
  sessionPolicy?: string,
): Promise<ProjectAwsSessionResult> {
  const connections = await database.awsConnection.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
  });

  if (!project.awsAccountId) {
    return {
      ok: false,
      reason: "no-connection",
      message:
        "This project has no AWS account yet. Connect one from the Deploy tab.",
    };
  }

  const matching = connections.filter(
    (entry) => entry.accountId === project.awsAccountId,
  );

  if (matching.length === 0) {
    return {
      ok: false,
      reason: "no-connection",
      message: `No connected AWS account matches ${project.awsAccountId}. Connect it from the Deploy tab.`,
    };
  }

  // The most recent sign-in wins. Signing in again with a different permission
  // set adds a second row for the same account rather than replacing the first,
  // and the user's intent is the newer one. Taking the oldest here, while the
  // Deploy tab showed the newest, meant the tab said "IAM-Admin" while the stack
  // was created with the PowerUser session from before.
  const verified = matching
    .filter((entry) => entry.verifiedAt !== null)
    .sort(
      (a, b) => (b.verifiedAt?.getTime() ?? 0) - (a.verifiedAt?.getTime() ?? 0),
    )[0];
  if (!verified) {
    return {
      ok: false,
      reason: "unverified",
      message:
        "The AWS connection for this project has never been verified. Verify it from the Deploy tab.",
    };
  }

  try {
    const credentials = await sessionForConnection(verified, {
      // The project decides the region: the connection's region is only where
      // the role was set up, and a project can deploy somewhere else.
      region: project.awsRegion || verified.region,
      sessionSuffix: project.id,
      access,
      sessionPolicy,
    });

    return {
      ok: true,
      session: {
        credentials,
        region: project.awsRegion || verified.region,
        accountId: verified.accountId,
        connectionLabel: verified.label || verified.roleArn,
      },
    };
  } catch (error) {
    return {
      ok: false,
      reason: "failed",
      message:
        error instanceof AwsConnectionError
          ? error.message
          : "Could not assume the connected role.",
    };
  }
}

/** The shape AWS SDK clients want, without leaking the expiry into callers. */
export function toClientCredentials(session: ProjectAwsSession) {
  return {
    accessKeyId: session.credentials.accessKeyId,
    secretAccessKey: session.credentials.secretAccessKey,
    sessionToken: session.credentials.sessionToken,
  };
}
