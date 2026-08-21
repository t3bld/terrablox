import { NextResponse } from "next/server";

import { getCurrentUserId } from "@/lib/auth/server-helpers";
import { database } from "@/lib/database";
import { isBuiltin, ownedByUser, visibleToUser } from "@/lib/modules/ownership";
import { parseScope } from "@/lib/terraform/delete-scope";

/**
 * Reports what a delete would destroy.
 *
 * Deleting a module cascades into `canvas_nodes` (and from there into
 * `connections`), which lives in a completely different part of the product.
 * The confirmation dialog needs to name those projects rather than silently
 * wiping a user's canvas.
 */
export async function GET(
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

  // Visibility, then the same builtin refusal the DELETE handler gives. Without
  // it a builtin would 404 here and the dialog would report a load failure for
  // something that is simply not deletable.
  const mod = await database.terraformModule.findFirst({
    where: { id: moduleId, ...visibleToUser(userId) },
    select: { id: true, sourceId: true, userId: true },
  });

  if (!mod) {
    return NextResponse.json({ error: "Module not found" }, { status: 404 });
  }

  if (isBuiltin(mod)) {
    return NextResponse.json(
      {
        error:
          "This module ships with TerraBlox and cannot be deleted. Every user shares it.",
      },
      { status: 403 },
    );
  }

  // Mirrors the target selection in the DELETE handler, so the warning can
  // never describe a smaller blast radius than the deletion actually has.
  const targets =
    scope === "module" && mod.sourceId
      ? await database.terraformModule.findMany({
          where: { ...ownedByUser(userId), sourceId: mod.sourceId },
          select: { id: true, isSubmodule: true },
        })
      : await database.terraformModule.findMany({
          where: {
            ...ownedByUser(userId),
            OR: [{ id: mod.id }, { parentModuleId: mod.id }],
          },
          select: { id: true, isSubmodule: true },
        });

  const targetIds = targets.map((t) => t.id);

  const [canvasNodes, remainingAfterDelete] = await Promise.all([
    database.canvasNode.findMany({
      where: { moduleId: { in: targetIds }, project: { userId } },
      select: { id: true, project: { select: { id: true, name: true } } },
    }),
    mod.sourceId
      ? database.terraformModule.count({
          where: {
            ...ownedByUser(userId),
            sourceId: mod.sourceId,
            id: { notIn: targetIds },
          },
        })
      : Promise.resolve(0),
  ]);

  const projects = [
    ...new Map(
      canvasNodes.map((node) => [node.project.id, node.project]),
    ).values(),
  ].sort((a, b) => a.name.localeCompare(b.name));

  return NextResponse.json({
    impact: {
      scope,
      versionCount: targets.filter((t) => !t.isSubmodule).length,
      submoduleCount: targets.filter((t) => t.isSubmodule).length,
      canvasNodeCount: canvasNodes.length,
      projects,
      // True when the repository disappears from the overview entirely.
      isLastVersion: remainingAfterDelete === 0,
    },
  });
}
