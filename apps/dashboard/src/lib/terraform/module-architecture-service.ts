/**
 * Loads modules together with the modules they call, so an architecture
 * diagram can draw a wrapper's real shape rather than a row of opaque boxes.
 *
 * The result is a flat map keyed by module id, not a nested tree. A module is
 * commonly called more than once — `ap-aws-standalone-vpc` calls the same
 * `endpoints` submodule twice — and a tree would ship its contents once per
 * call site.
 *
 * Shared by the module page (one root) and the project canvas (one root per
 * `module` block on the canvas), because the traversal is the same either way.
 */

import { database } from "@/lib/database";
import { visibleToUser } from "@/lib/modules/ownership";
import { resolveModuleLinks } from "./module-link";

/**
 * Deep enough for the real shapes (root -> wrapper -> service module), shallow
 * enough that one page view cannot walk an entire module estate.
 */
export const MAX_ARCHITECTURE_DEPTH = 4;

export interface ModuleArchitectureRecord {
  id: string;
  name: string;
  versionTag: string | null;
  resources: unknown[];
  references: unknown[];
  moduleCalls: {
    name: string;
    source: string | null;
    /** Carried through so a registry address is not read as a Git URL. */
    sourceKind: string | null;
    linkedModule: {
      moduleId: string;
      exactVersion: boolean;
      requestedRef: string | null;
    } | null;
  }[];
}

export function clampArchitectureDepth(requested: unknown): number {
  const value = Number(requested ?? MAX_ARCHITECTURE_DEPTH);
  return Number.isFinite(value)
    ? Math.min(Math.max(Math.trunc(value), 1), MAX_ARCHITECTURE_DEPTH)
    : MAX_ARCHITECTURE_DEPTH;
}

export async function loadModuleArchitectures(
  userId: string,
  rootIds: string[],
  depth: number,
): Promise<Record<string, ModuleArchitectureRecord>> {
  const modules: Record<string, ModuleArchitectureRecord> = {};
  if (rootIds.length === 0) return modules;

  // Loaded once and reused at every level: link resolution needs the full set
  // of modules the user can see regardless of which level is being expanded.
  const linkCandidates = (
    await database.terraformModule.findMany({
      where: visibleToUser(userId),
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

  const seen = new Set<string>();
  let frontier = [...new Set(rootIds)];

  for (let level = 0; level <= depth && frontier.length > 0; level++) {
    const batch = await database.terraformModule.findMany({
      // Scoped at every level, not just the roots: a module id reached by
      // traversal is still an id the caller must be allowed to read.
      where: { id: { in: frontier }, ...visibleToUser(userId) },
      include: {
        source: { select: { name: true } },
        resources: {
          // The extra columns exist so a box inside an expanded module opens
          // the same detail panel as one belonging to the module itself. They
          // are short (a file path and a docs URL) and the rows were already
          // being sent, so this widens the payload rather than lengthening it.
          select: {
            resourceType: true,
            resourceName: true,
            kind: true,
            providerName: true,
            providerUrl: true,
            sourceFile: true,
            // Decides whether a nested subnet is drawn as public or only
            // conditionally public, so it has to travel with the resource.
            conditionalOn: true,
            resourceUrl: true,
            resourceDescription: true,
          },
        },
        references: {
          select: { fromAddress: true, toAddress: true, attributes: true },
        },
        dependencies: {
          select: { id: true, name: true, source: true, sourceKind: true },
          orderBy: { name: "asc" },
        },
      },
    });

    const next: string[] = [];

    for (const mod of batch) {
      seen.add(mod.id);

      const links = resolveModuleLinks(
        mod.dependencies,
        linkCandidates.filter((candidate) => candidate.id !== mod.id),
      );

      modules[mod.id] = {
        id: mod.id,
        name: mod.submoduleName ?? mod.source?.name ?? "(unnamed)",
        versionTag: mod.versionTag,
        resources: mod.resources,
        references: mod.references,
        moduleCalls: mod.dependencies.map((dependency) => ({
          name: dependency.name,
          source: dependency.source,
          sourceKind: dependency.sourceKind,
          linkedModule: links.get(dependency.id) ?? null,
        })),
      };

      // The frontier only grows with modules not yet seen, which is what stops
      // a cycle (A calls B calls A) from looping forever.
      for (const link of links.values()) {
        if (!seen.has(link.moduleId) && !next.includes(link.moduleId)) {
          next.push(link.moduleId);
        }
      }
    }

    frontier = next;
  }

  return modules;
}
