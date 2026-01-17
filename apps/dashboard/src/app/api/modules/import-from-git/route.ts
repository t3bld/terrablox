import type { Prisma } from "@terrablox/database";
import { NextResponse } from "next/server";
import { getProviderTokenForRequest } from "@/lib/auth/server-helpers";
import { database } from "@/lib/database";
import { analyzeTerraformFromTexts } from "@/lib/terraform/analyze";

type GitRefType = "release" | "branch";

interface CreateModuleFromGitImportInput {
  userId: string;
  repoFullName: string;
  refType: GitRefType;
  refName: string;
  terraformRootFolder?: string;
  terraformSubmodulesFolders?: string[];
  nameOverride?: string;
  description?: string;
  tags?: string[];
}

function normalizeFolderPath(input?: string | null) {
  const raw = (input ?? "").trim();
  if (!raw) return null;
  const normalized = raw.replace(/^\/+/, "").replace(/\/+$/, "");
  return normalized === "" ? null : normalized;
}

function normalizeTags(tags?: string[] | null) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tags ?? []) {
    const n = t.trim().replace(/\s+/g, "-").toLowerCase();
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

async function fetchRepoTree(params: {
  token: string;
  repoFullName: string;
  ref: string;
}): Promise<Array<{ path: string; type: "tree" | "blob" }>> {
  // Resolve ref -> sha (best-effort). Uses GitHub API directly so we don't rely on internal route calls.
  const refUrl = `https://api.github.com/repos/${params.repoFullName}/git/ref/${encodeURIComponent(params.ref)}`;

  let sha: string | undefined;
  try {
    const refRes = await fetch(refUrl, {
      headers: {
        Authorization: `Bearer ${params.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      cache: "no-store",
    });

    if (refRes.ok) {
      const refData = (await refRes.json()) as { object?: { sha?: string } };
      sha = refData?.object?.sha;
    }
  } catch {
    // ignore
  }

  if (!sha) {
    const commitRes = await fetch(
      `https://api.github.com/repos/${params.repoFullName}/commits/${encodeURIComponent(params.ref)}`,
      {
        headers: {
          Authorization: `Bearer ${params.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        cache: "no-store",
      },
    );

    if (!commitRes.ok) return [];
    const commitData = (await commitRes.json()) as { sha?: string };
    sha = commitData?.sha;
  }

  if (!sha) return [];

  const treeRes = await fetch(
    `https://api.github.com/repos/${params.repoFullName}/git/trees/${sha}?recursive=1`,
    {
      headers: {
        Authorization: `Bearer ${params.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      cache: "no-store",
    },
  );

  if (!treeRes.ok) return [];

  const treeData = (await treeRes.json()) as {
    tree?: Array<{ path: string; type: "tree" | "blob" | "commit" }>;
  };

  return (treeData.tree ?? [])
    .filter((e) => e.type === "tree" || e.type === "blob")
    .map((e) => ({ path: e.path, type: e.type as "tree" | "blob" }));
}

async function fetchTextFile(params: {
  token: string;
  repoFullName: string;
  ref: string;
  path: string;
}): Promise<string | null> {
  const apiUrl = new URL(
    `https://api.github.com/repos/${params.repoFullName}/contents/${params.path.replace(/^\/+/, "")}`,
  );
  apiUrl.searchParams.set("ref", params.ref);

  const res = await fetch(apiUrl.toString(), {
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

function listTfFilesForFolder(params: {
  treeEntries: Array<{ path: string; type: "tree" | "blob" }>;
  folder: string;
}) {
  const root = normalizeFolderPath(params.folder) ?? ".";
  const prefix = root === "." ? "" : `${root}/`;

  return (
    params.treeEntries
      .filter((e) => e.type === "blob")
      .map((e) => e.path)
      .filter((p) => (prefix ? p.startsWith(prefix) : true))
      .filter((p) => p.endsWith(".tf"))
      // only direct folder contents
      .filter((p) => {
        const rel = prefix ? p.slice(prefix.length) : p;
        return !rel.includes("/");
      })
      .slice(0, 50)
  );
}

function listDirectChildFolders(params: {
  treeEntries: Array<{ path: string; type: "tree" | "blob" }>;
  folder: string;
}) {
  const root = normalizeFolderPath(params.folder) ?? ".";
  const prefix = root === "." ? "" : `${root}/`;

  const children = new Set<string>();

  for (const e of params.treeEntries) {
    if (e.type !== "tree") continue;
    if (prefix && !e.path.startsWith(prefix)) continue;

    const rel = prefix ? e.path.slice(prefix.length) : e.path;
    if (!rel) continue;
    const segs = rel.split("/").filter(Boolean);
    if (segs.length >= 1 && segs[0]) {
      const child = prefix ? `${prefix}${segs[0]}` : segs[0];
      children.add(child);
    }
  }

  return [...children].sort();
}

async function analyzeFolder(params: {
  token: string;
  repoFullName: string;
  refName: string;
  treeEntries: Array<{ path: string; type: "tree" | "blob" }>;
  folder: string;
}) {
  const files = listTfFilesForFolder({
    treeEntries: params.treeEntries,
    folder: params.folder,
  });

  const contents: string[] = [];
  for (const p of files) {
    const t = await fetchTextFile({
      token: params.token,
      repoFullName: params.repoFullName,
      ref: params.refName,
      path: p,
    });
    if (t) contents.push(t);
  }

  return analyzeTerraformFromTexts(contents);
}

async function resolveSubmoduleFolders(params: {
  token: string;
  repoFullName: string;
  refName: string;
  treeEntries: Array<{ path: string; type: "tree" | "blob" }>;
  rootFolder: string;
  userProvided: string[];
}) {
  const rootNormalized = normalizeFolderPath(params.rootFolder) ?? ".";
  const candidates = (params.userProvided ?? [])
    .map((p) => normalizeFolderPath(p))
    .filter((p): p is string => !!p && p !== ".")
    .filter((p) => p !== rootNormalized);

  const out = new Set<string>();

  for (const c of candidates) {
    // If the folder itself contains Terraform, treat it as a module.
    const hasTf =
      listTfFilesForFolder({ treeEntries: params.treeEntries, folder: c })
        .length > 0;

    if (hasTf) {
      out.add(c);
      continue;
    }

    // Otherwise, treat as a container folder: create a submodule for each immediate
    // child folder that contains Terraform.
    const children = listDirectChildFolders({
      treeEntries: params.treeEntries,
      folder: c,
    });

    for (const child of children) {
      const childHasTf =
        listTfFilesForFolder({
          treeEntries: params.treeEntries,
          folder: child,
        }).length > 0;

      if (childHasTf) out.add(child);
    }
  }

  return [...out].sort();
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Partial<CreateModuleFromGitImportInput>;

    const userId = body.userId?.trim();
    const repoFullName = body.repoFullName?.trim();
    const refType = body.refType;
    const refName = body.refName?.trim();

    if (!userId) {
      return NextResponse.json({ error: "Missing userId" }, { status: 400 });
    }

    if (!repoFullName || !repoFullName.includes("/")) {
      return NextResponse.json(
        { error: "Missing repoFullName" },
        { status: 400 },
      );
    }

    if (refType !== "release" && refType !== "branch") {
      return NextResponse.json({ error: "Invalid refType" }, { status: 400 });
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

    const defaultName = repoFullName.split("/").pop() ?? repoFullName;

    // Persist a stable, non-empty version tag to the DB.
    // We store the human ref name (branch name or release tag) rather than a full refs/* string.
    const versionTag = refName;

    const url = `https://github.com/${repoFullName}.git?ref=${encodeURIComponent(versionTag)}`;
    const sourceName = (body.nameOverride?.trim() || defaultName).trim();
    const canonicalSourceUrl = `https://github.com/${repoFullName}.git`;

    const existingSource = await database.terraformModuleSource.findFirst({
      where: { userId, url: canonicalSourceUrl },
      select: { id: true },
    });

    const source = existingSource
      ? await database.terraformModuleSource.update({
          where: { id: existingSource.id },
          data: {
            name: sourceName,
            description: body.description?.trim() || null,
            tags: normalizeTags(body.tags),
          },
        })
      : await database.terraformModuleSource.create({
          data: {
            userId,
            name: sourceName,
            description: body.description?.trim() || null,
            tags: normalizeTags(body.tags),
            url: canonicalSourceUrl,
            provider: "github",
          },
        });

    const terraformRootFolder =
      normalizeFolderPath(body.terraformRootFolder) ?? ".";
    const rawSubmodules = (body.terraformSubmodulesFolders ?? [])
      .map((p) => normalizeFolderPath(p))
      .filter((p): p is string => !!p && p !== ".");

    const treeEntries = await fetchRepoTree({
      token,
      repoFullName,
      ref: refName,
    });

    const terraformSubmodulesFolders = await resolveSubmoduleFolders({
      token,
      repoFullName,
      refName,
      treeEntries,
      rootFolder: terraformRootFolder,
      userProvided: rawSubmodules,
    });

    const rootAnalysis = await analyzeFolder({
      token,
      repoFullName,
      refName,
      treeEntries,
      folder: terraformRootFolder,
    });

    const submoduleAnalyses = await Promise.all(
      terraformSubmodulesFolders.map(async (folder) => {
        const analysis = await analyzeFolder({
          token,
          repoFullName,
          refName,
          treeEntries,
          folder,
        });

        return { folder, analysis };
      }),
    );

    const created = await database.$transaction(
      async (tx) => {
      const rootModule = await tx.terraformModule.create({
        data: {
          userId,
          sourceId: source.id,
          // Root module display is derived from terraform_module_sources.
          submoduleName: null,
          versionTag,
          url,
          terraformRootFolder,
          terraformSubmodulesFolders,
          variables: rootAnalysis.variables as unknown as Prisma.JsonArray,
          outputs: rootAnalysis.outputs as unknown as Prisma.JsonArray,
          isSubmodule: false,
        },
      });

      const createdSubmodulesWithAnalysis = [] as Array<{
        id: string;
        terraformRootFolder: string;
        analysis: typeof rootAnalysis;
      }>;

      for (const { folder: subFolder, analysis: subAnalysis } of submoduleAnalyses) {
        const sub = await tx.terraformModule.create({
          data: {
            userId,
            sourceId: source.id,
            // For imported submodules, store the folder basename as submodule_name.
            submoduleName: subFolder.split("/").pop() ?? subFolder,
            versionTag,
            url,
            terraformRootFolder: subFolder,
            terraformSubmodulesFolders: [],
            variables: subAnalysis.variables as unknown as Prisma.JsonArray,
            outputs: subAnalysis.outputs as unknown as Prisma.JsonArray,
            isSubmodule: true,
            parentModuleId: rootModule.id,
          },
        });

        createdSubmodulesWithAnalysis.push({
          id: sub.id,
          terraformRootFolder: subFolder,
          analysis: subAnalysis,
        });
      }

      // Provider resources: best-effort mapping. Use detected providers (fallback to prefix before first underscore).
      async function upsertProviderResources(
        moduleId: string,
        analysis: typeof rootAnalysis,
      ) {
        // wipe and re-create for now to avoid having to diff
        await tx.providerResource.deleteMany({ where: { moduleId } });

        const providerNames = analysis.providers
          .map((p) => p.name)
          .filter((n): n is string => typeof n === "string" && n.length > 0);

        const rows: Prisma.ProviderResourceCreateManyInput[] =
          analysis.resources.map((r) => {
            const inferredProvider =
              (r.type.includes("_") ? r.type.split("_")[0] : r.type) ||
              "unknown";

            const providerName = providerNames.includes(inferredProvider)
              ? inferredProvider
              : (providerNames[0] ?? inferredProvider);

            return {
              moduleId,
              resourceType: r.type,
              resourceName: r.name,
              providerName,
              version: null,
              resourceUrl: null,
              providerUrl: null,
              resourceDescription: null,
            };
          });

        if (rows.length) {
          await tx.providerResource.createMany({ data: rows });
        }
      }

      await upsertProviderResources(rootModule.id, rootAnalysis);

      for (const sub of createdSubmodulesWithAnalysis) {
        await upsertProviderResources(sub.id, sub.analysis);
      }

      return {
        rootModule,
        submodules: createdSubmodulesWithAnalysis.map(({ id, terraformRootFolder }) => ({
          id,
          terraformRootFolder,
        })),
      };
      },
      // Avoid interactive transaction timeouts; DB work should be fast now,
      // but provider resource rewrites can still take a bit on large modules.
      { timeout: 30_000 },
    );

    return NextResponse.json(
      {
        module: created.rootModule,
        submodules: created.submodules,
        source,
      },
      { status: 201 },
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to import module" },
      { status: 500 },
    );
  }
}
