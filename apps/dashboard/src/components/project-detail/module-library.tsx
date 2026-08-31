"use client";

import { PROJECT_MODULE_DRAG_TYPE } from "@terrablox/graph";
import { Button } from "@terrablox/ui/button";
import { Input } from "@terrablox/ui/input";
import { Skeleton } from "@terrablox/ui/skeleton";
import {
  AlertCircle,
  GripVertical,
  PanelLeftClose,
  Plus,
  Search,
  Sparkles,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { ModuleIcon } from "@/components/module-icon";

interface LibraryVersion {
  id: string;
  versionTag: string | null;
}

interface LibraryRepository {
  key: string;
  sourceId: string | null;
  name: string;
  description: string | null;
  provider: string | null;
  iconMode: string;
  hasIcon: boolean;
  iconName: string | null;
  defaultVersion: LibraryVersion | null;
  versions: LibraryVersion[];
}

interface ModuleLibraryProps {
  /**
   * Adds a module at a default position, for users who would rather click.
   * `name` is passed for the same reason as on a drag: to label the placeholder.
   */
  onAdd: (moduleId: string, name: string) => void;
  disabled?: boolean;
  /**
   * Module id → why the canvas needs it, from the graph's open requirements.
   * Suggested entries are pinned to the top: the module a user should reach for
   * next is dictated by what the canvas is missing, not by the alphabet.
   */
  suggestions?: Record<string, string>;
  /** Omitted where the panel cannot be hidden. */
  onCollapse?: () => void;
}

/**
 * The palette of imported modules.
 *
 * Entries are dragged onto the canvas, which is the gesture the feature is
 * built around, but they can also be added with a click — dragging is awkward
 * on touch devices and impossible with a keyboard.
 */
export function ModuleLibrary({
  onAdd,
  disabled = false,
  suggestions = {},
  onCollapse,
}: ModuleLibraryProps) {
  const [repositories, setRepositories] = useState<LibraryRepository[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;

    fetch("/api/modules/list")
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? "Failed to load modules");
        if (!cancelled) setRepositories(body.repositories ?? []);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Failed to load modules",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  /** A repository is suggested when any of its versions would fill a gap. */
  function suggestionFor(repo: LibraryRepository): string | undefined {
    for (const version of repo.versions) {
      const reason = suggestions[version.id];
      if (reason) return reason;
    }
    return undefined;
  }

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    const matching = query
      ? repositories.filter(
          (repo) =>
            repo.name.toLowerCase().includes(query) ||
            repo.description?.toLowerCase().includes(query),
        )
      : repositories;

    const suggested = (repo: LibraryRepository) =>
      repo.versions.some((version) => suggestions[version.id]);

    return [...matching].sort(
      (a, b) => Number(suggested(b)) - Number(suggested(a)),
    );
  }, [repositories, search, suggestions]);

  // The repository's default version — its tracked branch — is what a new module
  // is pinned to; another version is chosen in the inspector, where the version
  // is actually visible.
  function moduleIdFor(repo: LibraryRepository): string | null {
    return repo.defaultVersion?.id ?? null;
  }

  return (
    <div className="flex h-full flex-col">
      {/* Laid out like the agent panel's header on the other side of the canvas:
          name on the inside, collapse control on the outer edge it folds towards. */}
      <div className="flex items-center gap-2 border-b p-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">Modules</h2>
        </div>

        {onCollapse ? (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            onClick={onCollapse}
            aria-label="Collapse module library"
          >
            <PanelLeftClose className="h-4 w-4" />
          </Button>
        ) : null}
      </div>

      <div className="border-b p-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search modules"
            className="h-9 pl-9"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {loading ? (
          <div className="space-y-2">
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : error ? (
          <p className="flex items-start gap-2 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            {error}
          </p>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {repositories.length === 0
              ? "Import a module first — the library is what you build projects from."
              : "No modules match your search."}
          </p>
        ) : (
          <ul className="space-y-1.5">
            {filtered.map((repo) => {
              const moduleId = moduleIdFor(repo);
              const suggestion = suggestionFor(repo);

              return (
                <li
                  key={repo.key}
                  draggable={!disabled && Boolean(moduleId)}
                  onDragStart={(event) => {
                    if (!moduleId) return;
                    // The name travels with the id so the canvas can label the
                    // placeholder it draws before the commit returns.
                    event.dataTransfer.setData(
                      PROJECT_MODULE_DRAG_TYPE,
                      JSON.stringify({ moduleId, name: repo.name }),
                    );
                    event.dataTransfer.effectAllowed = "copy";
                  }}
                  className={`group rounded-lg border bg-card p-2 transition-colors ${
                    suggestion ? "border-primary/60 bg-primary/5" : ""
                  } ${
                    disabled
                      ? "opacity-60"
                      : "cursor-grab hover:border-primary/50"
                  }`}
                >
                  {suggestion ? (
                    <p className="mb-1.5 flex items-center gap-1 text-[11px] font-medium text-primary">
                      <Sparkles className="h-3 w-3 shrink-0" />
                      <span className="truncate">{suggestion}</span>
                    </p>
                  ) : null}

                  <div className="flex items-center gap-1.5">
                    <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <ModuleIcon
                      className="h-6 w-6"
                      icon={{
                        sourceId: repo.sourceId,
                        iconMode: repo.iconMode,
                        hasIcon: repo.hasIcon,
                        iconName: repo.iconName,
                      }}
                    />
                    <p
                      className="min-w-0 flex-1 truncate text-sm font-medium"
                      title={repo.description ?? repo.name}
                    >
                      {repo.name}
                    </p>
                    <button
                      type="button"
                      disabled={disabled || !moduleId}
                      onClick={() => moduleId && onAdd(moduleId, repo.name)}
                      title="Add to canvas"
                      className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
