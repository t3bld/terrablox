import "server-only";

import { database } from "@/lib/database";

import {
  AwsConnectionError,
  generateExternalId,
  isValidRegion,
  renderConnectionTemplate,
  resolveTerraBloxPrincipal,
} from "./connection";
import type { AwsConnectionView } from "./connection-service";
import {
  bootstrapRoleArn,
  createBootstrapStack,
  listSsoAccounts,
  pollDeviceToken,
  type SsoAccount,
  startDeviceAuthorization,
} from "./sso";

/**
 * The guided path to a connected account: sign in, pick an account, done.
 *
 * The manual path stays because it is the only one that works without IAM
 * Identity Center, and because some customers would rather read the template
 * than let an app create a role for them.
 */

/** Login rows are worthless after this; anything older is abandoned. */
const LOGIN_TTL_MINUTES = 15;

export interface SsoLoginStart {
  loginId: string;
  userCode: string;
  verificationUri: string;
  intervalSeconds: number;
  expiresAt: string;
}

export async function startSsoLogin(
  userId: string,
  input: { startUrl: string; ssoRegion: string },
): Promise<SsoLoginStart> {
  const device = await startDeviceAuthorization({
    startUrl: input.startUrl,
    ssoRegion: input.ssoRegion,
  });

  // One login at a time per user, so an abandoned attempt cannot be resumed
  // later and cannot be confused with the current one.
  await database.awsSsoLogin.deleteMany({ where: { userId } });

  const record = await database.awsSsoLogin.create({
    data: {
      userId,
      startUrl: input.startUrl.trim(),
      ssoRegion: input.ssoRegion.trim(),
      clientId: device.clientId,
      clientSecret: device.clientSecret,
      deviceCode: device.deviceCode,
      interval: device.intervalSeconds,
      expiresAt: device.expiresAt,
    },
  });

  return {
    loginId: record.id,
    userCode: device.userCode,
    verificationUri: device.verificationUri,
    intervalSeconds: device.intervalSeconds,
    expiresAt: device.expiresAt.toISOString(),
  };
}

export type SsoLoginStatus =
  | { state: "pending" }
  | { state: "expired" }
  | { state: "ready"; accounts: SsoAccount[] };

/**
 * One poll. Returns the account list as soon as the user has approved, because
 * that is the next thing the UI needs and it saves a round trip.
 */
export async function checkSsoLogin(
  userId: string,
  loginId: string,
): Promise<SsoLoginStatus | null> {
  const record = await database.awsSsoLogin.findFirst({
    where: { id: loginId, userId },
  });

  if (!record) return null;

  if (record.expiresAt.getTime() < Date.now()) {
    await database.awsSsoLogin.delete({ where: { id: record.id } });
    return { state: "expired" };
  }

  const accessToken =
    record.accessToken ??
    (await (async () => {
      const result = await pollDeviceToken({
        ssoRegion: record.ssoRegion,
        clientId: record.clientId,
        clientSecret: record.clientSecret,
        deviceCode: record.deviceCode,
      });

      if (result.state !== "ready") return null;

      await database.awsSsoLogin.update({
        where: { id: record.id },
        data: { accessToken: result.accessToken },
      });

      return result.accessToken;
    })());

  if (!accessToken) return { state: "pending" };

  return {
    state: "ready",
    accounts: await listSsoAccounts({
      ssoRegion: record.ssoRegion,
      accessToken,
    }),
  };
}

/**
 * Creates the role in the chosen account and connects it.
 *
 * The connection is stored before CloudFormation reports success: the role name
 * is fixed by the template, so its ARN is known in advance, and leaving the row
 * unverified is exactly what it is — the stack takes a while and might fail.
 * The user verifies it afterwards like any manually created role.
 */
export async function completeSsoLogin(
  userId: string,
  loginId: string,
  input: {
    accountId: string;
    roleName: string;
    region: string;
    label: string;
  },
): Promise<AwsConnectionView | null> {
  const record = await database.awsSsoLogin.findFirst({
    where: { id: loginId, userId },
  });

  if (!record) return null;

  if (!record.accessToken) {
    throw new AwsConnectionError("That sign-in is not finished.", "pending");
  }

  if (!/^\d{12}$/.test(input.accountId)) {
    throw new AwsConnectionError("That is not an AWS account ID.", "invalid");
  }

  if (!isValidRegion(input.region)) {
    throw new AwsConnectionError(
      "Enter a region like eu-central-1.",
      "invalid",
    );
  }

  const roleArn = bootstrapRoleArn(input.accountId);
  const label = input.label.trim().slice(0, 120);

  const existing = await database.awsConnection.findFirst({
    where: { userId, roleArn },
  });

  if (existing) {
    throw new AwsConnectionError(
      "That account is already connected.",
      "duplicate",
    );
  }

  const principalArn = await resolveTerraBloxPrincipal();
  if (!principalArn) {
    throw new AwsConnectionError(
      "This TerraBlox instance has no AWS credentials yet, so the role it creates could never be assumed. Give the app an AWS identity first.",
      "not-configured",
    );
  }

  const externalId = generateExternalId();

  await createBootstrapStack({
    ssoRegion: record.ssoRegion,
    accessToken: record.accessToken,
    accountId: input.accountId,
    roleName: input.roleName,
    region: input.region,
    template: renderConnectionTemplate({
      externalId,
      principalArn,
      label,
    }),
  });

  const connection = await database.awsConnection.create({
    data: {
      userId,
      label: label || `AWS ${input.accountId}`,
      accountId: input.accountId,
      roleArn,
      region: input.region.trim(),
      externalId,
    },
  });

  // The SSO session has done its job; keeping it would mean holding a live
  // credential for the customer's account with nothing to spend it on.
  await database.awsSsoLogin.delete({ where: { id: record.id } });

  return {
    id: connection.id,
    label: connection.label,
    accountId: connection.accountId,
    roleArn: connection.roleArn,
    region: connection.region,
    externalId: connection.externalId,
    verifiedAt: null,
    lastError: null,
    template: renderConnectionTemplate({
      externalId,
      principalArn,
      label,
    }),
    createdAt: connection.createdAt.toISOString(),
  };
}

export async function cancelSsoLogin(
  userId: string,
  loginId: string,
): Promise<void> {
  await database.awsSsoLogin.deleteMany({ where: { id: loginId, userId } });
}

/** Housekeeping for logins nobody finished, run on each new start. */
export async function purgeStaleLogins(): Promise<void> {
  await database.awsSsoLogin.deleteMany({
    where: {
      createdAt: { lt: new Date(Date.now() - LOGIN_TTL_MINUTES * 60_000) },
    },
  });
}
