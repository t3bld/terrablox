import { NextResponse } from "next/server";

import { getCurrentUserId } from "@/lib/auth/server-helpers";
import { database } from "@/lib/database";
import { canonicalRepoUrl } from "@/lib/module-library/import-from-git";
import { libraryOf } from "@/lib/module-library/libraries";
import { isManaged } from "@/lib/module-library/ownership";
import { visibleModulesForUser } from "@/lib/module-library/visibility";

/**
 * Lookup existing imports for a repo+ref+folder combination.
 * Used by the import dialog to disable steps that are already in the DB.
 *
 * Sees the catalogue Terrablox ships with, for the reason given in
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
  const visibility = await visibleModulesForUser(userId);

  const sources = await database.terraformModuleSource.findMany({
    where: { ...visibility, url: canonicalSourceUrl },
    select: {
      id: true,
      userId: true,
      library: true,
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

  // A per-user library row is the user's too, but read-only: their personal
  // import, if any, is the one edits land on.
  const preferred =
    sources.find((s) => s.userId === userId && s.library === null) ??
    sources[0];
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
      ...visibility,
      sourceId: { in: sources.map((s) => s.id) },
      versionTag,
      terraformRootFolder,
      isSubmodule: false,
    },
    select: {
      id: true,
      userId: true,
      library: true,
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
    isBuiltin: isManaged(module),
    library: libraryOf(module),
    source,
    module,
  });
}
