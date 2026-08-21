import "server-only";

import type { AwsConnection, Project } from "@terrablox/database";

import { database } from "@/lib/database";

import {
  AwsConnectionError,
  type AwsSessionCredentials,
  assumeConnectionSession,
} from "./connection";
import { getSsoRoleCredentials } from "./sso";

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
 * user signed in with is the real limit, and TerraBlox cannot narrow it the way
 * it narrows an assumed role.
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
    !connection.ssoAccessToken ||
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

  return getSsoRoleCredentials({
    ssoRegion: connection.ssoRegion,
    accessToken: connection.ssoAccessToken,
    accountId: connection.accountId,
    roleName: connection.ssoRoleName,
  });
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
   * In `sso` mode this is ignored, because those credentials come from a
   * permission set rather than from an assumed role — the caller has to be able
   * to explain an `AccessDenied` that TerraBlox cannot prevent there.
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

  const verified = matching.find((entry) => entry.verifiedAt !== null);
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
