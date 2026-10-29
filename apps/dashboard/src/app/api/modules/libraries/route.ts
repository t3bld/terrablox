import { NextResponse } from "next/server";
import { routeError, unauthorized } from "@/lib/api/route-error";
import { getCurrentUserId } from "@/lib/auth/server-helpers";
import { visibleLibraries } from "@/lib/module-library/libraries";
import { libraryStatus } from "@/lib/module-library/library-sync";

// Per user and per request. Without this, the try/catch below swallows the
// signal Next uses to detect `headers()` and the route is prerendered once.
export const dynamic = "force-dynamic";

/**
 * The successfully imported per-user module libraries visible to this account.
 * Definitions that have never completed a successful import stay server-side: the
 * automatic sync endpoint discovers them without exposing their name, organisation,
 * topics, or status to the browser first.
 *
 * Global libraries are imported by an operator and have no per-user status.
 *
 * Database only — no GitHub call — so it is cheap enough for every page load.
 * The client decides from `stale` whether to ask for a sync.
 */
export async function GET() {
  try {
    const userId = await getCurrentUserId();
    if (!userId) return unauthorized();

    const now = new Date();
    const libraries = (
      await Promise.all(
        visibleLibraries("user").map((library) =>
          libraryStatus(userId, library, now),
        ),
      )
    ).filter((library) => library.ready);

    return NextResponse.json({ libraries });
  } catch (e) {
    return routeError("modules.libraries", e);
  }
}
