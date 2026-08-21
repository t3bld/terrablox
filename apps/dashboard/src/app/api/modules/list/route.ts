import { NextResponse } from "next/server";

import { getCurrentUserId } from "@/lib/auth/server-helpers";
import { database } from "@/lib/database";
import { isBuiltin, visibleToUser } from "@/lib/modules/ownership";
import { pickDefaultVersion, sortVersionsDesc } from "@/lib/terraform/versions";

/**
 * Lists modules grouped by repository.
 *
 * A repository is one `TerraformModuleSource`; every imported ref adds another
 * `TerraformModule` row beneath it. The overview shows repositories, not rows,
 * so the grouping happens here rather than in the client — the client would
 * otherwise need the full row set just to render a version count.
 */
export async function GET() {
  const userId = await getCurrentUserId();

  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const modules = await database.terraformModule.findMany({
    where: visibleToUser(userId),
    include: { source: true },
  });

  const submoduleCountByParent = new Map<string, number>();
  for (const mod of modules) {
    if (!mod.isSubmodule || !mod.parentModuleId) continue;
    submoduleCountByParent.set(
      mod.parentModuleId,
      (submoduleCountByParent.get(mod.parentModuleId) ?? 0) + 1,
    );
  }

  interface Version {
    id: string;
    versionTag: string | null;
    url: string | null;
    terraformRootFolder: string | null;
    submoduleCount: number;
    createdAt: Date;
    updatedAt: Date;
  }

  interface Group {
    sourceId: string | null;
    name: string;
    description: string | null;
    tags: string[];
    url: string | null;
    provider: string | null;
    /** Which icon source the module shows: `repo`, `aws` or `none`. */
    iconMode: string;
    /** True when the repository ships its own icon; served through our proxy. */
    hasIcon: boolean;
    /** A bundled AWS icon chosen at import, without the extension. */
    iconName: string | null;
    /**
     * Part of the catalogue TerraBlox ships with, so the card hides the actions
     * that would fail. Read from the row rather than passed in: a group is keyed
     * by source, and a source is either shipped or owned, never both.
     */
    isBuiltin: boolean;
    versions: Version[];
  }

  const groups = new Map<string, Group>();

  for (const mod of modules) {
    if (mod.isSubmodule) continue;

    // Rows imported before sources existed have no sourceId. Keying those by
    // their own id keeps them as separate single-version entries instead of
    // collapsing all of them into one shared "null" repository.
    const key = mod.sourceId ?? `module:${mod.id}`;

    let group = groups.get(key);
    if (!group) {
      group = {
        sourceId: mod.sourceId,
        name: mod.source?.name ?? mod.submoduleName ?? "(unnamed)",
        description: mod.source?.description ?? null,
        tags: mod.source?.tags ?? [],
        url: mod.source?.url ?? null,
        provider: mod.source?.provider ?? null,
        iconMode: mod.source?.iconMode ?? "repo",
        hasIcon: Boolean(mod.source?.iconUrl),
        iconName: mod.source?.iconName ?? null,
        isBuiltin: isBuiltin(mod),
        versions: [],
      };
      groups.set(key, group);
    }

    group.versions.push({
      id: mod.id,
      versionTag: mod.versionTag,
      url: mod.url,
      terraformRootFolder: mod.terraformRootFolder,
      submoduleCount: submoduleCountByParent.get(mod.id) ?? 0,
      createdAt: mod.createdAt,
      updatedAt: mod.updatedAt,
    });
  }

  const repositories = [...groups.entries()]
    .map(([key, group]) => {
      const versions = sortVersionsDesc(group.versions);
      const lastActivity = versions.reduce(
        (newest, v) => (v.updatedAt > newest ? v.updatedAt : newest),
        new Date(0),
      );

      const serialized = versions.map((v) => ({
        ...v,
        createdAt: v.createdAt.toISOString(),
        updatedAt: v.updatedAt.toISOString(),
      }));

      return {
        key,
        sourceId: group.sourceId,
        name: group.name,
        description: group.description,
        tags: group.tags,
        url: group.url,
        provider: group.provider,
        iconMode: group.iconMode,
        hasIcon: group.hasIcon,
        iconName: group.iconName,
        isBuiltin: group.isBuiltin,
        // The tracked branch rather than the newest tag — see pickDefaultVersion.
        // `versions` stays newest-first, so the switcher still reads as a history.
        defaultVersion: pickDefaultVersion(serialized),
        versionCount: serialized.length,
        totalSubmoduleCount: versions.reduce(
          (sum, v) => sum + v.submoduleCount,
          0,
        ),
        versions: serialized,
        updatedAt: lastActivity.toISOString(),
      };
    })
    .filter((repo) => repo.defaultVersion !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return NextResponse.json({ repositories });
}
