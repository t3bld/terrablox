import { NextResponse } from "next/server";

import { getCurrentUserId } from "@/lib/auth/server-helpers";
import { database } from "@/lib/database";
import { toProjectDto } from "@/lib/projects/serialize";
import { findOwnedProject } from "@/lib/projects/service";

export async function GET(
  _req: Request,
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

  return NextResponse.json({ project: toProjectDto(project) });
}

interface PatchBody {
  name?: string;
  description?: string | null;
  branch?: string;
  terraformEntryFile?: string;
}

export async function PATCH(
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

  const body = (await req.json().catch(() => null)) as PatchBody | null;
  if (!body) {
    return NextResponse.json({ error: "Missing body" }, { status: 400 });
  }

  const updated = await database.project.update({
    where: { id: project.id },
    data: {
      ...(body.name?.trim() ? { name: body.name.trim() } : {}),
      ...(body.description !== undefined
        ? { description: body.description?.trim() || null }
        : {}),
      ...(body.branch?.trim() ? { repoBranch: body.branch.trim() } : {}),
      ...(body.terraformEntryFile?.trim()
        ? { terraformEntryFile: body.terraformEntryFile.trim() }
        : {}),
    },
  });

  return NextResponse.json({ project: toProjectDto(updated) });
}

/** Deletes the project only. The repository it points at is left untouched. */
export async function DELETE(
  _req: Request,
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

  await database.project.delete({ where: { id: project.id } });

  return NextResponse.json({ ok: true });
}
