import { AwsConnectionError } from "@terrablox/aws/connection";
import { NextResponse } from "next/server";

/**
 * How a failure becomes a response.
 *
 * One module, after two. There was an `awsRouteError` in `lib/aws/route-error.ts` doing
 * the same job for one error class, which meant the answer to "what status does the
 * browser get" depended on which helper a route happened to import — and a route that
 * touched both AWS and the database had to pick.
 */

/** A failure whose message is safe to show the user. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function unauthorized(message = "Unauthorized"): NextResponse {
  return NextResponse.json({ error: message }, { status: 401 });
}

export function notFound(message = "Not found"): NextResponse {
  return NextResponse.json({ error: message }, { status: 404 });
}

export function badRequest(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 400 });
}

/**
 * Anything that is not an ApiError is logged and reported generically.
 *
 * Passing a raw error through to the browser leaks Prisma column names, provider
 * token scopes and stack traces; swallowing it silently leaves nothing to debug.
 * The stack belongs in the server log, the apology belongs in the response.
 */
export function routeError(scope: string, error: unknown): NextResponse {
  if (error instanceof ApiError) {
    return NextResponse.json(
      { error: error.message },
      { status: error.status },
    );
  }

  // Also safe to show: `AwsConnectionError` exists precisely to phrase an AWS failure
  // for the person who has to fix it — a missing role, a revoked trust, an expired
  // sign-in. 400 rather than 502, because in every one of those cases the thing to
  // change is on the caller's side.
  if (error instanceof AwsConnectionError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  console.error(`[${scope}] unhandled route failure`, error);

  return NextResponse.json(
    { error: "Something went wrong. Please try again." },
    { status: 500 },
  );
}

/** Upstream provider failures keep their status but never their body. */
export function providerError(
  scope: string,
  error: unknown,
  fallbackMessage: string,
): NextResponse {
  const status =
    typeof (error as { status?: unknown })?.status === "number"
      ? (error as { status: number }).status
      : 502;

  console.error(`[${scope}] provider request failed`, error);

  return NextResponse.json(
    { error: fallbackMessage },
    { status: status >= 400 && status < 600 ? status : 502 },
  );
}

/**
 * Kept as its own name because AWS failures read differently.
 *
 * `routeError` answers with "Something went wrong. Please try again." for anything it
 * does not recognise, which is right for a database or a bug and wrong here: a route
 * talking to somebody else's AWS account fails for reasons the user can act on, and
 * saying which service was involved is most of the diagnosis.
 */
export function awsRouteError(error: unknown): NextResponse {
  if (error instanceof AwsConnectionError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  console.error("[aws] unhandled route failure", error);

  return NextResponse.json(
    {
      error:
        error instanceof Error
          ? `Something went wrong talking to AWS: ${error.message}`
          : "Something went wrong talking to AWS.",
    },
    { status: 500 },
  );
}
