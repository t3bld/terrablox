import { NextResponse } from "next/server";

import { getCurrentUserId } from "@/lib/auth/server-helpers";
import { database } from "@/lib/database";

/**
 * Asks the running turn to stop.
 *
 * Clearing `agentRunning` *is* the request. The turn that owns it polls the same
 * column and aborts its runtime session when it finds it false — see the watcher in
 * `chat/route.ts`. Writing the flag rather than reaching for the session is what
 * makes this work at all: the turn is running inside a different request, holding
 * the only reference to that session, and on more than one instance it is not even
 * in this process.
 *
 * Returns as soon as the flag is written, without waiting for the turn to notice.
 * The alternative is a request that hangs for as long as the runtime takes to wind
 * down, on a button whose whole purpose is that something is taking too long.
 *
 * Idempotent, and quiet about a turn that has already finished: pressing Stop as the
 * last step commits is a race the user cannot see, and an error for it would report
 * their own success as a failure.
 */
export async function POST(
  _req: Request,
  { params }: { params: { projectId: string } },
) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Scoped by owner in the same statement as the write, so a project id from
  // somebody else's account cannot stop their agent.
  const stopped = await database.project.updateMany({
    where: { id: params.projectId, userId, agentRunning: true },
    data: { agentRunning: false },
  });

  return NextResponse.json({ stopped: stopped.count > 0 });
}
