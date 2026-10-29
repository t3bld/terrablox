import "server-only";

import { visibleToUser } from "@/lib/module-library/ownership";

/**
 * The module/source visibility predicate for one user.
 *
 * Personal imports and configured global libraries are admitted directly. The
 * per-user arm joins the module to its sync row and requires a complete successful
 * import, so partial, pending, unavailable, and failed libraries cannot match.
 */
export function visibleModulesForUser(userId: string) {
  return visibleToUser(userId);
}
