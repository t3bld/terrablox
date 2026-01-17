import { NextResponse } from "next/server";

import { database } from "@/lib/database";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const userId = searchParams.get("userId")?.trim();

  if (!userId) {
    return NextResponse.json({ error: "Missing userId" }, { status: 400 });
  }

  const modules = await database.terraformModule.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    include: {
      source: true,
    },
  });

  const modulesWithEffectiveFields = modules.map((mod) => ({
    ...mod,
    effectiveName: mod.submoduleName ?? mod.source?.name ?? "(unnamed)",
    effectiveDescription: mod.source?.description ?? null,
  }));

  return NextResponse.json({ modules: modulesWithEffectiveFields });
}
