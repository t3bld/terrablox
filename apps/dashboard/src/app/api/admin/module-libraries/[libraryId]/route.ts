import { NextResponse } from "next/server";

import { parseJsonBody } from "@/lib/api/guard";
import { ApiError, routeError } from "@/lib/api/route-error";
import { type AuditAction, audit } from "@/lib/audit/log";
import { requireAdmin } from "@/lib/auth/admin";
import { database } from "@/lib/database";

import {
  type EditLibraryBody,
  editLibraryBody,
  type PatchLibraryBody,
  patchLibraryBody,
} from "../schema";

interface RouteContext {
  params: { libraryId: string };
}

function isPrismaError(error: unknown, code: string): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code
  );
}

function sameTopics(left: string[], right: string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();

  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((topic, index) => topic === sortedRight[index])
  );
}

async function countsFor(library: { id: string; scope: string }) {
  const userId = library.scope === "global" ? null : { not: null };
  const [users, sources, modules] = await Promise.all([
    library.scope === "user"
      ? database.moduleLibrarySync.count({ where: { library: library.id } })
      : Promise.resolve(0),
    database.terraformModuleSource.count({
      where: { library: library.id, userId },
    }),
    database.terraformModule.count({
      where: { library: library.id, userId },
    }),
  ]);

  return { users, sources, modules };
}

async function updateLibrary(
  request: Request,
  context: RouteContext,
  method: "PUT" | "PATCH",
) {
  const action = `admin.module-libraries.${method.toLowerCase()}`;

  try {
    const userId = await requireAdmin(action);
    const body: EditLibraryBody | PatchLibraryBody =
      method === "PATCH"
        ? await parseJsonBody(request, patchLibraryBody)
        : await parseJsonBody(request, editLibraryBody);

    const current = await database.moduleLibraryDefinition.findUnique({
      where: { id: context.params.libraryId },
    });
    if (!current) throw new ApiError("Module library not found.", 404);

    const requestedActive = "active" in body ? body.active : undefined;
    const nextActive = requestedActive ?? current.active;
    const nextVisible = body.visible ?? current.visible;
    const nextOrg = body.org ?? current.org;
    const nextTopics = body.topics ?? current.topics;
    const nextPrefix = body.prefix === undefined ? current.prefix : body.prefix;
    const nextPublicOnly =
      current.scope === "global"
        ? (body.publicOnly ?? current.publicOnly)
        : false;
    const nextSubmoduleContainer =
      body.submoduleContainer === undefined
        ? current.submoduleContainer
        : body.submoduleContainer;

    if (nextTopics.length === 0 && !nextPrefix) {
      throw new ApiError(
        "needs at least one topic or a prefix, otherwise it would match every repository in the org",
        400,
      );
    }

    const selectionChanged =
      nextOrg.toLowerCase() !== current.org.toLowerCase() ||
      !sameTopics(nextTopics, current.topics) ||
      nextPrefix !== current.prefix ||
      nextPublicOnly !== current.publicOnly ||
      nextSubmoduleContainer !== current.submoduleContainer;
    const archived = current.active && nextActive === false;
    const restored = !current.active && nextActive === true;
    const closeSyncs = selectionChanged || archived;

    if (selectionChanged && current.scope === "global") {
      const importedSources = await database.terraformModuleSource.count({
        where: { userId: null, library: current.id },
      });
      if (importedSources > 0) {
        throw new ApiError(
          "Reset this global library before changing its repository selection. This prevents old shared modules from being published under the new definition.",
          409,
        );
      }
    }

    const result = await database.$transaction(async (tx) => {
      if (nextOrg.toLowerCase() !== current.org.toLowerCase()) {
        const sameOrganization = await tx.moduleLibraryDefinition.findFirst({
          where: {
            active: true,
            id: { not: current.id },
            scope: current.scope,
            org: { equals: nextOrg, mode: "insensitive" },
          },
          select: { id: true },
        });
        if (sameOrganization) {
          throw new ApiError(
            `A ${current.scope} module library already reads '${nextOrg}'.`,
            409,
          );
        }
      }

      const library = await tx.moduleLibraryDefinition.update({
        where: { id: current.id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.org !== undefined ? { org: nextOrg } : {}),
          ...(body.topics !== undefined ? { topics: nextTopics } : {}),
          ...(body.prefix !== undefined ? { prefix: nextPrefix } : {}),
          ...(body.publicOnly !== undefined || current.scope === "user"
            ? { publicOnly: nextPublicOnly }
            : {}),
          ...(body.submoduleContainer !== undefined
            ? { submoduleContainer: nextSubmoduleContainer }
            : {}),
          ...(body.pipelineSecret !== undefined
            ? { pipelineSecret: body.pipelineSecret }
            : {}),
          ...("active" in body && body.active !== undefined
            ? { active: nextActive }
            : {}),
          ...(body.visible !== undefined ? { visible: nextVisible } : {}),
        },
      });

      const invalidatedSyncs = closeSyncs
        ? await tx.moduleLibrarySync.updateMany({
            where: { library: current.id },
            data: {
              state: "never",
              pending: false,
              repos: {},
              lastAttemptAt: null,
              lockId: null,
              lockedUntil: null,
            },
          })
        : { count: 0 };

      return { library, invalidatedSyncs: invalidatedSyncs.count };
    });

    const auditAction: AuditAction = archived
      ? "module-library.archived"
      : restored
        ? "module-library.restored"
        : "module-library.updated";
    const changedFields = Object.keys(body);

    await audit({
      action: auditAction,
      userId,
      subject: current.id,
      detail: { changedFields, invalidatedSyncs: result.invalidatedSyncs },
    });

    return NextResponse.json({
      ...result,
      library: {
        ...result.library,
        counts: await countsFor(result.library),
      },
    });
  } catch (error) {
    if (isPrismaError(error, "P2002")) {
      return routeError(
        action,
        new ApiError(
          "A module library for that organization already exists in this scope.",
          409,
        ),
      );
    }
    if (isPrismaError(error, "P2025")) {
      return routeError(action, new ApiError("Module library not found.", 404));
    }
    return routeError(action, error);
  }
}

export function PUT(request: Request, context: RouteContext) {
  return updateLibrary(request, context, "PUT");
}

export function PATCH(request: Request, context: RouteContext) {
  return updateLibrary(request, context, "PATCH");
}
