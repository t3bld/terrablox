import { NextResponse } from "next/server";

import { AwsConnectionError } from "./connection";

/**
 * Turns any failure into a JSON body.
 *
 * Rethrowing hands the browser a 500 with an empty body, which every `res.json()`
 * turns into "Unexpected end of JSON input" — the one message that says nothing
 * about what went wrong. Unexpected errors also reach the server log here,
 * because that is where the stack trace is worth something.
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
