/**
 * Who may see a module, and who may change it.
 *
 * A module row with `userId = null` is part of the catalogue TerraBlox ships
 * with: every user sees it, nobody owns it, and no user may edit or delete it.
 * Everything else belongs to exactly one user.
 *
 * The two ideas get two separate helpers on purpose. They read almost the same
 * and differ by one clause, so a future refactor that "removes the duplication"
 * by sharing a single helper between a list query and a DELETE would hand every
 * user the power to delete the shipped catalogue. Keeping them apart makes that
 * mistake require deleting a name that says what it protects.
 *
 * No `server-only`: the sync script imports {@link BUILTIN_USER_ID} and
 * {@link builtinModulesEnabled} too. Nothing here touches the database or any
 * secret — it returns query fragments and reads one environment variable — and
 * every importer is server-side, so the guard would buy nothing.
 */

/**
 * The owner of the shipped catalogue.
 *
 * SQL, and therefore Prisma, never matches NULL with an equality filter. That is
 * not a quirk being exploited here, it is the whole mechanism: a write path that
 * says `where: { userId }` with a real user id cannot reach a builtin row even
 * if someone forgets there is such a thing as a builtin row. Visibility is the
 * only thing that has to opt in, and it does so loudly via
 * {@link visibleToUser}.
 */
export const BUILTIN_USER_ID = null;

/**
 * Whether this installation offers the catalogue TerraBlox ships with.
 *
 * Defaults to on: a fresh install is more useful with a module library than
 * without one, and an operator who wants a bare instance can say so. Only
 * `false` and `0` turn it off, so a typo leaves the catalogue enabled rather
 * than silently emptying every user's library.
 *
 * One flag governs both halves — whether {@link visibleToUser} admits builtins,
 * and whether the sync script will write them. Two flags would let an instance
 * hold rows it refuses to show, which is a state nobody asked for and everybody
 * would have to reason about.
 */
export function builtinModulesEnabled(): boolean {
  const raw = process.env.TERRABLOX_BUILTIN_MODULES?.trim().toLowerCase();
  return raw !== "false" && raw !== "0";
}

/**
 * Modules a user may look at: their own, plus the shipped catalogue.
 *
 * Spread into a `where`, e.g.
 * `findMany({ where: { ...visibleToUser(userId), isSubmodule: false } })`.
 * Returned as a spreadable object rather than a whole `where` so it composes
 * with the caller's own filters without either side having to know about the
 * other.
 *
 * Always an `OR`, even when the catalogue is off and the list holds a single
 * clause. A one-armed `OR` compiles to the same `user_id = $1` a bare equality
 * would, and keeping the shape constant means the eleven call sites that spread
 * this never have to care which mode the instance is in.
 */
export function visibleToUser(userId: string): {
  OR: Array<{ userId: string } | { userId: null }>;
} {
  return builtinModulesEnabled()
    ? { OR: [{ userId }, { userId: BUILTIN_USER_ID }] }
    : { OR: [{ userId }] };
}

/**
 * Modules a user may change or delete: only their own.
 *
 * Trivial today, and that is the point — it gives every mutating query a name to
 * state its intent with, so the difference from {@link visibleToUser} is visible
 * at the call site instead of living in whoever last edited the query's head.
 */
export function ownedByUser(userId: string): { userId: string } {
  return { userId };
}

/** Whether a row is part of the catalogue TerraBlox ships with. */
export function isBuiltin(row: { userId: string | null }): boolean {
  return row.userId === BUILTIN_USER_ID;
}
