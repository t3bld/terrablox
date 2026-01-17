import { NextResponse } from "next/server";

import { database } from "@/lib/database";

/**
 * Lookup existing imports for a repo+ref+folder combination.
 * Used by the import dialog to disable steps that are already in the DB.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);

  const userId = searchParams.get("userId")?.trim();
  const repoFullName = searchParams.get("repoFullName")?.trim();
  const refName = searchParams.get("refName")?.trim();
  const terraformRootFolderRaw = searchParams.get("terraformRootFolder")?.trim();

  if (!userId) {
    return NextResponse.json({ error: "Missing userId" }, { status: 400 });
  }

  if (!repoFullName || !repoFullName.includes("/")) {
    return NextResponse.json({ error: "Missing repoFullName" }, { status: 400 });
  }

  if (!refName) {
    return NextResponse.json({ error: "Missing refName" }, { status: 400 });
  }

  const terraformRootFolder = terraformRootFolderRaw
    ? terraformRootFolderRaw.replace(/^\/+/, "").replace(/\/+$/, "") || "."
    : ".";

  const canonicalSourceUrl = `https://github.com/${repoFullName}.git`;
  const versionTag = refName;

  const source = await database.terraformModuleSource.findFirst({
    where: { userId, url: canonicalSourceUrl },
    select: { id: true, name: true, description: true, tags: true, url: true },
  });

  if (!source?.id) {
    return NextResponse.json({ exists: false });
  }

  const module = await database.terraformModule.findFirst({
    where: {
      userId,
      sourceId: source.id,
      versionTag,
      terraformRootFolder,
      isSubmodule: false,
    },
    select: {
      id: true,
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
    source,
    module,
  });
}

