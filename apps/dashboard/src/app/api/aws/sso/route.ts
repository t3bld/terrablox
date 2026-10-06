import { isValidStartUrl } from "@terrablox/aws/sso";
import { NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonBody, requireUserWithLimit } from "@/lib/api/guard";
import { RATE_LIMITS } from "@/lib/api/rate-limit";
import { routeError } from "@/lib/api/route-error";
import * as schema from "@/lib/api/schemas";
import { audit } from "@/lib/audit/log";
import { purgeStaleLogins, startSsoLogin } from "@/lib/aws/sso-service";

/**
 * The start of an IAM Identity Center device login.
 *
 * `startUrl` is checked against the portal form here rather than only deeper in.
 * `normaliseStartUrl` falls back to the raw string when it cannot parse one, so an
 * unvalidated value was stored on the login row and then reused for every later
 * credential request in that session. There was no SSRF — `discoverSsoRegion` guards
 * itself with the same predicate, and `startDeviceAuthorization` passes the value to
 * AWS as a parameter rather than fetching it — but storing a string that can never
 * work is a failure deferred to the least useful moment.
 *
 * The predicate is imported rather than re-expressed: `isValidStartUrl` pins the host
 * to `*.awsapps.com` and the path to `/start`, and a second copy of that rule here
 * would be one to keep in step.
 */
const startBody = z.object({
  startUrl: z.string().trim().max(500).refine(isValidStartUrl, {
    message:
      "Expected an Identity Center portal URL, e.g. https://acme.awsapps.com/start",
  }),
  // Optional: the portal is asked for its region first, and the client only sends
  // one after that has failed.
  ssoRegion: schema.region.nullish(),
});

export async function POST(req: Request) {
  try {
    const userId = await requireUserWithLimit(
      "aws.sso.start",
      RATE_LIMITS.infrastructure,
    );

    const body = await parseJsonBody(req, startBody);

    await purgeStaleLogins();

    const login = await startSsoLogin(userId, {
      startUrl: body.startUrl,
      ssoRegion: body.ssoRegion ?? null,
    });

    await audit({
      action: "aws.sso.started",
      userId,
      subject: login.loginId,
      detail: { startUrl: body.startUrl },
    });

    return NextResponse.json({ login }, { status: 201 });
  } catch (error) {
    return routeError("aws.sso.start", error);
  }
}
