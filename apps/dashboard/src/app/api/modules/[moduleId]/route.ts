import { NextResponse } from "next/server";

import { getCurrentUserId } from "@/lib/auth/server-helpers";
import { database } from "@/lib/database";
import { parseScope } from "@/lib/terraform/delete-scope";
import {
  resolveDependents,
  resolveModuleLinks,
} from "@/lib/terraform/module-link";
import { sortVersionsDesc } from "@/lib/terraform/versions";

export async function GET(
  _req: Request,
  { params }: { params: { moduleId: string } },
) {
  // Derived from the session, never from the query string: a client-supplied
  // user id would let any caller read another user's modules.
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const moduleId = params.moduleId?.trim();
  if (!moduleId) {
    return NextResponse.json({ error: "Missing moduleId" }, { status: 400 });
  }

  const mod = await database.terraformModule.findFirst({
    where: { id: moduleId, userId },
    include: {
      source: true,
      resources: {
        orderBy: [
          { kind: "asc" },
          { providerName: "asc" },
          { resourceType: "asc" },
          { resourceName: "asc" },
        ],
      },
      dependencies: { orderBy: { name: "asc" } },
      providers: { orderBy: { name: "asc" } },
      references: { orderBy: [{ fromAddress: "asc" }, { toAddress: "asc" }] },
      submodules: {
        select: { id: true, submoduleName: true, terraformRootFolder: true },
      },
    },
  });

  if (!mod) {
    return NextResponse.json({ error: "Module not found" }, { status: 404 });
  }

  // Sibling versions power the header's version switcher. Scoped to root
  // modules of the same repository; a submodule switches versions through its
  // parent, not on its own.
  const siblingVersions = mod.sourceId
    ? await database.terraformModule.findMany({
        where: {
          userId,
          sourceId: mod.sourceId,
          isSubmodule: false,
        },
        select: { id: true, versionTag: true, createdAt: true },
      })
    : [];

  // Every module the user owns is a candidate target for a `module` block, so
  // dependencies resolve regardless of the order things were imported in.
  const linkCandidates = (
    await database.terraformModule.findMany({
      where: { userId },
      select: {
        id: true,
        versionTag: true,
        terraformRootFolder: true,
        submoduleName: true,
        createdAt: true,
        source: { select: { name: true, url: true } },
      },
    })
  ).map((candidate) => ({
    id: candidate.id,
    versionTag: candidate.versionTag,
    terraformRootFolder: candidate.terraformRootFolder,
    submoduleName: candidate.submoduleName,
    createdAt: candidate.createdAt,
    sourceUrl: candidate.source?.url ?? null,
    sourceName: candidate.source?.name ?? null,
  }));

  const links = resolveModuleLinks(
    mod.dependencies,
    // A module cannot usefully link to itself.
    linkCandidates.filter((candidate) => candidate.id !== mod.id),
  );

  // The reverse direction. Loading every dependency the user owns keeps this a
  // single query; resolution then decides which of them land on this module.
  const allDependencies = await database.moduleDependency.findMany({
    where: { module: { userId } },
    select: {
      name: true,
      source: true,
      sourceKind: true,
      moduleId: true,
    },
  });

  const dependents = resolveDependents(mod.id, allDependencies, linkCandidates);

  return NextResponse.json({
    module: {
      ...mod,
      dependencies: mod.dependencies.map((dependency) => ({
        ...dependency,
        linkedModule: links.get(dependency.id) ?? null,
      })),
      dependents,
      effectiveName: mod.submoduleName ?? mod.source?.name ?? "(unnamed)",
      effectiveDescription: mod.source?.description ?? null,
      versions: sortVersionsDesc(siblingVersions).map((v) => ({
        id: v.id,
        versionTag: v.versionTag,
        createdAt: v.createdAt.toISOString(),
      })),
    },
  });
}

export async function DELETE(
  req: Request,
  { params }: { params: { moduleId: string } },
) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const moduleId = params.moduleId?.trim();
  if (!moduleId) {
    return NextResponse.json({ error: "Missing moduleId" }, { status: 400 });
  }

  const scope = parseScope(new URL(req.url).searchParams.get("scope"));
  if (!scope) {
    return NextResponse.json(
      { error: "scope must be 'version' or 'module'" },
      { status: 400 },
    );
  }

  const mod = await database.terraformModule.findFirst({
    where: { id: moduleId, userId },
    select: { id: true, sourceId: true },
  });

  if (!mod) {
    return NextResponse.json({ error: "Module not found" }, { status: 404 });
  }

  // `scope=module` wipes every ref of the repository, so the target set is
  // resolved from the source rather than from the clicked row.
  const targets =
    scope === "module" && mod.sourceId
      ? await database.terraformModule.findMany({
          where: { userId, sourceId: mod.sourceId },
          select: { id: true },
        })
      : await database.terraformModule.findMany({
          where: {
            userId,
            OR: [{ id: mod.id }, { parentModuleId: mod.id }],
          },
          select: { id: true },
        });

  const targetIds = targets.map((t) => t.id);

  await database.$transaction(async (tx) => {
    // `parentModuleId` is ON DELETE SET NULL, so submodules would survive as
    // orphans that still claim `isSubmodule = true`. Deleting the whole set in
    // one statement avoids relying on that cascade at all.
    await tx.terraformModule.deleteMany({
      where: { id: { in: targetIds }, userId },
    });

    // The source carries the name, description and tags. Keeping it while other
    // versions remain preserves that metadata; dropping it once the last
    // version is gone avoids an invisible orphan row.
    if (mod.sourceId) {
      const remaining = await tx.terraformModule.count({
        where: { sourceId: mod.sourceId },
      });

      if (remaining === 0) {
        await tx.terraformModuleSource.deleteMany({
          where: { id: mod.sourceId, userId },
        });
      }
    }
  });

  return NextResponse.json({
    deleted: { scope, moduleIds: targetIds },
  });
}
