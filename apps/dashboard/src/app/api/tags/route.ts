import { NextResponse } from "next/server";

import { database } from "@/lib/database";

export async function GET() {
  // For now, we return tags from the signed-in user's sources only.
  // If you want global tags later, we can widen the query.
  try {
    const sources = await database.terraformModuleSource.findMany({
      select: { tags: true },
      take: 200,
    });

    const all = sources.flatMap((s) => s.tags ?? []);
    const unique = Array.from(
      new Set(
        all.map((t) => (typeof t === "string" ? t.trim() : "")).filter(Boolean),
      ),
    ).sort((a, b) => a.localeCompare(b));

    return NextResponse.json({ tags: unique });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to load tags" },
      { status: 500 },
    );
  }
}
