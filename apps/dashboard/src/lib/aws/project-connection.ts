import "server-only";

import type { Project } from "@terrablox/database";

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
export type ProjectAwsState =
  | { connected: false; reason: "none" }
  | {
      connected: false;
      reason: "unverified" | "expired";
      accountId: string;
      region: string;
      label: string;
      credentialMode: string;
      expiresAt: string | null;
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
       * is no session to keep alive — TerraBlox assumes the role per request.
       */
      expiresAt: string | null;
    };

export async function readProjectAwsState(
  userId: string,
  project: Project,
): Promise<ProjectAwsState> {
  if (!project.awsAccountId) return { connected: false, reason: "none" };

  const connection = await database.awsConnection.findFirst({
    where: { userId, accountId: project.awsAccountId },
    orderBy: { createdAt: "desc" },
  });

  if (!connection) return { connected: false, reason: "none" };

  const shared = {
    accountId: connection.accountId ?? project.awsAccountId,
    region: project.awsRegion || connection.region,
    label: connection.label || connection.roleArn,
    credentialMode: connection.credentialMode,
    expiresAt: connection.ssoExpiresAt?.toISOString() ?? null,
  };

  if (!connection.verifiedAt) {
    return { connected: false, reason: "unverified", ...shared };
  }

  // Only `sso` mode has a session that runs out. An assumed role is re-assumed
  // per request, so there is nothing to expire.
  if (
    connection.credentialMode === "sso" &&
    connection.ssoExpiresAt &&
    connection.ssoExpiresAt.getTime() <= Date.now()
  ) {
    return { connected: false, reason: "expired", ...shared };
  }

  return { connected: true, reason: "ok", ...shared };
}
