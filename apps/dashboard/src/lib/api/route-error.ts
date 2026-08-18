import { NextResponse } from "next/server";

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
