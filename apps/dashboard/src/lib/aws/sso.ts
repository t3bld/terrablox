import "server-only";

import {
  CloudFormationClient,
  CreateStackCommand,
} from "@aws-sdk/client-cloudformation";
import {
  GetRoleCredentialsCommand,
  ListAccountRolesCommand,
  ListAccountsCommand,
  SSOClient,
} from "@aws-sdk/client-sso";
import {
  CreateTokenCommand,
  RegisterClientCommand,
  SSOOIDCClient,
  StartDeviceAuthorizationCommand,
} from "@aws-sdk/client-sso-oidc";

import { AwsConnectionError, isValidRegion } from "./connection";

/**
 * Signing in with IAM Identity Center, the same device flow `aws sso login`
 * uses.
 *
 * This is only how the connection gets *set up*. The SSO session is interactive
 * and expires within hours, which is useless for reading a project graph on a
 * page load, so TerraBlox spends it once — to create the read role — and then
 * throws it away. Everything afterwards runs on AssumeRole, which needs nobody
 * present.
 */

/** Portal URLs are user input that we turn into an endpoint, so pin the shape. */
const START_URL_PATTERN =
  /^https:\/\/[a-z0-9-]+\.awsapps\.com\/start\/?$|^https:\/\/[a-z0-9-]+\.awsapps\.com\/start#\/?$/;

/** The role the bootstrap stack creates, and the stack that owns it. */
export const BOOTSTRAP_ROLE_NAME = "terrablox-read";
export const BOOTSTRAP_STACK_NAME = "terrablox-read-access";

export function isValidStartUrl(value: string): boolean {
  return START_URL_PATTERN.test(value.trim());
}

/** Identity Center exposes its own console URL too; accept it and normalise. */
export function normaliseStartUrl(value: string): string {
  return value.trim().replace(/#?\/?$/, "");
}

export interface DeviceAuthorization {
  clientId: string;
  clientSecret: string;
  deviceCode: string;
  /** Shown to the user so they can check the browser is asking about us. */
  userCode: string;
  /** Pre-filled URL; the plain one is the fallback if it is missing. */
  verificationUri: string;
  expiresAt: Date;
  intervalSeconds: number;
}

/**
 * Registers TerraBlox as a client and asks for a device code.
 *
 * The registration is per login rather than cached: it costs one extra call and
 * removes the question of where to keep a long-lived client secret.
 */
export async function startDeviceAuthorization(params: {
  startUrl: string;
  ssoRegion: string;
}): Promise<DeviceAuthorization> {
  if (!isValidStartUrl(params.startUrl)) {
    throw new AwsConnectionError(
      "That is not an IAM Identity Center portal URL. It looks like https://your-org.awsapps.com/start.",
      "invalid",
    );
  }

  if (!isValidRegion(params.ssoRegion)) {
    throw new AwsConnectionError("That is not a valid AWS region.", "invalid");
  }

  const oidc = new SSOOIDCClient({ region: params.ssoRegion });

  try {
    const client = await oidc.send(
      new RegisterClientCommand({
        clientName: "TerraBlox",
        clientType: "public",
        scopes: ["sso:account:access"],
      }),
    );

    if (!client.clientId || !client.clientSecret) {
      throw new AwsConnectionError(
        "AWS did not return a client registration.",
        "unknown",
      );
    }

    const device = await oidc.send(
      new StartDeviceAuthorizationCommand({
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        startUrl: normaliseStartUrl(params.startUrl),
      }),
    );

    if (!device.deviceCode || !device.userCode) {
      throw new AwsConnectionError(
        "AWS did not return a device code.",
        "unknown",
      );
    }

    return {
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      deviceCode: device.deviceCode,
      userCode: device.userCode,
      verificationUri:
        device.verificationUriComplete ?? device.verificationUri ?? "",
      expiresAt: new Date(Date.now() + (device.expiresIn ?? 600) * 1000),
      intervalSeconds: device.interval ?? 5,
    };
  } catch (error) {
    throw describeSsoFailure(error);
  }
}

export type DeviceTokenResult =
  | { state: "pending" }
  | { state: "ready"; accessToken: string }
  | { state: "expired" };

/**
 * Asks once whether the user has approved yet.
 *
 * Polling belongs in the caller: a route handler that blocks for the minutes a
 * human needs would tie up a connection and hit request timeouts anyway.
 */
export async function pollDeviceToken(params: {
  ssoRegion: string;
  clientId: string;
  clientSecret: string;
  deviceCode: string;
}): Promise<DeviceTokenResult> {
  const oidc = new SSOOIDCClient({ region: params.ssoRegion });

  try {
    const token = await oidc.send(
      new CreateTokenCommand({
        clientId: params.clientId,
        clientSecret: params.clientSecret,
        deviceCode: params.deviceCode,
        grantType: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    );

    if (!token.accessToken) {
      throw new AwsConnectionError("AWS returned no access token.", "unknown");
    }

    return { state: "ready", accessToken: token.accessToken };
  } catch (error) {
    const name = errorName(error);

    // The expected answer for as long as the user has not clicked Allow.
    if (name === "AuthorizationPendingException") return { state: "pending" };
    if (name === "SlowDownException") return { state: "pending" };
    if (name === "ExpiredTokenException") return { state: "expired" };

    throw describeSsoFailure(error);
  }
}

export interface SsoAccount {
  accountId: string;
  name: string;
  /** Permission sets the signed-in user may use in this account. */
  roles: string[];
}

/**
 * Every account the user can reach, with the roles they hold in each.
 *
 * Listing beats asking for an account number: users of a landing zone rarely
 * know the twelve digits by heart, and a wrong one fails much later.
 */
export async function listSsoAccounts(params: {
  ssoRegion: string;
  accessToken: string;
}): Promise<SsoAccount[]> {
  const sso = new SSOClient({ region: params.ssoRegion });

  try {
    const accounts: SsoAccount[] = [];
    let nextToken: string | undefined;

    do {
      const page = await sso.send(
        new ListAccountsCommand({
          accessToken: params.accessToken,
          nextToken,
        }),
      );

      for (const account of page.accountList ?? []) {
        if (!account.accountId) continue;

        const roles = await sso.send(
          new ListAccountRolesCommand({
            accessToken: params.accessToken,
            accountId: account.accountId,
          }),
        );

        accounts.push({
          accountId: account.accountId,
          name: account.accountName ?? account.accountId,
          roles: (roles.roleList ?? [])
            .map((role) => role.roleName)
            .filter((name): name is string => Boolean(name)),
        });
      }

      nextToken = page.nextToken;
    } while (nextToken);

    return accounts;
  } catch (error) {
    throw describeSsoFailure(error);
  }
}

/**
 * Creates the read role in the chosen account, using the user's SSO session.
 *
 * CloudFormation rather than raw IAM calls so the customer keeps one object
 * they can inspect, update and delete — deleting the stack is how they revoke
 * TerraBlox, and that is much easier to trust than a role that appeared from
 * nowhere.
 */
export async function createBootstrapStack(params: {
  ssoRegion: string;
  accessToken: string;
  accountId: string;
  roleName: string;
  region: string;
  template: string;
}): Promise<void> {
  if (!isValidRegion(params.region)) {
    throw new AwsConnectionError("That is not a valid AWS region.", "invalid");
  }

  const sso = new SSOClient({ region: params.ssoRegion });

  try {
    const issued = await sso.send(
      new GetRoleCredentialsCommand({
        accessToken: params.accessToken,
        accountId: params.accountId,
        roleName: params.roleName,
      }),
    );

    const credentials = issued.roleCredentials;
    if (
      !credentials?.accessKeyId ||
      !credentials.secretAccessKey ||
      !credentials.sessionToken
    ) {
      throw new AwsConnectionError(
        "AWS did not issue credentials for that role.",
        "unknown",
      );
    }

    const cfn = new CloudFormationClient({
      region: params.region,
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        sessionToken: credentials.sessionToken,
      },
    });

    await cfn.send(
      new CreateStackCommand({
        StackName: BOOTSTRAP_STACK_NAME,
        TemplateBody: params.template,
        // Required because the template names the role instead of letting
        // CloudFormation generate one; the fixed name is what makes the ARN
        // predictable enough to store before the stack finishes.
        Capabilities: ["CAPABILITY_NAMED_IAM"],
        OnFailure: "DELETE",
        Tags: [{ Key: "ManagedBy", Value: "TerraBlox" }],
      }),
    );
  } catch (error) {
    if (error instanceof AwsConnectionError) throw error;
    if (errorName(error) === "AlreadyExistsException") {
      throw new AwsConnectionError(
        `A stack called ${BOOTSTRAP_STACK_NAME} already exists in that account. Delete it first, or connect the existing role by its ARN.`,
        "duplicate",
      );
    }
    throw describeSsoFailure(error);
  }
}

/** The ARN the bootstrap stack will produce, known before it finishes. */
export function bootstrapRoleArn(accountId: string): string {
  return `arn:aws:iam::${accountId}:role/${BOOTSTRAP_ROLE_NAME}`;
}

function errorName(error: unknown): string {
  return typeof error === "object" && error !== null && "name" in error
    ? String((error as { name: unknown }).name)
    : "";
}

function describeSsoFailure(error: unknown): AwsConnectionError {
  if (error instanceof AwsConnectionError) return error;

  switch (errorName(error)) {
    case "InvalidRequestException":
      return new AwsConnectionError(
        "AWS rejected the request. Check the portal URL and the region of your Identity Center instance.",
        "invalid",
      );
    case "UnauthorizedException":
    case "UnauthorizedClientException":
      return new AwsConnectionError(
        "The sign-in has expired. Start again.",
        "expired",
      );
    case "ForbiddenException":
    case "AccessDeniedException":
      return new AwsConnectionError(
        "That role may not create IAM roles in this account. Pick a role with administrative rights, or create the role manually.",
        "access-denied",
      );
    default:
      return new AwsConnectionError(
        error instanceof Error ? error.message : "Could not reach AWS.",
        "unknown",
      );
  }
}
