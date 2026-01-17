import { NextResponse } from "next/server";

import { database } from "@/lib/database";

/**
 * Returns which versions (ref/tag names) are already imported for a given repo.
 * Used by the import dialog to disable already-imported refs.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);

  const userId = searchParams.get("userId")?.trim();
  const repoFullName = searchParams.get("repoFullName")?.trim();

  if (!userId) {
    return NextResponse.json({ error: "Missing userId" }, { status: 400 });
  }

  if (!repoFullName || !repoFullName.includes("/")) {
    return NextResponse.json({ error: "Missing repoFullName" }, { status: 400 });
  }

  const canonicalSourceUrl = `https://github.com/${repoFullName}.git`;

  const source = await database.terraformModuleSource.findFirst({
    where: { userId, url: canonicalSourceUrl },
    select: { id: true, name: true, description: true, tags: true, url: true },
  });

  if (!source?.id) {
    return NextResponse.json({
      repoImported: false,
      importedVersions: [],
    });
  }

  // Only count root module versions; submodules are imported as a consequence of the version.
  const roots = await database.terraformModule.findMany({
    where: {
      userId,
      sourceId: source.id,
      isSubmodule: false,
    },
    select: { versionTag: true },
  });

  const importedVersions = Array.from(
    new Set((roots ?? []).map((r) => r.versionTag).filter((v): v is string => !!v && v.trim() !== "")),
  ).sort();

  return NextResponse.json({
    repoImported: true,
    source,
    importedVersions,
  });
}

