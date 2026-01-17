import { NextResponse } from "next/server";

import { database } from "@/lib/database";

export async function GET(
  req: Request,
  { params }: { params: { moduleId: string } },
) {
  const { searchParams } = new URL(req.url);
  const userId = searchParams.get("userId")?.trim();

  if (!userId) {
    return NextResponse.json({ error: "Missing userId" }, { status: 400 });
  }

  const moduleId = params.moduleId?.trim();
  if (!moduleId) {
    return NextResponse.json({ error: "Missing moduleId" }, { status: 400 });
  }

  const mod = await database.terraformModule.findFirst({
    where: { id: moduleId, userId },
    include: {
      source: true,
      resources: { orderBy: [{ providerName: "asc" }, { resourceType: "asc" }] },
      submodules: {
        select: { id: true, submoduleName: true, terraformRootFolder: true },
      },
    },
  });

  if (!mod) {
    return NextResponse.json({ error: "Module not found" }, { status: 404 });
  }

  return NextResponse.json({
    module: {
      ...mod,
      effectiveName: mod.submoduleName ?? mod.source?.name ?? "(unnamed)",
      effectiveDescription: mod.source?.description ?? null,
    },
  });
}
