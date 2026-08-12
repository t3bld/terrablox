import { NextResponse } from "next/server";

import { getCurrentUserId } from "@/lib/auth/server-helpers";
import { database } from "@/lib/database";
import { resolveModuleLinks } from "@/lib/terraform/module-link";

/**
 * Supplies a module together with the modules it calls, so the architecture
 * diagram can draw a wrapper's real shape rather than a row of opaque boxes.
 *
 * The result is a flat map keyed by module id, not a nested tree. A module is
 * commonly called more than once — `ap-aws-standalone-vpc` calls the same
 * `endpoints` submodule twice — and a tree would ship its contents once per
 * call site.
 */

/**
 * Deep enough for the real shapes (root -> wrapper -> service module), shallow
 * enough that one page view cannot walk an entire module estate.
 */
const MAX_DEPTH = 4;

export async function GET(
  req: Request,
  { params }: { params: { moduleId: string } },
) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rootId = params.moduleId?.trim();
  if (!rootId) {
    return NextResponse.json({ error: "Missing moduleId" }, { status: 400 });
  }

  const requestedDepth = Number(
    new URL(req.url).searchParams.get("depth") ?? MAX_DEPTH,
  );
  const depth = Number.isFinite(requestedDepth)
    ? Math.min(Math.max(Math.trunc(requestedDepth), 1), MAX_DEPTH)
    : MAX_DEPTH;

  // Loaded once and reused at every level: link resolution needs the full set
  // of the user's modules regardless of which level is being expanded.
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

  const modules: Record<string, unknown> = {};
  const seen = new Set<string>();
  let frontier = [rootId];

  for (let level = 0; level <= depth && frontier.length > 0; level++) {
    const batch = await database.terraformModule.findMany({
      // Scoped by userId at every level, not just the root: a module id reached
      // by traversal is still an id the caller must be allowed to read.
      where: { id: { in: frontier }, userId },
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
            sourceFile: true,
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

  if (!modules[rootId]) {
    return NextResponse.json({ error: "Module not found" }, { status: 404 });
  }

  return NextResponse.json({ rootId, depth, modules });
}
