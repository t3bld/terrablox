import { NextResponse } from "next/server";

import { ApiError, routeError } from "@/lib/api/route-error";
import {
  requireQueryParam,
  resolveRepoRequest,
} from "@/lib/git-provider/request";

export async function GET(
  req: Request,
  { params }: { params: { provider: string; owner: string; repo: string } },
) {
  try {
    const { token, repoFullName } = await resolveRepoRequest(req, params);
    const ref = requireQueryParam(req, "ref");
    const path = requireQueryParam(req, "path");

    // `new URL()` resolves `..` segments, so an unchecked path escapes
    // /repos/{owner}/{repo}/contents/ and turns this route into an
    // authenticated proxy for any api.github.com endpoint.
    const relativePath = path.replace(/^\/+/, "");
    if (relativePath.split("/").includes("..")) {
      throw new ApiError("Invalid path", 400);
    }

    const apiUrl = new URL(
      `https://api.github.com/repos/${repoFullName}/contents/${relativePath}`,
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
      console.error(
        "[git-provider/contents] request failed",
        res.status,
        await res.text().catch(() => ""),
      );
      throw new ApiError(
        `Could not read the file (${res.status}).`,
        res.status,
      );
    }

    // Pass through. We only use `content` for blobs.
    return NextResponse.json(await res.json());
  } catch (error) {
    return routeError("git-provider/contents", error);
  }
}
