import { NextResponse } from "next/server";

import { database } from "@/lib/database";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const userId = searchParams.get("userId")?.trim();

  if (!userId) {
    return NextResponse.json({ error: "Missing userId" }, { status: 400 });
  }

  const sources = await database.terraformModuleSource.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    include: {
      versions: {
        orderBy: { updatedAt: "desc" },
      },
    },
  });

  const sourcesWithEffectiveFields = sources.map((source) => ({
    ...source,
    versions: source.versions.map((version) => ({
      ...version,
      effectiveName: version.submoduleName ?? source.name,
      effectiveDescription: source.description,
    })),
  }));

  return NextResponse.json({ sources: sourcesWithEffectiveFields });
}
