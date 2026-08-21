import { NextResponse } from "next/server";

import { getCurrentUserId } from "@/lib/auth/server-helpers";
import { database } from "@/lib/database";
import { canonicalRepoUrl } from "@/lib/modules/import-from-git";
import { visibleToUser } from "@/lib/modules/ownership";

/**
 * Lookup existing imports for a repo+ref+folder combination.
 * Used by the import dialog to disable steps that are already in the DB.
 *
 * Sees the catalogue TerraBlox ships with, for the reason given in
 * `imported-versions`: a shipped ref that looked absent would be re-imported into
 * a duplicate source row.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);

  const userId = await getCurrentUserId();
  const repoFullName = searchParams.get("repoFullName")?.trim();
  const refName = searchParams.get("refName")?.trim();
  const terraformRootFolderRaw = searchParams
    .get("terraformRootFolder")
    ?.trim();

  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!repoFullName || !repoFullName.includes("/")) {
    return NextResponse.json(
      { error: "Missing repoFullName" },
      { status: 400 },
    );
  }

  if (!refName) {
    return NextResponse.json({ error: "Missing refName" }, { status: 400 });
  }

  const terraformRootFolder = terraformRootFolderRaw
    ? terraformRootFolderRaw.replace(/^\/+/, "").replace(/\/+$/, "") || "."
    : ".";

  const canonicalSourceUrl = canonicalRepoUrl(repoFullName);
  const versionTag = refName;

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
    return NextResponse.json({ exists: false });
  }

  const preferred = sources.find((s) => s.userId === userId) ?? sources[0];
  const source = {
    id: preferred?.id,
    name: preferred?.name,
    description: preferred?.description,
    tags: preferred?.tags,
    url: preferred?.url,
    iconMode: preferred?.iconMode,
    iconName: preferred?.iconName,
    hasIcon: Boolean(preferred?.iconUrl),
  };

  const module = await database.terraformModule.findFirst({
    where: {
      ...visibleToUser(userId),
      sourceId: { in: sources.map((s) => s.id) },
      versionTag,
      terraformRootFolder,
      isSubmodule: false,
    },
    select: {
      id: true,
      userId: true,
      versionTag: true,
      terraformRootFolder: true,
      url: true,
      terraformSubmodulesFolders: true,
    },
  });

  if (!module?.id) {
    return NextResponse.json({ exists: false, source });
  }

  return NextResponse.json({
    exists: true,
    isBuiltin: module.userId === null,
    source,
    module,
  });
}
