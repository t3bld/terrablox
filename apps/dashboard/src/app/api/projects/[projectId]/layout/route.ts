import { NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonBody, requireUserWithLimit } from "@/lib/api/guard";
import { notFound, routeError } from "@/lib/api/route-error";
import * as schema from "@/lib/api/schemas";
import { database } from "@/lib/database";
import { maxGraphLayoutNodes } from "@/lib/graph-layout";
import { findOwnedProject } from "@/lib/projects/service";

/**
 * Node positions.
 *
 * `z.record` validates the values and drops nothing silently — the previous version
 * filtered non-numeric entries out and accepted the request, which meant a client bug
 * produced a half-saved layout and no error. Coordinates must be finite so a `NaN`,
 * which `typeof === "number"` happily admits, cannot reach the column and come back
 * as `null` in JSON.
 */
const layoutBody = z.object({
  positions: z
    .record(z.string().min(1).max(200), schema.position)
    // The same ceiling the module layout uses, from the same constant: both are a
    // node-position map in a JSON column, and the map used to be unbounded here.
    .refine((value) => Object.keys(value).length <= maxGraphLayoutNodes, {
      message: `A layout may describe at most ${maxGraphLayoutNodes} nodes.`,
    }),
});

/**
 * Stores node positions.
 *
 * Layout is presentation, not configuration, so it is kept in the database
 * rather than committed: dragging a node must not produce a commit.
 */
export async function PUT(
  req: Request,
  { params }: { params: { projectId: string } },
) {
  try {
    const userId = await requireUserWithLimit("project.layout");

    const project = await findOwnedProject(userId, params.projectId);
    if (!project) return notFound("Project not found");

    const body = await parseJsonBody(req, layoutBody);

    await database.project.update({
      where: { id: project.id },
      data: { graphPositions: body.positions },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return routeError("project.layout", error);
  }
}
