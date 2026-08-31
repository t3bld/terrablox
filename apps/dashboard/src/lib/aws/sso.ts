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
 * What happens to the session depends on what the instance is. One that has an
 * AWS identity spends the sign-in once — to create a role that trusts it — and
 * throws it away, so later reads need nobody present. One that has no identity
 * cannot be named in a trust policy at all, so it keeps the session and
 * exchanges it for role credentials per request instead.
 */

/** Portal URLs are user input that we turn into an endpoint, so pin the host. */
const PORTAL_HOST_PATTERN = /^[a-z0-9-]+\.awsapps\.com$/;

/** The role the bootstrap stack creates, and the stack that owns it. */
export const BOOTSTRAP_ROLE_NAME = "terrablox-read";
export const BOOTSTRAP_STACK_NAME = "terrablox-read-access";

/**
 * The portal URL reduced to what AWS's OIDC endpoints accept: `https://`, the
 * portal host, and `/start`.
 *
 * People paste what their browser shows them, and the portal is a single-page
 * app: the address bar says `…/start/#/`, and `…/start/#/?tab=accounts` after a
 * click. Both name the same portal, so a pattern that only allowed the bare
 * `/start` rejected URLs that were correct. Everything from the `#` onwards is
 * routing inside that page and is dropped rather than validated.
 *
 * Returns null when the value is not an Identity Center portal at all. The host
 * stays pinned to `*.awsapps.com` because this value is later fetched
 * server-side, and an arbitrary URL there would be a request the user gets to
 * choose the target of.
 */
export function parseStartUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || !PORTAL_HOST_PATTERN.test(host)) {
    return null;
  }

  // `/start`, `/start/` and the directory the app routes under are one portal.
  if (url.pathname.replace(/\/+$/, "").toLowerCase() !== "/start") {
    return null;
  }

  return `https://${host}/start`;
}

export function isValidStartUrl(value: string): boolean {
  return parseStartUrl(value) !== null;
}

export function normaliseStartUrl(value: string): string {
  return parseStartUrl(value) ?? value.trim();
}

/**
 * The portal names its own region in its response headers.
 *
 * A `Link: <https://portal.sso.eu-central-1.amazonaws.com/>; rel=preconnect` and
 * a CSP `report-uri https://log.sso-portal.eu-central-1.amazonaws.com/log` are
 * both there on the first unauthenticated request, which is what makes this
 * worth doing: the alternative is asking every user for a region they have to go
 * and look up, to answer a question the portal already answers.
 */
const PORTAL_REGION_PATTERN =
  /\bsso(?:-portal)?\.([a-z]{2}(?:-[a-z]+)+-\d)\.amazonaws\.com/;

/**
 * Works out which region an Identity Center instance is in from its portal URL.
 *
 * Best-effort by design: null means "ask", not "broken". Nothing is sent to AWS
 * beyond a plain GET of a URL the user just typed, and the response is read for
 * a region and nothing else.
 */
export async function discoverSsoRegion(
  startUrl: string,
): Promise<string | null> {
  if (!isValidStartUrl(startUrl)) return null;

  try {
    const response = await fetch(normaliseStartUrl(startUrl), {
      // The redirect to /start/ already carries the headers, and not following
      // it keeps this to one request that downloads no page.
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });

    const headers = `${response.headers.get("link") ?? ""} ${
      response.headers.get("content-security-policy") ?? ""
    }`;

    const region = PORTAL_REGION_PATTERN.exec(headers)?.[1];
    return region && isValidRegion(region) ? region : null;
  } catch {
    // A portal that cannot be reached is not a region problem; let the sign-in
    // attempt produce the error the user can act on.
    return null;
  }
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
  | { state: "ready"; accessToken: string; tokenExpiresAt: Date }
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

    return {
      state: "ready",
      accessToken: token.accessToken,
      // AWS states this in seconds and typically grants eight hours.
      tokenExpiresAt: new Date(Date.now() + (token.expiresIn ?? 28_800) * 1000),
    };
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

/**
 * Exchanges an SSO session for role credentials in one account.
 *
 * This is the whole reason a self-hosted instance can work at all: the token
 * the user signed in with is enough to act in their accounts, so TerraBlox
 * needs no AWS identity of its own to stand behind a trust policy.
 */
export async function getSsoRoleCredentials(params: {
  ssoRegion: string;
  accessToken: string;
  accountId: string;
  roleName: string;
}): Promise<{
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: Date | null;
}> {
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

    return {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
      expiration: credentials.expiration
        ? new Date(credentials.expiration)
        : null,
    };
  } catch (error) {
    if (error instanceof AwsConnectionError) throw error;
    // An expired session is the ordinary end of this mode, not a fault.
    if (errorName(error) === "UnauthorizedException") {
      throw new AwsConnectionError(
        "That AWS sign-in has expired. Sign in again to reconnect the account.",
        "expired",
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
