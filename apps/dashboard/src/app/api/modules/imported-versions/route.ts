import { NextResponse } from "next/server";

import { getCurrentUserId } from "@/lib/auth/server-helpers";
import { database } from "@/lib/database";
import { canonicalRepoUrl } from "@/lib/modules/import-from-git";
import { visibleToUser } from "@/lib/modules/ownership";

/**
 * Returns which versions (ref/tag names) are already imported for a given repo.
 * Used by the import dialog to disable already-imported refs.
 *
 * Counts the catalogue TerraBlox ships with as imported. Otherwise a shipped
 * repository would offer itself for import, and accepting would write a second
 * source row for the same URL — leaving the modules page with two cards for one
 * repository and no way to tell them apart.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);

  const userId = await getCurrentUserId();
  const repoFullName = searchParams.get("repoFullName")?.trim();

  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!repoFullName || !repoFullName.includes("/")) {
    return NextResponse.json(
      { error: "Missing repoFullName" },
      { status: 400 },
    );
  }

  const canonicalSourceUrl = canonicalRepoUrl(repoFullName);

  // Possibly two rows: a user who imported this repo before it shipped has their
  // own alongside the builtin. Both count towards "already imported".
  const sources = await database.terraformModuleSource.findMany({
    where: { ...visibleToUser(userId), url: canonicalSourceUrl },
    select: {
      id: true,
      userId: true,
      name: true,
      description: true,
      tags: true,
      url: true,
      iconMode: true,
      iconName: true,
      iconUrl: true,
    },
  });

  if (sources.length === 0) {
    return NextResponse.json({
      repoImported: false,
      importedVersions: [],
    });
  }

  // The user's own row wins for prefilling, since that is the one their edits
  // would land on. The builtin only stands in when they have no row of their own.
  const preferred = sources.find((s) => s.userId === userId) ?? sources[0];
  const isBuiltin = preferred?.userId === null;

  // Only count root module versions; submodules are imported as a consequence of the version.
  const roots = await database.terraformModule.findMany({
    where: {
      ...visibleToUser(userId),
      sourceId: { in: sources.map((s) => s.id) },
      isSubmodule: false,
    },
    select: { versionTag: true },
  });

  const importedVersions = Array.from(
    new Set(
      (roots ?? [])
        .map((r) => r.versionTag)
        .filter((v): v is string => !!v && v.trim() !== ""),
    ),
  ).sort();

  return NextResponse.json({
    repoImported: true,
    isBuiltin,
    source: {
      id: preferred?.id,
      name: preferred?.name,
      description: preferred?.description,
      tags: preferred?.tags,
      url: preferred?.url,
      // So the dialog's icon control shows what is stored rather than an empty
      // default that contradicts the module card next to it.
      iconMode: preferred?.iconMode,
      iconName: preferred?.iconName,
      hasIcon: Boolean(preferred?.iconUrl),
    },
    importedVersions,
  });
}
