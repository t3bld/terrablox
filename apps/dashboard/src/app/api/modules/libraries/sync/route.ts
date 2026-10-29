import { NextResponse } from "next/server";

import { requireUserWithLimit } from "@/lib/api/guard";
import { RATE_LIMITS } from "@/lib/api/rate-limit";
import { routeError } from "@/lib/api/route-error";
import { getProviderTokenForRequest } from "@/lib/auth/server-helpers";
import { visibleLibraries } from "@/lib/module-library/libraries";
import {
  libraryStatus,
  syncModuleLibrary,
} from "@/lib/module-library/library-sync";

/**
 * Runs one bounded slice of automatic per-user library discovery/import.
 *
 * The request names no library and the response contains no library metadata. This lets
 * the dashboard keep configured private libraries fresh in the background without
 * telling an account that a library exists before that account has successfully imported
 * it. The client repeats while `more` is true.
 */
export async function POST(req: Request) {
  try {
    const userId = await requireUserWithLimit(
      "modules.library.sync",
      RATE_LIMITS.importModule,
    );
    const definitions = visibleLibraries("user");
    if (definitions.length === 0) {
      return NextResponse.json({ more: false, busy: false, changed: false });
    }

    const now = new Date();
    const before = await Promise.all(
      definitions.map((definition) => libraryStatus(userId, definition, now)),
    );
    const targetIndex = before.findIndex(
      (status) => status.stale && !status.syncing,
    );
    if (targetIndex < 0) {
      const busy = before.some((status) => status.syncing);
      return NextResponse.json({ more: busy, busy, changed: false });
    }

    const target = definitions[targetIndex];
    if (!target) {
      return NextResponse.json({ more: false, busy: false, changed: false });
    }

    const token = await getProviderTokenForRequest(req, "github");
    const result = await syncModuleLibrary({
      userId,
      token,
      library: target,
    });

    const after = await Promise.all(
      definitions.map((definition) => libraryStatus(userId, definition)),
    );
    const readyBefore = before
      .filter((status) => status.ready)
      .map((status) => status.id)
      .sort()
      .join("\n");
    const readyAfter = after
      .filter((status) => status.ready)
      .map((status) => status.id)
      .sort()
      .join("\n");

    return NextResponse.json({
      more:
        result.more || after.some((status) => status.stale && !status.syncing),
      busy: result.busy,
      changed:
        result.imported > 0 || result.removed > 0 || readyBefore !== readyAfter,
    });
  } catch (error) {
    return routeError("modules.library.sync", error);
  }
}
