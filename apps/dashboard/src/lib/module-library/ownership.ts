/**
 * Who may see a module, and who may change it.
 *
 * Three kinds of rows:
 *
 * - `userId = NULL, library = <global id>`: a shared library such as the
 *   Terrablox catalogue. Every user sees it, nobody owns it, nobody edits it.
 * - `userId = <user>, library = <per-user id>`: that user's synced copy of a
 *   per-user library such as Porsche. Only they see it; read-only to them too.
 * - `userId = <user>, library = NULL`: the user's own import. Theirs to change.
 *
 * Which libraries are admitted at all is decided by their `visible` flag in
 * `TERRABLOX_MODULE_LIBRARIES`. Per-user callers must additionally pass only library
 * ids whose sync completed successfully.
 *
 * The two ideas get two separate helpers on purpose. They read almost the same
 * and differ by one clause, so a future refactor that "removes the duplication"
 * by sharing a single helper between a list query and a DELETE would hand every
 * user the power to delete the shipped catalogue. Keeping them apart makes that
 * mistake require deleting a name that says what it protects.
 *
 * No `server-only`: the CLI scripts import it too. Nothing here touches the
 * database or any secret — it returns query fragments and reads environment
 * variables.
 */

import {
  findModuleLibrary,
  TERRABLOX_LIBRARY_ID,
  visibleLibraryIds,
} from "./libraries";

/**
 * The owner of every global library row.
 *
 * SQL, and therefore Prisma, never matches NULL with an equality filter. That is
 * not a quirk being exploited here, it is the whole mechanism: a write path that
 * says `where: { userId }` with a real user id cannot reach a global row even
 * if someone forgets there is such a thing. Visibility is the only thing that
 * has to opt in, and it does so loudly via {@link visibleToUser}.
 */
export const BUILTIN_USER_ID = null;

/**
 * Modules a user may look at: their own imports, their successfully synced copy of
 * each admitted per-user library, and every visible global library.
 *
 * The per-user arm includes the successful sync in the same database predicate as the
 * module read. A refresh that sets `pending` between requests therefore closes access
 * atomically instead of leaving a previously computed list of library ids usable.
 *
 * Spread into a `where`, e.g.
 * `findMany({ where: { ...visibleToUser(userId), isSubmodule: false } })`.
 *
 * The global arm admits only ids whose definition is *global*. So even a row a
 * buggy writer stored with a NULL owner under a per-user library id — one
 * person's private module — is visible to nobody, rather than to everybody.
 */
export function visibleToUser(userId: string) {
  const perUser = visibleLibraryIds("user");
  const global = visibleLibraryIds("global");

  return {
    OR: [
      { userId, library: null },
      ...(perUser.length > 0
        ? [
            {
              userId,
              library: { in: perUser },
              librarySync: { is: { state: "available", pending: false } },
            },
          ]
        : []),
      ...(global.length > 0
        ? [{ userId: BUILTIN_USER_ID, library: { in: global } }]
        : []),
    ],
  };
}

/**
 * Modules a user may change or delete: only their own imports.
 *
 * `library: null` excludes rows a library sync manages: those mirror GitHub,
 * and an edit would be overwritten (or a delete undone) by the next sync.
 * Global rows are excluded by the NULL owner.
 */
export function ownedByUser(userId: string): {
  userId: string;
  library: null;
} {
  return { userId, library: null };
}

/** Whether a row is part of a global library, shared by every user. */
export function isBuiltin(row: { userId: string | null }): boolean {
  return row.userId === BUILTIN_USER_ID;
}

/**
 * Whether Terrablox manages a row — any library, global or per-user — and the
 * user therefore may not edit or delete it.
 */
export function isManaged(row: {
  userId: string | null;
  library?: string | null;
}): boolean {
  return isBuiltin(row) || row.library != null;
}

/** Why a managed row cannot be deleted, or null when it can. */
export function deleteRefusal(row: {
  userId: string | null;
  library?: string | null;
}): string | null {
  if (!isManaged(row)) return null;

  // A global row always has a library (a CHECK constraint says so).
  const id = row.library ?? TERRABLOX_LIBRARY_ID;
  const name = findModuleLibrary(id)?.name ?? id;

  if (isBuiltin(row)) {
    return id === TERRABLOX_LIBRARY_ID
      ? "This module ships with Terrablox and cannot be deleted. Every user shares it."
      : `This module comes from the shared ${name} library and cannot be deleted. Every user shares it.`;
  }
  return `This module comes from the ${name} library and cannot be deleted. Terrablox keeps it in step with GitHub.`;
}
