import { NextResponse } from "next/server";
import { routeError, unauthorized } from "@/lib/api/route-error";
import { getCurrentUserId } from "@/lib/auth/server-helpers";
import { visibleLibraries } from "@/lib/module-library/libraries";
import {
  globalLibraryStatus,
  libraryStatus,
} from "@/lib/module-library/library-sync";

// Per user and per request. Without this, the try/catch below swallows the
// signal Next uses to detect `headers()` and the route is prerendered once.
export const dynamic = "force-dynamic";

/**
 * The successfully imported per-user module libraries visible to this account.
 * Definitions that have never completed a successful import stay server-side: the
 * automatic sync endpoint discovers them without exposing their name, organisation,
 * topics, or status to the browser first.
 *
 * With `?includeGlobal=1`, globally managed libraries are prepended as
 * read-only status cards for the account page. Other callers keep the per-user
 * list only, so their synchronization behavior does not change.
 *
 * Database only — no GitHub call — so it is cheap enough for every page load.
 * The client decides from `stale` whether to ask for a sync.
 */
export async function GET(request: Request) {
  try {
    const userId = await getCurrentUserId();
    if (!userId) return unauthorized();

    const now = new Date();
    const includeGlobal =
      new URL(request.url).searchParams.get("includeGlobal") === "1";
    const [definitions, globalDefinitions] = await Promise.all([
      visibleLibraries("user"),
      includeGlobal ? visibleLibraries("global") : Promise.resolve([]),
    ]);
    const personal = (
      await Promise.all(
        definitions.map((library) => libraryStatus(userId, library, now)),
      )
    ).filter(
      (library) =>
        library.ready ||
        library.hint !== null ||
        (library.state === "error" && library.lastSyncedAt !== null),
    );
    const global = await Promise.all(
      globalDefinitions.map(globalLibraryStatus),
    );

    return NextResponse.json({ libraries: [...global, ...personal] });
  } catch (e) {
    return routeError("modules.libraries", e);
  }
}
