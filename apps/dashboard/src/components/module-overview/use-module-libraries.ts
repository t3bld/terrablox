"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Mirrors `LibraryStatusDto` in lib/module-library/library-sync.ts. */
export interface ModuleLibraryStatus {
  id: string;
  name: string;
  org: string;
  topics: string[];
  state:
    | "never"
    | "available"
    | "not-installed"
    | "no-repos"
    | "unavailable"
    | "error";
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

interface AutomaticSyncResponse {
  more: boolean;
  busy: boolean;
  changed: boolean;
}

interface SyncResponse {
  library: ModuleLibraryStatus;
  more: boolean;
  busy: boolean;
  imported: number;
  removed: number;
}

/** A safety net: each call is bounded server-side, this bounds the loop. */
const MAX_SYNC_ROUNDS = 30;
const BUSY_RETRY_MS = 10_000;

/**
 * Keeps the signed-in user's per-user module libraries (e.g. Porsche) fresh.
 *
 * Reads statuses, then syncs every stale library in bounded slices, calling
 * `onChanged` whenever modules may have appeared or disappeared so the caller can
 * reload its list. Every failure is logged and swallowed: a library the user
 * cannot reach is simply absent, never an error on screen.
 */
export function useModuleLibraries({
  onChanged,
  enabled = true,
}: {
  onChanged?: () => void;
  enabled?: boolean;
} = {}) {
  const [libraries, setLibraries] = useState<ModuleLibraryStatus[]>([]);
  const [syncingIds, setSyncingIds] = useState<string[]>([]);

  // Held in a ref so a new callback each render does not restart the sync.
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const mounted = useRef(true);

  const replace = useCallback((status: ModuleLibraryStatus) => {
    setLibraries((current) =>
      current.map((library) => (library.id === status.id ? status : library)),
    );
  }, []);

  const runSync = useCallback(
    async (library: ModuleLibraryStatus, force: boolean) => {
      setSyncingIds((ids) => [...new Set([...ids, library.id])]);
      // Hide cached metadata and module cards before the refresh starts. The server
      // closes access when it claims the sync; the client must not keep rendering a
      // copy it loaded before that claim.
      setLibraries((current) =>
        current.filter((candidate) => candidate.id !== library.id),
      );
      onChangedRef.current?.();

      try {
        for (let round = 0; round < MAX_SYNC_ROUNDS; round++) {
          const query = force && round === 0 ? "?force=1" : "";
          const res = await fetch(
            `/api/modules/libraries/${encodeURIComponent(library.id)}/sync${query}`,
            { method: "POST", cache: "no-store" },
          );
          if (!res.ok) {
            console.warn("[module-library] sync request failed", {
              library: library.id,
              status: res.status,
            });
            return;
          }

          const body = (await res.json()) as SyncResponse;
          if (!mounted.current) return;
          if (body.library.ready) replace(body.library);
          else {
            setLibraries((current) =>
              current.filter((candidate) => candidate.id !== library.id),
            );
          }
          onChangedRef.current?.();

          if (body.busy) {
            // Another tab holds the lock; look once more after it has had time.
            setTimeout(() => {
              if (!mounted.current) return;
              void fetch("/api/modules/libraries", { cache: "no-store" })
                .then((r) => (r.ok ? r.json() : null))
                .then((data) => {
                  if (!data || !mounted.current) return;
                  setLibraries(data.libraries ?? []);
                  onChangedRef.current?.();
                })
                .catch(() => undefined);
            }, BUSY_RETRY_MS);
            return;
          }

          if (!body.more) return;
        }
      } catch (error) {
        console.warn("[module-library] sync failed", {
          library: library.id,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (mounted.current) {
          setSyncingIds((ids) => ids.filter((id) => id !== library.id));
        }
      }
    },
    [replace],
  );

  useEffect(() => {
    mounted.current = true;
    if (!enabled) return;

    void (async () => {
      const loadVisible = async (): Promise<ModuleLibraryStatus[] | null> => {
        const res = await fetch("/api/modules/libraries", {
          cache: "no-store",
        });
        if (!res.ok) return null;
        const body = (await res.json()) as {
          libraries?: ModuleLibraryStatus[];
        };
        if (!mounted.current) return null;
        const visible = body.libraries ?? [];
        setLibraries(visible);
        return visible;
      };

      const syncAutomatically = async (): Promise<void> => {
        // The server chooses the next configured library internally. Neither the
        // request nor the response reveals its identity before a successful import.
        for (let round = 0; round < MAX_SYNC_ROUNDS; round++) {
          const res = await fetch("/api/modules/libraries/sync", {
            method: "POST",
            cache: "no-store",
          });
          if (!res.ok) return;

          const body = (await res.json()) as AutomaticSyncResponse;
          if (!mounted.current) return;

          if (body.changed) {
            await loadVisible();
            onChangedRef.current?.();
          }

          if (body.busy) {
            await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_MS));
            if (!mounted.current) return;
            continue;
          }

          if (!body.more) return;
        }

        // Large libraries can need more than one client-side batch. Pause so the
        // request budget gets breathing room, then continue without requiring a
        // remount or navigation.
        await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_MS));
        if (mounted.current) await syncAutomatically();
      };

      try {
        if ((await loadVisible()) === null) return;
        await syncAutomatically();
      } catch (error) {
        console.warn("[module-library] could not sync libraries", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    return () => {
      mounted.current = false;
    };
  }, [enabled]);

  const refresh = useCallback(
    (id: string) => {
      const library = libraries.find((candidate) => candidate.id === id);
      if (library && !syncingIds.includes(id)) void runSync(library, true);
    },
    [libraries, runSync, syncingIds],
  );

  return { libraries, syncingIds, refresh };
}
