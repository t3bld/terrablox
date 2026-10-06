import { NextResponse } from "next/server";
import { z } from "zod";

import {
  parseJsonBody,
  requireUserId,
  requireUserWithLimit,
} from "@/lib/api/guard";
import { notFound, routeError } from "@/lib/api/route-error";
import * as schema from "@/lib/api/schemas";
import { audit } from "@/lib/audit/log";
import { database } from "@/lib/database";
import { toProjectDto } from "@/lib/projects/serialize";
import { findOwnedProject } from "@/lib/projects/service";

export async function GET(
  _req: Request,
  { params }: { params: { projectId: string } },
) {
  try {
    const userId = await requireUserId({ action: "project.read" });

    const project = await findOwnedProject(userId, params.projectId);
    if (!project) return notFound("Project not found");

    return NextResponse.json({ project: toProjectDto(project) });
  } catch (error) {
    return routeError("project.read", error);
  }
}

/**
 * The editable project fields.
 *
 * `name` is capped rather than pattern-matched: it is a display string, so restricting
 * the characters would reject legitimate names, and the places that turn it into an
 * identifier slugify it. It does reach a CloudFormation `Description:` — see
 * `yamlInline` in `lib/projects/deploy.ts`, which is where that is made safe.
 *
 * `branch` and `terraformEntryFile` both become path segments in GitHub API URLs, so
 * they get the ref and relative-path rules rather than a bare trim.
 */
const patchBody = z.object({
  name: schema.displayText(200).optional(),
  description: schema.optionalText(2000).optional(),
  branch: schema.gitRef.optional(),
  terraformEntryFile: schema.relativeFolder.optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: { projectId: string } },
) {
  try {
    const userId = await requireUserWithLimit("project.write");

    const project = await findOwnedProject(userId, params.projectId);
    if (!project) return notFound("Project not found");

    const body = await parseJsonBody(req, patchBody);

    const updated = await database.project.update({
      where: { id: project.id },
      data: {
        ...(body.name ? { name: body.name } : {}),
        ...(body.description !== undefined
          ? { description: body.description }
          : {}),
        ...(body.branch ? { repoBranch: body.branch } : {}),
        ...(body.terraformEntryFile
          ? { terraformEntryFile: body.terraformEntryFile }
          : {}),
      },
    });

    return NextResponse.json({ project: toProjectDto(updated) });
  } catch (error) {
    return routeError("project.write", error);
  }
}

/**
 * Deletes the project. The repository it points at is never touched.
 *
 * Deliberately not offered as a choice. Deleting the repository on GitHub was
 * considered and dropped: it would need the `delete_repo` OAuth scope, which means
 * Terrablox permanently holding the power to delete any of a user's repositories
 * for something they do a handful of times — and the action is irreversible on a
 * side we do not own. Somebody who wants the repository gone can do it on GitHub,
 * where the confirmation belongs.
 *
 * Nor is there anything else to clean up. Everything keyed to this project goes
 * with the row, and because the repository survives, Terrablox's other references
 * to it stay correct — another project reading it as its application repository
 * still reads it fine, so clearing that link would break something that works.
 */
export async function DELETE(
  _req: Request,
  { params }: { params: { projectId: string } },
) {
  try {
    const userId = await requireUserWithLimit("project.write");

    const project = await findOwnedProject(userId, params.projectId);
    if (!project) return notFound("Project not found");

    await database.project.delete({ where: { id: project.id } });

    // Cascades take the graph, the transcript and the decisions with it, so this is
    // the one row left afterwards that says the project ever existed.
    await audit({
      action: "project.deleted",
      userId,
      subject: project.id,
      detail: { name: project.name, repo: project.repoFullName },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return routeError("project.write", error);
  }
}
