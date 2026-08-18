import "server-only";

import { database } from "@/lib/database";
import {
  resolveDependents,
  resolveModuleLinks,
} from "@/lib/terraform/module-link";
import { sortVersionsDesc } from "@/lib/terraform/versions";

/**
 * Everything the module detail screen shows, in one pass.
 *
 * Shared by the page and `/api/modules/[moduleId]` so a server render and a
 * client refetch cannot drift apart.
 */
export async function loadModuleDetail(userId: string, moduleId: string) {
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

  if (!mod) return null;

  // None of the three depends on the others, so they travel together rather
  // than as three round trips.
  const [siblingVersions, candidateRows, allDependencies] = await Promise.all([
    // Sibling versions power the header's version switcher. Scoped to root
    // modules of the same repository; a submodule switches versions through
    // its parent, not on its own.
    mod.sourceId
      ? database.terraformModule.findMany({
          where: { userId, sourceId: mod.sourceId, isSubmodule: false },
          select: { id: true, versionTag: true, createdAt: true },
        })
      : Promise.resolve([]),

    // Every module the user owns is a candidate target for a `module` block, so
    // dependencies resolve regardless of the order things were imported in.
    database.terraformModule.findMany({
      where: { userId },
      select: {
        id: true,
        versionTag: true,
        terraformRootFolder: true,
        submoduleName: true,
        createdAt: true,
        source: { select: { name: true, url: true } },
      },
    }),

    // The reverse direction. Loading every dependency the user owns keeps this
    // a single query; resolution then decides which land on this module.
    database.moduleDependency.findMany({
      where: { module: { userId } },
      select: { name: true, source: true, sourceKind: true, moduleId: true },
    }),
  ]);

  const linkCandidates = candidateRows.map((candidate) => ({
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

  return {
    ...mod,
    dependencies: mod.dependencies.map((dependency) => ({
      ...dependency,
      linkedModule: links.get(dependency.id) ?? null,
    })),
    dependents: resolveDependents(mod.id, allDependencies, linkCandidates),
    effectiveName: mod.submoduleName ?? mod.source?.name ?? "(unnamed)",
    effectiveDescription: mod.source?.description ?? null,
    versions: sortVersionsDesc(siblingVersions).map((version) => ({
      id: version.id,
      versionTag: version.versionTag,
      createdAt: version.createdAt.toISOString(),
    })),
  };
}

/**
 * The breadcrumb and sibling switcher for a submodule's parent.
 *
 * Deliberately not {@link loadModuleDetail}: the parent's resources, references
 * and dependencies are never rendered here, and loading them was the single
 * most expensive part of opening a submodule.
 */
export async function loadModuleParent(userId: string, parentId: string) {
  const parent = await database.terraformModule.findFirst({
    where: { id: parentId, userId },
    select: {
      id: true,
      submoduleName: true,
      source: { select: { name: true } },
      submodules: {
        select: { id: true, submoduleName: true, terraformRootFolder: true },
      },
    },
  });

  if (!parent) return null;

  return {
    id: parent.id,
    effectiveName:
      parent.submoduleName ?? parent.source?.name ?? "Parent module",
    submodules: parent.submodules,
  };
}
