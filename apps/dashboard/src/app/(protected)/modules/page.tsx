"use client";

import { useAuth } from "@terrablox/auth/hooks";
import { Button } from "@terrablox/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@terrablox/ui/dropdown-menu";
import { Input } from "@terrablox/ui/input";
import { Separator } from "@terrablox/ui/separator";
import { SidebarInset, SidebarProvider } from "@terrablox/ui/sidebar";
import { Skeleton } from "@terrablox/ui/skeleton";
import { Filter, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { PageHeader } from "@/components/layout/page-header";
import { ModuleImportActions } from "@/components/module-import-actions";
import { RepositoryCard } from "@/components/module-overview/repository-card";
import type { RepositoryDto } from "@/components/module-overview/types";
import { TagsInput } from "@/components/tags-input";
import type { DeleteScope } from "@/lib/terraform/delete-scope";

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

      return matchesSearch && matchesTags;
    });
  }, [repositories, searchQuery, selectedTags]);

  const activeFilterCount = selectedTags.length;

  const clearAll = useCallback(() => {
    setSearchQuery("");
    setSelectedTags([]);
  }, []);

  const handleDeleted = useCallback((moduleId: string, scope: DeleteScope) => {
    setRepositories((prev) =>
      prev
        .map((repo) => {
          const owns = repo.versions.some((v) => v.id === moduleId);
          if (!owns) return repo;

          // `scope=module` wipes the repository outright; `scope=version`
          // leaves the remaining refs behind, so the card must re-derive its
          // latest version rather than disappear.
          if (scope === "module") {
            return { ...repo, versions: [], latestVersion: null };
          }

          const versions = repo.versions.filter((v) => v.id !== moduleId);
          return {
            ...repo,
            versions,
            versionCount: versions.length,
            latestVersion: versions[0] ?? null,
            totalSubmoduleCount: versions.reduce(
              (sum, v) => sum + v.submoduleCount,
              0,
            ),
          };
        })
        .filter((repo) => repo.latestVersion !== null),
    );
  }, []);

  if (!isAuthenticated) {
    return null;
  }

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <PageHeader
          breadcrumbs={[{ label: "Modules" }]}
          actions={
            <ModuleImportActions
              onImported={() => {
                void loadRepositories({ silent: true });
              }}
            />
          }
        />

        <main className="space-y-4 p-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="flex-1">
              <div className="flex items-center gap-2 rounded-md border border-input bg-background px-2 py-1.5 ring-offset-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
                <Search className="h-4 w-4 text-muted-foreground" />
                <Input
                  aria-label="Search modules"
                  className="h-8 border-0 px-0 focus-visible:ring-0 focus-visible:ring-offset-0"
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search modules (name, tags, url, ref, folder)"
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
                  <DropdownMenuContent align="end" className="w-[340px] p-3">
                    <DropdownMenuLabel>Filters</DropdownMenuLabel>
                    <DropdownMenuSeparator />

                    <div className="space-y-3 p-1">
                      <div>
                        <div className="mb-2 text-xs font-medium text-muted-foreground">
                          Tags
                        </div>
                        <TagsInput
                          disabled={availableTags.length === 0}
                          onChange={setSelectedTags}
                          placeholder={
                            availableTags.length
                              ? "Add tag filters…"
                              : "No tags available"
                          }
                          suggestions={availableTags}
                          value={selectedTags}
                        />
                      </div>

                      <div className="flex items-center justify-end gap-2 pt-2">
                        <Button
                          disabled={
                            !searchQuery.trim() && selectedTags.length === 0
                          }
                          onClick={clearAll}
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          Clear all
                        </Button>
                      </div>
                    </div>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              {selectedTags.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
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

            <div className="shrink-0 text-sm text-muted-foreground">
              {loading
                ? "Loading…"
                : `${filteredRepositories.length} module${
                    filteredRepositories.length === 1 ? "" : "s"
                  }`}
            </div>
          </div>

          <Separator />

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
                ? "No modules imported yet."
                : "No modules match your filters."}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {filteredRepositories.map((repo) => (
                <RepositoryCard
                  key={repo.key}
                  onDeleted={handleDeleted}
                  repository={repo}
                />
              ))}
            </div>
          )}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
