import { NextResponse } from "next/server";

import { getCurrentUserId } from "@/lib/auth/server-helpers";
import { database } from "@/lib/database";
import { visibleToUser } from "@/lib/modules/ownership";

export async function GET() {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Includes the shipped catalogue's tags: these drive the filter chips on the
    // modules page, and a chip that cannot match anything the user can see is
    // as wrong as a module they can see but cannot filter to.
    const sources = await database.terraformModuleSource.findMany({
      where: visibleToUser(userId),
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
