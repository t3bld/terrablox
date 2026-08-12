import { NextResponse } from "next/server";

import { isGithubConfigured } from "@/lib/auth/server";
import { getGitAuthMode } from "@/lib/auth/server-helpers";

// Everything here is read from the runtime environment, so this must not be
// prerendered into a static response at build time.
export const dynamic = "force-dynamic";

/**
 * Reports which optional auth providers the server has credentials for, and
 * how repositories are read, so the UI can explain the current setup instead
 * of offering actions that are guaranteed to fail.
 */
export async function GET() {
  return NextResponse.json({
    providers: {
      github: isGithubConfigured,
    },
    gitAuthMode: getGitAuthMode(),
  });
}
