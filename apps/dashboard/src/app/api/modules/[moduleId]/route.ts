import { NextResponse } from "next/server";

import { getCurrentUserId } from "@/lib/auth/server-helpers";
import { database } from "@/lib/database";
import { loadModuleDetail } from "@/lib/modules/detail-service";
import { parseScope } from "@/lib/terraform/delete-scope";

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

  const module = await loadModuleDetail(userId, moduleId);

  if (!module) {
    return NextResponse.json({ error: "Module not found" }, { status: 404 });
  }

  return NextResponse.json({ module });
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
