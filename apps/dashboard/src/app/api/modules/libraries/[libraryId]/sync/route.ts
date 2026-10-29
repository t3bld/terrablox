import { NextResponse } from "next/server";
import { requireUserWithLimit } from "@/lib/api/guard";
import { RATE_LIMITS } from "@/lib/api/rate-limit";
import { notFound, routeError } from "@/lib/api/route-error";
import { getProviderTokenForRequest } from "@/lib/auth/server-helpers";
import { database } from "@/lib/database";
import {
  LIBRARY_ID_PATTERN,
  visibleLibraries,
} from "@/lib/module-library/libraries";
import { syncModuleLibrary } from "@/lib/module-library/library-sync";

/**
 * Runs one bounded slice of the signed-in user's library sync.
 *
 * Uses the caller's own GitHub token, so a user only ever receives modules their
 * own access allows. `?force=1` ignores the staleness window (the "Refresh"
 * button), never the lock. The client repeats the call while `more` is true.
 */
export async function POST(
  req: Request,
  { params }: { params: { libraryId: string } },
) {
  try {
    const userId = await requireUserWithLimit(
      "modules.library.sync",
      RATE_LIMITS.importModule,
    );

    // Explicit refresh is available only after this account completed an import.
    // First-time discovery goes through the metadata-free automatic sync route.
    const library = LIBRARY_ID_PATTERN.test(params.libraryId)
      ? visibleLibraries("user").find((def) => def.id === params.libraryId)
      : undefined;
    const previouslyAvailable = library
      ? await database.moduleLibrarySync.findFirst({
          where: {
            userId,
            library: library.id,
            // `pending` remains true between bounded slices. Keeping the successful
            // state lets this already-authorized caller continue, while a first import
            // stays `never` and cannot use the id-addressed endpoint.
            state: "available",
          },
          select: { id: true },
        })
      : null;
    if (!library || !previouslyAvailable) {
      return notFound("Unknown module library");
    }

    const force = new URL(req.url).searchParams.get("force") === "1";
    const token = await getProviderTokenForRequest(req, "github");

    const result = await syncModuleLibrary({ userId, token, library, force });
    return NextResponse.json(result);
  } catch (e) {
    return routeError("modules.library.sync", e);
  }
}
