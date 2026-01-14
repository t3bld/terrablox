import { NextResponse } from "next/server";

import { database } from "@/lib/database";

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

    const defaultName = repoFullName.split("/").pop() ?? repoFullName;
    const url = `https://github.com/${repoFullName}.git?ref=${encodeURIComponent(refName)}`;
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

    const moduleRecord = await database.terraformModule.create({
      data: {
        userId,
        sourceId: source.id,
        versionTag: refType === "release" ? refName : null,
        url,
        terraformRootFolder: normalizeFolderPath(body.terraformRootFolder) ?? ".",
        terraformSubmodulesFolders: (body.terraformSubmodulesFolders ?? [])
          .map((p) => normalizeFolderPath(p))
          .filter((p): p is string => !!p && p !== "."),
      },
    });

    return NextResponse.json({ module: moduleRecord }, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to import module" },
      { status: 500 },
    );
  }
}

