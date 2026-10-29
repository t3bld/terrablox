"use client";

import { useAuth } from "@terrablox/auth/hooks";
import { Button } from "@terrablox/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@terrablox/ui/dropdown-menu";
import { Input } from "@terrablox/ui/input";
import { Label } from "@terrablox/ui/label";
import { Select } from "@terrablox/ui/select";
import { SidebarInset, SidebarProvider } from "@terrablox/ui/sidebar";
import { Skeleton } from "@terrablox/ui/skeleton";
import { TagsInput } from "@terrablox/ui/tags-input";
import { Filter, RefreshCw, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { PageHeader } from "@/components/layout/page-header";
import {
  CardGridSkeleton,
  PageSkeleton,
} from "@/components/layout/page-skeleton";
import { LibraryAccessHint } from "@/components/module-overview/library-access-hint";
import { RepositoryCard } from "@/components/module-overview/repository-card";
import type { RepositoryDto } from "@/components/module-overview/types";
import { useModuleLibraries } from "@/components/module-overview/use-module-libraries";

/** Library filter value for the user's own imports; "" means every library. */
const OWN_IMPORTS = "__own__";

function relativeTime(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString();
}

function normalizeTag(input: string) {
  return input.trim().replace(/\s+/g, "-").toLowerCase();
}

export default function ModulesPage() {
  const { isAuthenticated, user } = useAuth();
  const [repositories, setRepositories] = useState<RepositoryDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedLibrary, setSelectedLibrary] = useState("");

  const loadRepositories = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      if (!user?.id) return;

      // A background refresh keeps the current list on screen; swapping in the
      // skeleton would make the page flash for an already-populated view.
      if (!silent) setLoading(true);
      setLoadError(null);

      try {
        const res = await fetch("/api/modules/list", { cache: "no-store" });
        const body = await res.json().catch(() => ({}));

        if (!res.ok) {
          throw new Error(
            typeof body?.error === "string" && body.error
              ? body.error
              : "Failed to load modules",
          );
        }

        setRepositories((body?.repositories ?? []) as RepositoryDto[]);
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : "Failed to load modules");
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [user?.id],
  );

  useEffect(() => {
    void loadRepositories();
  }, [loadRepositories]);

  // Per-user libraries (e.g. Porsche) sync in the background; the list reloads
  // quietly whenever a sync changed what the user can see.
  const {
    libraries,
    syncingIds,
    refresh: refreshLibrary,
  } = useModuleLibraries({
    enabled: Boolean(user?.id),
    onChanged: () => {
      void loadRepositories({ silent: true });
    },
  });

  const libraryOptions = useMemo(() => {
    const byId = new Map<string, string>();
    for (const repo of repositories) {
      if (repo.library) byId.set(repo.library.id, repo.library.name);
    }
    return [...byId.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [repositories]);

  const availableTags = useMemo(() => {
    const set = new Set<string>();
    for (const repo of repositories) {
      for (const tag of repo.tags) {
        const normalized = normalizeTag(tag);
        if (normalized) set.add(normalized);
      }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [repositories]);

  const filteredRepositories = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const selected = selectedTags.map(normalizeTag).filter(Boolean);

    return repositories.filter((repo) => {
      const haystack = [
        repo.name,
        repo.description ?? "",
        repo.url ?? "",
        repo.tags.join(" "),
        // Searching for a specific ref should surface the repository holding it.
        repo.versions
          .map((v) => v.versionTag ?? "")
          .join(" "),
        repo.versions.map((v) => v.terraformRootFolder ?? "").join(" "),
      ]
        .join(" ")
        .toLowerCase();

      const matchesSearch = !query || haystack.includes(query);

      const repoTags = repo.tags.map(normalizeTag).filter(Boolean);
      const matchesTags =
        selected.length === 0 || selected.every((t) => repoTags.includes(t));

      const matchesLibrary =
        !selectedLibrary ||
        (selectedLibrary === OWN_IMPORTS
          ? repo.library === null
          : repo.library?.id === selectedLibrary);

      return matchesSearch && matchesTags && matchesLibrary;
    });
  }, [repositories, searchQuery, selectedTags, selectedLibrary]);

  const activeFilterCount = selectedTags.length + (selectedLibrary ? 1 : 0);

  const clearAll = useCallback(() => {
    setSearchQuery("");
    setSelectedTags([]);
    setSelectedLibrary("");
  }, []);

  if (!isAuthenticated) {
    return (
      <PageSkeleton breadcrumbs={[{ label: "Modules" }]} mainClassName="p-4">
        <CardGridSkeleton />
      </PageSkeleton>
    );
  }

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <PageHeader breadcrumbs={[{ label: "Modules" }]} />

        <main className="space-y-4 p-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="w-full">
              <div className="flex w-full items-center gap-2 rounded-md border border-input bg-background px-2 py-1.5 focus-within:border-primary">
                <Search className="h-4 w-4 text-muted-foreground" />
                <Input
                  aria-label="Search modules"
                  className="h-8 min-w-0 flex-1 border-0 px-0 focus-visible:ring-0 focus-visible:ring-offset-0"
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search modules"
                  value={searchQuery}
                />

                {searchQuery.trim() ? (
                  <Button
                    aria-label="Clear search"
                    className="h-8 w-8"
                    onClick={() => setSearchQuery("")}
                    size="icon"
                    type="button"
                    variant="ghost"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                ) : null}

                <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                  {loading
                    ? "Loading…"
                    : `${filteredRepositories.length} module${
                        filteredRepositories.length === 1 ? "" : "s"
                      }`}
                </span>

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      className="gap-2"
                      size="sm"
                      type="button"
                      variant={activeFilterCount ? "secondary" : "outline"}
                    >
                      <Filter className="h-4 w-4" />
                      Filters
                      {activeFilterCount ? (
                        <span className="ml-1 rounded bg-muted px-1.5 py-0.5 text-xs">
                          {activeFilterCount}
                        </span>
                      ) : null}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-[340px] p-0">
                    <div className="flex items-center justify-between border-b px-4 py-3">
                      <DropdownMenuLabel className="p-0">
                        Filters
                      </DropdownMenuLabel>
                      <Button
                        className="h-7 px-2 text-xs"
                        disabled={
                          !searchQuery.trim() &&
                          selectedTags.length === 0 &&
                          !selectedLibrary
                        }
                        onClick={clearAll}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        Clear all
                      </Button>
                    </div>

                    <div className="space-y-4 p-4">
                      <div className="space-y-2">
                        <Label htmlFor="module-library-filter">Library</Label>
                        <Select
                          id="module-library-filter"
                          onChange={(e) => setSelectedLibrary(e.target.value)}
                          value={selectedLibrary}
                        >
                          <option value="">All</option>
                          {libraryOptions.map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.name}
                            </option>
                          ))}
                          <option value={OWN_IMPORTS}>Your imports</option>
                        </Select>
                      </div>

                      <TagsInput
                        disabled={availableTags.length === 0}
                        label="Filter by tags"
                        onChange={setSelectedTags}
                        placeholder={
                          availableTags.length
                            ? "Add tag filters…"
                            : "No tags available"
                        }
                        suggestions={availableTags}
                        suggestionsOnly
                        value={selectedTags}
                      />
                      {availableTags.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          No tags available yet.
                        </p>
                      ) : null}
                    </div>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              {selectedTags.length > 0 || selectedLibrary ? (
                <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                  {selectedLibrary ? (
                    <span className="rounded border bg-background px-2 py-1">
                      library:{" "}
                      <span className="font-medium text-foreground">
                        {selectedLibrary === OWN_IMPORTS
                          ? "Your imports"
                          : (libraryOptions.find(
                              (o) => o.id === selectedLibrary,
                            )?.name ?? selectedLibrary)}
                      </span>
                    </span>
                  ) : null}
                  {selectedTags.map((tag) => (
                    <span
                      className="rounded border bg-background px-2 py-1"
                      key={tag}
                    >
                      tag:{" "}
                      <span className="font-medium text-foreground">{tag}</span>
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          </div>

          {libraries.map((library) => (
            <LibraryAccessHint key={library.id} library={library} />
          ))}

          {libraries.some(
            (library) =>
              syncingIds.includes(library.id) || library.moduleCount > 0,
          ) ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {libraries.map((library) =>
                syncingIds.includes(library.id) ? (
                  <span aria-live="polite" key={library.id}>
                    Syncing the {library.name} library…
                  </span>
                ) : library.moduleCount > 0 ? (
                  <span className="flex items-center gap-1" key={library.id}>
                    {library.name}
                    {library.lastSyncedAt
                      ? ` · synced ${relativeTime(library.lastSyncedAt)}`
                      : ""}
                    <Button
                      aria-label={`Refresh the ${library.name} library`}
                      className="h-6 gap-1 px-1.5 text-xs"
                      onClick={() => refreshLibrary(library.id)}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      <RefreshCw aria-hidden="true" className="h-3 w-3" />
                      Refresh
                    </Button>
                  </span>
                ) : null,
              )}
            </div>
          ) : null}

          {loading ? (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {[0, 1, 2].map((i) => (
                <Skeleton className="h-36 w-full" key={i} />
              ))}
            </div>
          ) : loadError ? (
            <div className="text-sm text-destructive">{loadError}</div>
          ) : filteredRepositories.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              {repositories.length === 0
                ? "No modules available yet."
                : "No modules match your filters."}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {filteredRepositories.map((repo) => (
                <RepositoryCard key={repo.key} repository={repo} />
              ))}
            </div>
          )}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
