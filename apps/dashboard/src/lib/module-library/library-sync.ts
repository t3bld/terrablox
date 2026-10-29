import "server-only";

import { randomUUID } from "node:crypto";
import type { ModuleLibrarySync, Prisma } from "@terrablox/database";
import { GithubRequestError } from "@terrablox/git/client";
import { database } from "@/lib/database";
import { githubAppInstallUrl } from "@/lib/github/app";
import { canonicalRepoUrl } from "@/lib/module-library/import-from-git";
import {
  isSyncLocked,
  isSyncStale,
  type ModuleLibraryDefinition,
} from "@/lib/module-library/libraries";
import {
  consoleLog,
  discoverLibrary,
  importLibraryRepos,
  type LibraryDiscovery,
  pruneLibrary,
  type RepoProgress,
} from "@/lib/module-library/library-engine";

/**
 * Keeps one user's copy of a per-user module library in step with GitHub.
 *
 * The orchestration around {@link discoverLibrary} and {@link importLibraryRepos}
 * for the per-user case: a status row per (user, library) with staleness, a
 * short lock, and progress so a time-budgeted run resumes where it stopped. The
 * client calls again while `more` is true.
 *
 * Global libraries go through the same engine via `syncGlobalLibrary`; they
 * need none of this, because an operator runs them.
 */

export type LibrarySyncState =
  | "never"
  | "available"
  | "not-installed"
  | "no-repos"
  | "unavailable"
  | "error";

export interface LibraryStatusDto {
  id: string;
  name: string;
  org: string;
  topics: string[];
  state: LibrarySyncState;
  /** True only after the complete latest import pass succeeded. */
  ready: boolean;
  syncing: boolean;
  stale: boolean;
  moduleCount: number;
  lastSyncedAt: string | null;
  hint:
    | null
    | { kind: "install"; url: string }
    | { kind: "select-repos"; url: string };
}

export interface LibrarySyncResult {
  library: LibraryStatusDto;
  more: boolean;
  busy: boolean;
  imported: number;
  removed: number;
}

const LOCK_MS = 10 * 60_000;
const DEFAULT_BUDGET_MS = 20_000;

const KNOWN_STATES = new Set<LibrarySyncState>([
  "never",
  "available",
  "not-installed",
  "no-repos",
  "unavailable",
  "error",
]);

function asState(raw: string | undefined): LibrarySyncState {
  return raw && KNOWN_STATES.has(raw as LibrarySyncState)
    ? (raw as LibrarySyncState)
    : "never";
}

function readProgress(
  raw: Prisma.JsonValue | undefined,
): Record<string, RepoProgress> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, RepoProgress> = {};

  for (const [name, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const v = value as Record<string, unknown>;
    if (typeof v.branch !== "string") continue;
    out[name] = {
      branch: v.branch,
      branchSha: typeof v.branchSha === "string" ? v.branchSha : null,
      tag: typeof v.tag === "string" ? v.tag : null,
    };
  }

  return out;
}

function installationSettingsUrl(org: string, installationId: string): string {
  return `https://github.com/organizations/${encodeURIComponent(org)}/settings/installations/${encodeURIComponent(installationId)}`;
}

/** Status for one library, from the database only. */
export async function libraryStatus(
  userId: string,
  def: ModuleLibraryDefinition,
  now: Date = new Date(),
): Promise<LibraryStatusDto> {
  const [row, moduleCount] = await Promise.all([
    database.moduleLibrarySync.findUnique({
      where: { userId_library: { userId, library: def.id } },
    }),
    database.terraformModuleSource.count({
      where: { userId, library: def.id },
    }),
  ]);

  return toDto(def, row, moduleCount, now);
}

function toDto(
  def: ModuleLibraryDefinition,
  row: ModuleLibrarySync | null,
  moduleCount: number,
  now: Date,
): LibraryStatusDto {
  const state = asState(row?.state);

  let hint: LibraryStatusDto["hint"] = null;
  if (state === "not-installed" && row?.memberDetected) {
    hint = { kind: "install", url: githubAppInstallUrl() };
  } else if (state === "no-repos" && row?.installationId) {
    hint = {
      kind: "select-repos",
      url: installationSettingsUrl(def.org, row.installationId),
    };
  }

  return {
    id: def.id,
    name: def.name,
    org: def.org,
    topics: def.topics,
    state,
    ready: state === "available" && !row?.pending,
    syncing: isSyncLocked(row, now),
    stale: isSyncStale(row, now),
    moduleCount,
    lastSyncedAt: row?.lastSyncedAt?.toISOString() ?? null,
    hint,
  };
}

/**
 * Runs (part of) a sync for one user and per-user library.
 *
 * Safe to call in a loop: without `force` a fresh row returns immediately, and a
 * concurrent call returns `busy` instead of doing the work twice.
 */
export async function syncModuleLibrary(params: {
  userId: string;
  token: string | null;
  library: ModuleLibraryDefinition;
  force?: boolean;
  budgetMs?: number;
}): Promise<LibrarySyncResult> {
  const { userId, token, library: def } = params;
  if (def.scope !== "user") {
    throw new Error(`Library '${def.id}' is global; it is not synced per user`);
  }

  const budgetMs = params.budgetMs ?? DEFAULT_BUDGET_MS;
  const startedAt = Date.now();
  const now = new Date(startedAt);
  const key = { userId_library: { userId, library: def.id } };
  const log = consoleLog(def.id);

  const existing = await database.moduleLibrarySync.upsert({
    where: key,
    create: { userId, library: def.id },
    update: {},
  });

  const finish = async (extra: Partial<LibrarySyncResult> = {}) => ({
    library: await libraryStatus(userId, def),
    more: false,
    busy: false,
    imported: 0,
    removed: 0,
    ...extra,
  });

  if (isSyncLocked(existing, now)) return finish({ busy: true });
  if (!params.force && !isSyncStale(existing, now)) return finish();

  const lockId = randomUUID();
  const claimed = await database.moduleLibrarySync.updateMany({
    where: {
      userId,
      library: def.id,
      OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
    },
    data: {
      lockId,
      lockedUntil: new Date(startedAt + LOCK_MS),
      lastAttemptAt: now,
      // A refresh re-verifies upstream access and may replace several refs. Hide the
      // library until that whole pass succeeds so readers never see partial imports or
      // rows retained from access the user may have lost.
      pending: true,
    },
  });
  if (claimed.count === 0) return finish({ busy: true });

  const updateOwned = async (
    data: Prisma.ModuleLibrarySyncUpdateManyMutationInput,
  ) => {
    const updated = await database.moduleLibrarySync.updateMany({
      where: { userId, library: def.id, lockId },
      data,
    });
    if (updated.count !== 1) throw new Error("Module library sync lock lost");
  };

  const renewOwned = () =>
    updateOwned({ lockedUntil: new Date(Date.now() + LOCK_MS) });

  const outcome = await (async (): Promise<Partial<LibrarySyncResult>> => {
    try {
      if (!token) {
        // No GitHub account linked, or the refresh was refused: no library, and
        // no error to show. The attempt timestamp keeps this from repeating.
        await updateOwned({
          state: "unavailable",
          pending: false,
          lastError: null,
        });
        return {};
      }

      let discovery: LibraryDiscovery;
      try {
        discovery = await discoverLibrary({ token, library: def, log });
      } catch (error) {
        // Not authoritative: never prune on a failure, keep what the user had.
        log.warn("discover", error);
        const status =
          error instanceof GithubRequestError ? error.status : "request";
        await updateOwned({
          state: "error",
          pending: false,
          lastError: `GitHub ${status} failed during discovery`,
        });
        return {};
      }

      if (discovery.kind === "not-installed") {
        const removed = await pruneLibrary({
          library: def,
          userId,
          keepUrls: [],
          assertCurrent: renewOwned,
        });
        await updateOwned({
          state: "not-installed",
          installationId: null,
          memberDetected: discovery.memberDetected,
          repos: {},
          pending: false,
          lastSyncedAt: now,
          lastError: null,
        });
        return { removed };
      }

      if (discovery.uncertainUrls.length > 0) {
        await updateOwned({
          state: "error",
          pending: false,
          lastError: `${discovery.uncertainUrls.length} repositories could not be verified`,
        });
        return {};
      }

      // Revoked access, a removed topic, an archived or deleted repo: all
      // simply stop being in the kept set.
      const removed = await pruneLibrary({
        library: def,
        userId,
        keepUrls: discovery.matched.map((repo) =>
          canonicalRepoUrl(repo.full_name),
        ),
        assertCurrent: renewOwned,
      });

      const progress = readProgress(existing.repos);
      for (const name of Object.keys(progress)) {
        if (!discovery.matched.some((repo) => repo.full_name === name)) {
          delete progress[name];
        }
      }

      await updateOwned({
        installationId: discovery.installationId,
        memberDetected: true,
        repos: progress as unknown as Prisma.InputJsonValue,
        ...(discovery.matched.length === 0
          ? {
              state: "no-repos",
              pending: false,
              lastSyncedAt: now,
              lastError: null,
            }
          : {}),
      });

      if (discovery.matched.length === 0) return { removed };

      const run = await importLibraryRepos({
        library: def,
        userId,
        token,
        repos: discovery.matched,
        progress,
        mode: "changed",
        budgetMs: Math.max(0, budgetMs - (Date.now() - startedAt)),
        log,
        assertCurrent: renewOwned,
        onRepoDone: async (next) => {
          await updateOwned({
            repos: next as unknown as Prisma.InputJsonValue,
            lockedUntil: new Date(Date.now() + LOCK_MS),
          });
        },
      });

      await updateOwned(
        run.more
          ? { pending: true }
          : run.failures.length > 0
            ? {
                state: "error",
                pending: false,
                lastError: `${run.failures.length} module ref${run.failures.length === 1 ? "" : "s"} failed to import`,
              }
            : {
                state: "available",
                pending: false,
                lastSyncedAt: now,
                lastError: null,
              },
      );

      return { more: run.more, imported: run.imported, removed };
    } catch (error) {
      log.warn("sync", error);
      await database.moduleLibrarySync
        .updateMany({
          where: { userId, library: def.id, lockId },
          data: {
            state: "error",
            pending: false,
            lastError: "Sync failed",
          },
        })
        .catch(() => undefined);
      return {};
    } finally {
      await database.moduleLibrarySync
        .updateMany({
          where: { userId, library: def.id, lockId },
          data: { lockId: null, lockedUntil: null },
        })
        .catch(() => undefined);
    }
  })();

  // After the lock is released, so the status does not report "syncing".
  return finish(outcome);
}
