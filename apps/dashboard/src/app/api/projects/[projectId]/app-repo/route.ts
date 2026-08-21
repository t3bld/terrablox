import { NextResponse } from "next/server";

import { getCurrentUserId } from "@/lib/auth/server-helpers";
import { database } from "@/lib/database";
import {
  AppRepoInputError,
  appRepoColumns,
  parseAppRepoInput,
} from "@/lib/projects/app-repo";
import { toProjectDto } from "@/lib/projects/serialize";

/**
 * Links a project to the application it builds infrastructure for, or unlinks it.
 *
 * Its own endpoint rather than a field on a general project update, because it is
 * reached from the agent harness — the screen that says what the agent can see.
 * That is also why it exists at all: without it the link could only ever be set
 * while creating a project, so every project made before the feature existed
 * would be permanently unable to have one.
 */
export async function PUT(
  req: Request,
  { params }: { params: { projectId: string } },
) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as {
    appRepo?: unknown;
  } | null;

  let link: ReturnType<typeof parseAppRepoInput>;
  try {
    // `undefined` would mean "leave it alone", which is not something this
    // endpoint can be asked for: it exists only to set the value.
    link = parseAppRepoInput(body?.appRepo ?? null);
  } catch (e) {
    return NextResponse.json(
      {
        error:
          e instanceof AppRepoInputError
            ? e.message
            : "Invalid application repository",
      },
      { status: 400 },
    );
  }

  // Scoped by userId so a guessed project id cannot rewrite someone else's
  // project. `updateMany` returns a count instead of throwing on no match.
  const { count } = await database.project.updateMany({
    where: { id: params.projectId, userId },
    data: appRepoColumns(link ?? null),
  });

  if (count === 0) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const project = await database.project.findFirst({
    where: { id: params.projectId, userId },
  });

  return NextResponse.json({
    project: project ? toProjectDto(project) : null,
  });
}
