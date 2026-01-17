import { NextResponse } from "next/server";

import { getProviderTokenForRequest } from "@/lib/auth/server-helpers";
import { analyzeTerraformFromTexts } from "@/lib/terraform/analyze";

interface AnalyzeGitModuleInput {
  provider: "github";
  repoFullName: string;
  refName: string;
  terraformRootFolder: string;
}

function normalizeFolderPath(input?: string | null) {
  const raw = (input ?? "").trim();
  if (!raw) return ".";
  const normalized = raw.replace(/^\/+/, "").replace(/\/+$/, "");
  return normalized === "" ? "." : normalized;
}

async function fetchTextFile(params: {
  token: string;
  repoFullName: string;
  ref: string;
  path: string;
}): Promise<string | null> {
  const url = new URL(
    `https://api.github.com/repos/${params.repoFullName}/contents/${params.path.replace(/^\/+/, "")}`,
  );
  url.searchParams.set("ref", params.ref);

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${params.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    cache: "no-store",
  });

  if (!res.ok) return null;

  const body = (await res.json()) as {
    type?: string;
    encoding?: string;
    content?: string;
  };

  if (body.type !== "file") return null;
  if (!body.content) return null;

  const encoding = body.encoding ?? "base64";
  if (encoding !== "base64") return null;

  return Buffer.from(body.content, "base64").toString("utf8");
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as
    | AnalyzeGitModuleInput
    | null;

  if (!body) {
    return NextResponse.json({ error: "Missing request body" }, { status: 400 });
  }

  if (body.provider !== "github") {
    return NextResponse.json({ error: "Unsupported provider" }, { status: 400 });
  }

  const repoFullName = body.repoFullName?.trim();
  const refName = body.refName?.trim();
  const terraformRootFolder = normalizeFolderPath(body.terraformRootFolder);

  if (!repoFullName || !repoFullName.includes("/")) {
    return NextResponse.json(
      { error: "Invalid repoFullName" },
      { status: 400 },
    );
  }
  if (!refName) {
    return NextResponse.json({ error: "Missing refName" }, { status: 400 });
  }

  const token = await getProviderTokenForRequest(req, "github");
  if (!token) {
    return NextResponse.json(
      { error: "Missing or invalid provider token" },
      { status: 401 },
    );
  }

  // 1) List tree (already supported by provider implementation).
  const treeRes = await fetch(
    `${new URL(req.url).origin}/api/git-provider/github/repos/${repoFullName}/tree?ref=${encodeURIComponent(refName)}`,
    { headers: req.headers, cache: "no-store" },
  );

  const treeBody = (await treeRes.json().catch(() => null)) as
    | { entries?: Array<{ path: string; type: "tree" | "blob" }> }
    | { error?: string; scopes?: string };

  if (!treeRes.ok) {
    return NextResponse.json(
      { error: (treeBody as any)?.error ?? "Failed to fetch repo tree" },
      { status: treeRes.status },
    );
  }

  const entries = (treeBody as any)?.entries ?? [];
  const rootPrefix = terraformRootFolder === "." ? "" : `${terraformRootFolder}/`;

  const tfFiles = entries
    .filter((e: any) => e.type === "blob")
    .map((e: any) => String(e.path))
    .filter((p: string) => (rootPrefix ? p.startsWith(rootPrefix) : true))
    .filter((p: string) => p.endsWith(".tf"))
    // Only include direct folder (no nested modules unless user picked a submodule folder).
    .filter((p: string) => {
      const rel = rootPrefix ? p.slice(rootPrefix.length) : p;
      return !rel.includes("/");
    })
    .slice(0, 50); // protect against huge modules

  const contents: string[] = [];
  for (const p of tfFiles) {
    const t = await fetchTextFile({ token, repoFullName, ref: refName, path: p });
    if (t) contents.push(t);
  }

  const analysis = analyzeTerraformFromTexts(contents);

  return NextResponse.json({
    terraformRootFolder,
    tfFiles,
    counts: {
      variables: analysis.variables.length,
      outputs: analysis.outputs.length,
      providers: analysis.providers.length,
      resources: analysis.resources.length,
      moduleCalls: analysis.moduleCalls.length,
    },
    analysis,
  });
}

