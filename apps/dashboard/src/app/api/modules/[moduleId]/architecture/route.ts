import { NextResponse } from "next/server";

import { getCurrentUserId } from "@/lib/auth/server-helpers";
import {
  clampArchitectureDepth,
  loadModuleArchitectures,
} from "@/lib/terraform/module-architecture-service";

/**
 * Supplies a module together with the modules it calls, so the architecture
 * diagram can draw a wrapper's real shape rather than a row of opaque boxes.
 *
 * The traversal itself lives in the service, because the project canvas needs
 * exactly the same data for every module block on it.
 */
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

  const depth = clampArchitectureDepth(
    new URL(req.url).searchParams.get("depth"),
  );
  const modules = await loadModuleArchitectures(userId, [rootId], depth);

  if (!modules[rootId]) {
    return NextResponse.json({ error: "Module not found" }, { status: 404 });
  }

  return NextResponse.json({ rootId, depth, modules });
}
