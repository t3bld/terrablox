import { NextResponse } from "next/server";
import { z } from "zod";

import { parseJsonBody, requireUserWithLimit } from "@/lib/api/guard";
import { routeError } from "@/lib/api/route-error";
import { getProviderTokenForRequest } from "@/lib/auth/server-helpers";
import { database } from "@/lib/database";
import {
  AppRepoInputError,
  appRepoColumns,
  parseAppRepoInput,
  verifyAppRepoAccess,
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
  let userId: string;
  let body: { appRepo?: unknown };
  try {
    userId = await requireUserWithLimit("project.write");
    // Shape only: `parseAppRepoInput` owns the owner/name and branch rules, and it
    // has to keep owning them because the agent path calls it too. What this adds is
    // the body-size cap that `req.json()` had no notion of.
    body = await parseJsonBody(req, z.object({ appRepo: z.unknown() }));
  } catch (error) {
    return routeError("project.app-repo", error);
  }

  let link: ReturnType<typeof parseAppRepoInput>;
  try {
    // `undefined` would mean "leave it alone", which is not something this
    // endpoint can be asked for: it exists only to set the value.
    link = parseAppRepoInput(body.appRepo ?? null);

    // Checked against the credential that will do the reading, so a link that
    // cannot work is refused here rather than discovered by the agent mid-turn.
    // Unlinking needs no check: there is nothing to reach.
    if (link) {
      const token = await getProviderTokenForRequest(req, "github");
      if (!token) {
        return NextResponse.json(
          { error: "GitHub is not connected" },
          { status: 401 },
        );
      }
      link = await verifyAppRepoAccess(token, link);
    }
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
