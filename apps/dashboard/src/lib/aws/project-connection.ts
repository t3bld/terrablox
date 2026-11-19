import "server-only";

import type { Project } from "@terrablox/database";

import { decryptSecret } from "@/lib/crypto/secret-box";
import { database } from "@/lib/database";

/**
 * Whether one project can reach AWS, answered from the database alone.
 *
 * Deliberately does not assume a role or exchange a token. The Deploy and State
 * tabs ask this on every render to decide between the connect flow and their own
 * content, and a real STS call per render would be both slow and, on an expired
 * SSO session, an error where a plain "sign in again" is the answer.
 *
 * Per project, not per user: a project is pinned to one AWS account, and two
 * projects deploying into two accounts must not be able to borrow each other's
 * sign-in.
 */
/**
 * The Identity Center sign-in a project was set up with.
 *
 * Everything but the device confirmation: the portal, the account and the
 * permission set. A finished setup keeps using exactly these, so asking for them
 * again on every expired session would only offer chances to pick wrong.
 */
export interface PreviousSignIn {
  startUrl: string;
  ssoRegion: string | null;
  accountId: string;
  accountName: string;
  roleName: string;
}

export type ProjectAwsState =
  | { connected: false; reason: "none"; signIn: PreviousSignIn | null }
  | {
      connected: false;
      reason: "unverified" | "expired";
      accountId: string;
      region: string;
      label: string;
      credentialMode: string;
      expiresAt: string | null;
      /** How this project last signed in, so signing in again is one click. */
      signIn: PreviousSignIn | null;
    }
  | {
      connected: true;
      reason: "ok";
      accountId: string;
      region: string;
      label: string;
      credentialMode: string;
      /**
       * When the sign-in runs out, ISO. Null in `assume-role` mode, where there
       * is no session to keep alive — Terrablox assumes the role per request.
       */
      expiresAt: string | null;
      signIn: PreviousSignIn | null;
    };

export async function readProjectAwsState(
  userId: string,
  project: Project,
): Promise<ProjectAwsState> {
  const signIn = previousSignIn(project);
  if (!project.awsAccountId)
    return { connected: false, reason: "none", signIn };

  const connection = await database.awsConnection.findFirst({
    where: { userId, accountId: project.awsAccountId },
    // The same choice `resolveProjectAwsSession` makes: the most recent sign-in.
    // `verifiedAt` rather than `createdAt`, because signing in again with the same
    // permission set refreshes the existing row instead of creating a new one.
    orderBy: [
      { verifiedAt: { sort: "desc", nulls: "last" } },
      { createdAt: "desc" },
    ],
  });

  if (!connection) return { connected: false, reason: "none", signIn };

  const shared = {
    accountId: connection.accountId ?? project.awsAccountId,
    region: project.awsRegion || connection.region,
    label: connection.label || connection.roleArn,
    credentialMode: connection.credentialMode,
    expiresAt: connection.ssoExpiresAt?.toISOString() ?? null,
    // The project's own record first; the sign-in fills in what an older
    // project did not record yet.
    signIn:
      signIn ??
      previousSignIn({
        ...project,
        awsSsoStartUrl: connection.ssoStartUrl,
        awsSsoRegion: connection.ssoRegion,
        awsSsoRoleName: connection.ssoRoleName,
        awsAccountLabel: connection.label || null,
      }),
  };

  if (!connection.verifiedAt) {
    return { connected: false, reason: "unverified", ...shared };
  }

  // Only `sso` mode has a session that runs out. An assumed role is re-assumed
  // per request, so there is nothing to expire.
  if (connection.credentialMode === "sso") {
    const ranOut =
      connection.ssoExpiresAt !== null &&
      connection.ssoExpiresAt.getTime() <= Date.now();

    // A token we cannot read back is as spent as one that ran out, and the same
    // sign-in fixes both. Checked here rather than left to the first real call so
    // the tab offers the button instead of reporting a healthy connection and
    // then failing — the state a rotated BETTER_AUTH_SECRET leaves behind.
    // Still no network: this decrypts a column, it does not talk to AWS.
    const unreadable =
      !connection.ssoAccessTokenCiphertext ||
      decryptSecret(connection.ssoAccessTokenCiphertext) === null;

    if (ranOut || unreadable) {
      return { connected: false, reason: "expired", ...shared };
    }
  }

  return { connected: true, reason: "ok", ...shared };
}

/**
 * How the project signed in last, from what it recorded.
 *
 * The account comes from the project, or from its deployment role when it was
 * disconnected since: the role lives in that account, and a finished setup
 * keeps it.
 */
function previousSignIn(project: Project): PreviousSignIn | null {
  const accountId =
    project.awsAccountId ??
    project.awsRoleArn?.match(/^arn:aws[\w-]*:iam::(\d{12}):/)?.[1] ??
    null;
  if (!project.awsSsoStartUrl || !project.awsSsoRoleName || !accountId) {
    return null;
  }
  return {
    startUrl: project.awsSsoStartUrl,
    ssoRegion: project.awsSsoRegion,
    accountId,
    accountName: project.awsAccountLabel || accountId,
    roleName: project.awsSsoRoleName,
  };
}
