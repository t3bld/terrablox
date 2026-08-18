import { NextResponse } from "next/server";

import { getCurrentUserId } from "@/lib/auth/server-helpers";
import { database } from "@/lib/database";

export async function GET() {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const sources = await database.terraformModuleSource.findMany({
      where: { userId },
      select: { tags: true },
      take: 200,
    });

    const unique = Array.from(
      new Set(
        sources
          .flatMap((source) => source.tags ?? [])
          .map((tag) => (typeof tag === "string" ? tag.trim() : ""))
          .filter(Boolean),
      ),
    ).sort((a, b) => a.localeCompare(b));

    return NextResponse.json({ tags: unique });
  } catch (error) {
    console.error("[tags] failed to load", error);
    return NextResponse.json({ error: "Failed to load tags" }, { status: 500 });
  }
}
