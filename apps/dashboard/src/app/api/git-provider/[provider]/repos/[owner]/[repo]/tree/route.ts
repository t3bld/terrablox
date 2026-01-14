import type { GitProviderId } from "@terrablox/git-import";
import { githubProvider } from "@terrablox/git-import/github";
import { NextResponse } from "next/server";

import { getProviderTokenForRequest } from "@/lib/auth/server-helpers";

export async function GET(
  req: Request,
  { params }: { params: { provider: string; owner: string; repo: string } },
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

  const owner = params.owner?.trim();
  const repo = params.repo?.trim();
  if (!owner || !repo) {
    return NextResponse.json({ error: "Missing owner/repo" }, { status: 400 });
  }

  const { searchParams } = new URL(req.url);
  const ref = searchParams.get("ref")?.trim();
  if (!ref) {
    return NextResponse.json({ error: "Missing ref" }, { status: 400 });
  }

  const repoFullName = `${owner}/${repo}`;

  try {
    const entries = await githubProvider.getTree(token, repoFullName, ref);
    return NextResponse.json({ entries });
  } catch (error: unknown) {
    const err = error as {
      message?: string;
      providerHeaders?: Record<string, string>;
      status?: number;
    };

    const scopes = err.providerHeaders?.["x-oauth-scopes"] ?? "";

    return NextResponse.json(
      { error: err.message ?? "Failed to fetch tree", scopes },
      { status: err.status ?? 502 },
    );
  }
}
