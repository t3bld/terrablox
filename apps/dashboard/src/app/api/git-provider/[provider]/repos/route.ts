import type { GitProviderId } from "@terrablox/git-import";

import { githubProvider } from "@terrablox/git-import/github";
import { NextResponse } from "next/server";

import { getProviderTokenForRequest } from "@/lib/auth/server-helpers";

export async function GET(
  req: Request,
  { params }: { params: { provider: string } },
) {
  const providerId = params.provider as GitProviderId;

  if (providerId !== "github") {
    return NextResponse.json(
      { error: "Unsupported provider" },
      { status: 400 },
    );
  }

  const token = await getProviderTokenForRequest(req, providerId);
  if (!token) {
    return NextResponse.json(
      { error: "Missing or invalid provider token" },
      { status: 401 },
    );
  }

  try {
    const repos = await githubProvider.getRepos(token);
    return NextResponse.json({ repos });
  } catch (error: unknown) {
    const err = error as {
      message?: string;
      providerHeaders?: Record<string, string>;
      status?: number;
    };

    const scopes = err.providerHeaders?.["x-oauth-scopes"] ?? "";

    return NextResponse.json(
      { error: err.message ?? "Failed to fetch repositories", scopes },
      { status: err.status ?? 502 },
    );
  }
}
