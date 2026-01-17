import type { GitProviderId } from "@terrablox/git-import";
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
  const path = searchParams.get("path")?.trim();

  if (!ref) {
    return NextResponse.json({ error: "Missing ref" }, { status: 400 });
  }

  if (!path) {
    return NextResponse.json({ error: "Missing path" }, { status: 400 });
  }

  const repoFullName = `${owner}/${repo}`;

  try {
    const apiUrl = new URL(
      `https://api.github.com/repos/${repoFullName}/contents/${path.replace(/^\/+/, "")}`,
    );
    apiUrl.searchParams.set("ref", ref);

    const res = await fetch(apiUrl.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      cache: "no-store",
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "Could not read error body.");
      const providerHeaders: Record<string, string> = {};
      for (const [k, v] of res.headers.entries()) providerHeaders[k] = v;
      const scopes = providerHeaders["x-oauth-scopes"] ?? "";

      return NextResponse.json(
        {
          error: `GitHub API Error: ${res.status} ${res.statusText} - ${text.slice(0, 200)}`,
          scopes,
        },
        { status: res.status },
      );
    }

    // Pass through. We only use `content` for blobs.
    const body = await res.json();
    return NextResponse.json(body);
  } catch (error: unknown) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to fetch file content",
      },
      { status: 502 },
    );
  }
}

