import "server-only";

import { requireUserId } from "@/lib/api/guard";
import { ApiError } from "@/lib/api/route-error";
import { audit } from "@/lib/audit/log";
import { database } from "@/lib/database";

/** Reads the role for every check so revoking admin access takes effect immediately. */
export async function isAdminUser(userId: string): Promise<boolean> {
  const user = await database.user.findUnique({
    where: { id: userId },
    select: { systemRole: true },
  });

  return user?.systemRole === "admin";
}

/**
 * Requires an authenticated browser session and the system-wide admin role.
 * Personal API tokens are intentionally not accepted for administrative calls.
 */
export async function requireAdmin(action: string): Promise<string> {
  const userId = await requireUserId({ action });

  if (!(await isAdminUser(userId))) {
    await audit({
      action: "authz.denied",
      userId,
      outcome: "denied",
      detail: { route: action, reason: "admin-required" },
    });

    throw new ApiError("Administrator access is required.", 403);
  }

  return userId;
}
