import { NextResponse } from "next/server";

import { isGithubConfigured } from "@/lib/auth/server";

// Everything here is read from the runtime environment, so this must not be
// prerendered into a static response at build time.
export const dynamic = "force-dynamic";

/**
 * Reports which optional auth providers the server has credentials for, so the
 * UI can explain the current setup instead of offering actions that are
 * guaranteed to fail.
 */
export async function GET() {
  return NextResponse.json({
    providers: {
      github: isGithubConfigured,
    },
  });
}
