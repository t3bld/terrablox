import { NextResponse } from "next/server";
import { z } from "zod";
import { parseJsonBody, requireUserWithLimit } from "@/lib/api/guard";
import { RATE_LIMITS } from "@/lib/api/rate-limit";
import { routeError, unauthorized } from "@/lib/api/route-error";
import * as schema from "@/lib/api/schemas";
import { getProviderTokenForRequest } from "@/lib/auth/server-helpers";
import { parseIconChoice } from "@/lib/module-library/icon";
import { importModuleFromGit } from "@/lib/module-library/import-from-git";

/**
 * Imports a repository into the signed-in user's module library.
 *
 * Authentication, validation and status codes only: the pipeline itself lives in
 * {@link importModuleFromGit} because the shipped catalogue runs the same one
 * with a null owner.
 */

/**
 * The import request.
 *
 * `repoFullName` gets a real pattern rather than the "contains a slash" check it used
 * to have. Both halves become path segments in every GitHub API URL built from the
 * value, so a name like `owner/repo/../../users/x` moved the request to a different
 * endpoint — harmless in effect, because GitHub answered 404, but the shape of the bug
 * is path traversal and it should not depend on the upstream being strict.
 *
 * The arrays were unbounded. `tags` and `terraformSubmodulesFolders` are both looped
 * over and persisted, and nothing capped either of them.
 */
const importBody = z.object({
  repoFullName: schema.repoFullName,
  refType: z.enum(["release", "branch", "tag"]),
  refName: schema.gitRef,
  terraformRootFolder: schema.relativeFolder.optional(),
  terraformSubmodulesFolders: z
    .array(schema.relativeFolder)
    .max(100, "That is more submodule folders than a repository has")
    .optional(),
  nameOverride: schema.displayText(200).optional(),
  description: z.string().max(2000).optional(),
  tags: schema.tags.optional(),
  /** `{ mode, iconName }`; absent leaves whatever the source row already says. */
  icon: z.unknown().optional(),
});

export async function POST(req: Request) {
  try {
    // Its own budget: an import walks a whole repository tree and writes a module
    // plus its submodules, so it is far heavier than an ordinary write.
    const userId = await requireUserWithLimit(
      "modules.import",
      RATE_LIMITS.importModule,
    );

    const body = await parseJsonBody(req, importBody);

    // Null for a caller that said nothing, which leaves the stored choice alone.
    // Anything malformed is treated the same way rather than rejected: the icon is
    // decoration, and failing an import over it would be out of proportion.
    const icon = parseIconChoice(body.icon);

    const token = await getProviderTokenForRequest(req, "github");
    if (!token) return unauthorized("Missing or invalid provider token");

    const result = await importModuleFromGit({
      userId,
      token,
      repoFullName: body.repoFullName,
      refType: body.refType,
      refName: body.refName,
      ...(body.terraformRootFolder !== undefined
        ? { terraformRootFolder: body.terraformRootFolder }
        : {}),
      ...(body.terraformSubmodulesFolders !== undefined
        ? { terraformSubmodulesFolders: body.terraformSubmodulesFolders }
        : {}),
      ...(body.nameOverride !== undefined
        ? { nameOverride: body.nameOverride }
        : {}),
      ...(body.description !== undefined
        ? { description: body.description }
        : {}),
      ...(body.tags !== undefined ? { tags: body.tags } : {}),
      icon,
    });

    return NextResponse.json(
      {
        module: result.module,
        submodules: result.submodules,
        source: result.source,
        warnings: result.warnings,
      },
      { status: 201 },
    );
  } catch (e) {
    // Through `routeError` rather than echoing the message: this used to return
    // `e.message` with a 500 for anything at all, which handed Prisma column names
    // and GitHub error bodies to the caller.
    return routeError("modules.import", e);
  }
}
