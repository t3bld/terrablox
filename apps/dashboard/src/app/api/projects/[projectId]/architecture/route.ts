import { NextResponse } from "next/server";

import { getCurrentUserId } from "@/lib/auth/server-helpers";
import { findOwnedProject } from "@/lib/projects/service";
import {
  clampArchitectureDepth,
  loadModuleArchitectures,
} from "@/lib/terraform/module-architecture-service";

/**
 * Supplies the contents of the modules a project's canvas calls, so the canvas
 * can be redrawn one level up: AWS services and the wires between them instead
 * of module blocks and their inputs.
 *
 * The ids come from the caller because the browser already holds the parsed
 * graph — re-reading the repository here would double the work for a view the
 * user toggles back and forth. They are safe to trust: every query below is
 * scoped to the caller's own modules, so an unknown id yields nothing.
 */

/** Enough for any real project canvas; a guard against a hand-crafted URL. */
const MAX_MODULES = 100;

export async function GET(
  req: Request,
  { params }: { params: { projectId: string } },
) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const project = await findOwnedProject(userId, params.projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const query = new URL(req.url).searchParams;
  const moduleIds = (query.get("modules") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .slice(0, MAX_MODULES);

  const modules = await loadModuleArchitectures(
    userId,
    moduleIds,
    clampArchitectureDepth(query.get("depth")),
  );

  return NextResponse.json({ modules });
}
