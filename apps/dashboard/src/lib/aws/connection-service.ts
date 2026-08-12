import "server-only";

import type { AwsConnection } from "@terrablox/database";

import { database } from "@/lib/database";

import {
  AwsConnectionError,
  assumeConnection,
  generateExternalId,
  isValidRegion,
  isValidRoleArn,
  renderConnectionTemplate,
  resolveTerraBloxPrincipal,
} from "./connection";

export interface AwsConnectionView {
  id: string;
  label: string;
  accountId: string | null;
  roleArn: string;
  region: string;
  /** Shown to its owner only; the customer needs it to write the trust policy. */
  externalId: string;
  verifiedAt: string | null;
  lastError: string | null;
  /** The stack the customer runs in their account to create the role. */
  template: string;
  createdAt: string;
}

export interface AwsConnectionsState {
  connections: AwsConnectionView[];
  /**
   * Whose ARN belongs in the trust policy. Null means this deployment has no
   * AWS identity yet, and no role the user creates could ever work.
   */
  principalArn: string | null;
}

function toView(
  record: AwsConnection,
  principalArn: string | null,
): AwsConnectionView {
  return {
    id: record.id,
    label: record.label,
    accountId: record.accountId,
    roleArn: record.roleArn,
    region: record.region,
    externalId: record.externalId,
    verifiedAt: record.verifiedAt?.toISOString() ?? null,
    lastError: record.lastError,
    template: renderConnectionTemplate({
      externalId: record.externalId,
      principalArn,
      label: record.label,
    }),
    createdAt: record.createdAt.toISOString(),
  };
}

export async function listConnections(
  userId: string,
): Promise<AwsConnectionsState> {
  const [records, principalArn] = await Promise.all([
    database.awsConnection.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
    }),
    resolveTerraBloxPrincipal(),
  ]);

  return {
    connections: records.map((record) => toView(record, principalArn)),
    principalArn,
  };
}

export async function createConnection(
  userId: string,
  input: { label: string; roleArn: string; region: string },
): Promise<AwsConnectionView> {
  const roleArn = input.roleArn.trim();
  const region = input.region.trim();

  if (!isValidRoleArn(roleArn)) {
    throw new AwsConnectionError(
      "Enter a role ARN like arn:aws:iam::123456789012:role/terrablox-read.",
      "invalid",
    );
  }

  if (!isValidRegion(region)) {
    throw new AwsConnectionError(
      "Enter a region like eu-central-1.",
      "invalid",
    );
  }

  const existing = await database.awsConnection.findFirst({
    where: { userId, roleArn },
  });

  if (existing) {
    throw new AwsConnectionError(
      "That role is already connected.",
      "duplicate",
    );
  }

  const record = await database.awsConnection.create({
    data: {
      userId,
      label: input.label.trim().slice(0, 120),
      roleArn,
      region,
      externalId: generateExternalId(),
    },
  });

  return toView(record, await resolveTerraBloxPrincipal());
}

/**
 * Assumes the role once and records what came back.
 *
 * Deliberately not done at creation time: the user needs the external ID
 * before they can write the trust policy, so the role cannot work yet.
 */
export async function verifyConnection(
  userId: string,
  connectionId: string,
): Promise<AwsConnectionView | null> {
  const record = await database.awsConnection.findFirst({
    where: { id: connectionId, userId },
  });

  if (!record) return null;

  try {
    const identity = await assumeConnection({
      roleArn: record.roleArn,
      externalId: record.externalId,
      region: record.region,
      sessionSuffix: connectionId,
    });

    const updated = await database.awsConnection.update({
      where: { id: record.id },
      data: {
        accountId: identity.accountId,
        verifiedAt: new Date(),
        lastError: null,
      },
    });

    return toView(updated, await resolveTerraBloxPrincipal());
  } catch (error) {
    const message =
      error instanceof AwsConnectionError
        ? error.message
        : "Could not reach AWS.";

    const updated = await database.awsConnection.update({
      where: { id: record.id },
      data: { verifiedAt: null, lastError: message },
    });

    return toView(updated, await resolveTerraBloxPrincipal());
  }
}

export async function deleteConnection(
  userId: string,
  connectionId: string,
): Promise<boolean> {
  const { count } = await database.awsConnection.deleteMany({
    where: { id: connectionId, userId },
  });

  return count > 0;
}
