import { NextResponse } from "next/server";

import { parseJsonBody } from "@/lib/api/guard";
import { ApiError, routeError } from "@/lib/api/route-error";
import { audit } from "@/lib/audit/log";
import { requireAdmin } from "@/lib/auth/admin";
import { database } from "@/lib/database";

import { createLibraryBody, normalizedCreateData } from "./schema";

function isUniqueConflict(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "P2002"
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

export async function GET() {
  try {
    await requireAdmin("admin.module-libraries.list");

    const definitions = await database.moduleLibraryDefinition.findMany({
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    });
    const libraries = await Promise.all(
      definitions.map(async (definition) => ({
        ...definition,
        counts: await countsFor(definition),
      })),
    );

    return NextResponse.json({ libraries });
  } catch (error) {
    return routeError("admin.module-libraries.list", error);
  }
}

export async function POST(request: Request) {
  try {
    const userId = await requireAdmin("admin.module-libraries.create");
    const body = await parseJsonBody(request, createLibraryBody);
    const data = normalizedCreateData(body);

    const created = await database.$transaction(async (tx) => {
      const sameOrganization = await tx.moduleLibraryDefinition.findFirst({
        where: {
          active: true,
          scope: data.scope,
          org: { equals: data.org, mode: "insensitive" },
        },
        select: { id: true },
      });
      if (sameOrganization) {
        throw new ApiError(
          `A ${data.scope} module library already reads '${data.org}'.`,
          409,
        );
      }

      const last = await tx.moduleLibraryDefinition.aggregate({
        _max: { sortOrder: true },
      });

      return tx.moduleLibraryDefinition.create({
        data: {
          ...data,
          active: true,
          sortOrder: (last._max.sortOrder ?? -1) + 1,
        },
      });
    });

    await audit({
      action: "module-library.created",
      userId,
      subject: created.id,
      detail: { scope: created.scope, org: created.org },
    });

    return NextResponse.json(
      {
        library: {
          ...created,
          counts: await countsFor(created),
        },
      },
      { status: 201 },
    );
  } catch (error) {
    if (isUniqueConflict(error)) {
      return routeError(
        "admin.module-libraries.create",
        new ApiError(
          "A module library with that id or organization already exists.",
          409,
        ),
      );
    }
    return routeError("admin.module-libraries.create", error);
  }
}
