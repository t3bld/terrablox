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
import { toView } from "./connection-service";
import {
  bootstrapRoleArn,
  createBootstrapStack,
  type DeviceAuthorization,
  discoverSsoRegion,
  listSsoAccounts,
  normaliseStartUrl,
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

/**
 * Where Identity Center is assumed to be when the portal would not say.
 *
 * A guess beats a required field: most instances are in one region, and being
 * wrong costs one failed call, after which the UI asks.
 */
const FALLBACK_SSO_REGION = "eu-central-1";

export interface SsoLoginStart {
  loginId: string;
  userCode: string;
  verificationUri: string;
  intervalSeconds: number;
  expiresAt: string;
}

/**
 * Starts the device flow without making the user name a region.
 *
 * The portal is asked first, then the fallback is tried, and only if both are
 * refused does the error reach the user — that is the point at which a region
 * input is worth showing, because by then it is genuinely the open question.
 */
async function authorizeWithBestRegion(input: {
  startUrl: string;
  ssoRegion?: string | null;
}): Promise<{ device: DeviceAuthorization; ssoRegion: string }> {
  const given = input.ssoRegion?.trim();

  const candidates = given
    ? [given]
    : [
        ...new Set(
          [await discoverSsoRegion(input.startUrl), FALLBACK_SSO_REGION].filter(
            (region): region is string => Boolean(region),
          ),
        ),
      ];

  let lastError: unknown;

  for (const ssoRegion of candidates) {
    try {
      return {
        device: await startDeviceAuthorization({
          startUrl: input.startUrl,
          ssoRegion,
        }),
        ssoRegion,
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

export async function startSsoLogin(
  userId: string,
  input: { startUrl: string; ssoRegion?: string | null },
): Promise<SsoLoginStart> {
  const { device, ssoRegion } = await authorizeWithBestRegion(input);

  // One login at a time per user, so an abandoned attempt cannot be resumed
  // later and cannot be confused with the current one.
  await database.awsSsoLogin.deleteMany({ where: { userId } });

  const record = await database.awsSsoLogin.create({
    data: {
      userId,
      // Stored in the canonical form, because this row is what later credential
      // requests are built from — not the string the user happened to paste.
      startUrl: normaliseStartUrl(input.startUrl),
      // The region that actually worked, so every later call in this login
      // (polling, listing accounts, issuing credentials) reuses it.
      ssoRegion,
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
        data: {
          accessToken: result.accessToken,
          // The device code is spent; from here the token's own life is what
          // decides whether this login is still worth anything.
          expiresAt: result.tokenExpiresAt,
        },
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

  const label = input.label.trim().slice(0, 120);
  const principalArn = await resolveTerraBloxPrincipal();

  // With an identity of its own the app can be named in a trust policy, so it
  // creates a role and needs nobody present afterwards. Without one it keeps
  // the sign-in and spends it per request, the way the AWS CLI does — the same
  // access, but the user has to sign in again when the session runs out.
  const useSsoSession = principalArn === null;

  const roleArn = useSsoSession
    ? `arn:aws:iam::${input.accountId}:role/${input.roleName}`
    : bootstrapRoleArn(input.accountId);

  const existing = await database.awsConnection.findFirst({
    where: { userId, roleArn },
  });

  // Signing in again is the documented cure for an expired SSO session, so it
  // cannot be an error. The row is refreshed rather than duplicated: the account
  // and the role are the same, only the token and its expiry moved on.
  if (existing && useSsoSession) {
    const refreshed = await database.awsConnection.update({
      where: { id: existing.id },
      data: {
        label: label || existing.label,
        accountId: input.accountId,
        region: input.region.trim(),
        credentialMode: "sso",
        ssoStartUrl: record.startUrl,
        ssoRegion: record.ssoRegion,
        ssoRoleName: input.roleName,
        ssoAccessToken: record.accessToken,
        ssoExpiresAt: record.expiresAt,
        verifiedAt: new Date(),
        lastError: null,
      },
    });

    await database.awsSsoLogin.delete({ where: { id: record.id } });
    return toView(refreshed, principalArn);
  }

  if (existing) {
    throw new AwsConnectionError(
      "That account is already connected.",
      "duplicate",
    );
  }

  const externalId = generateExternalId();

  if (principalArn) {
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
  }

  const connection = await database.awsConnection.create({
    data: {
      userId,
      label: label || `AWS ${input.accountId}`,
      accountId: input.accountId,
      roleArn,
      region: input.region.trim(),
      externalId,
      ...(useSsoSession
        ? {
            credentialMode: "sso",
            ssoStartUrl: record.startUrl,
            ssoRegion: record.ssoRegion,
            ssoRoleName: input.roleName,
            ssoAccessToken: record.accessToken,
            ssoExpiresAt: record.expiresAt,
            // Signing in *was* the proof; there is no trust policy to wait for.
            verifiedAt: new Date(),
          }
        : {}),
    },
  });

  // The login row has done its job: in role mode the session is spent, and in
  // SSO mode the token now lives on the connection that uses it.
  await database.awsSsoLogin.delete({ where: { id: record.id } });

  return toView(connection, principalArn);
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
