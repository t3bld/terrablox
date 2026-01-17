"use client";

import Link from "next/link";

import { useAuth } from "@terrablox/auth/hooks";
import { Button } from "@terrablox/ui/button";
import { Card, CardContent } from "@terrablox/ui/card";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@terrablox/ui/dropdown-menu";
import { Input } from "@terrablox/ui/input";
import { Separator } from "@terrablox/ui/separator";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@terrablox/ui/sidebar";
import { Boxes, Filter, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { ModuleImportActions } from "@/components/module-import-actions";
import { TagsInput } from "@/components/tags-input";

interface ModuleDto {
  id: string;
  versionTag: string | null;
  terraformRootFolder: string | null;
  isSubmodule: boolean;
  parentModuleId: string | null;
  updatedAt: string;
  submoduleName?: string | null;
  effectiveName?: string;
  effectiveDescription?: string | null;
  source?: {
    id: string;
    name: string;
    description: string | null;
    tags: string[];
    url: string;
    provider: string;
  } | null;
}

function normalizeTag(input: string) {
  return input.trim().replace(/\s+/g, "-").toLowerCase();
}

export default function ModulesPage() {
  const { isAuthenticated, user } = useAuth();
  const [modules, setModules] = useState<ModuleDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [showSubmodules, setShowSubmodules] = useState(true);

  useEffect(() => {
    if (!user?.id) return;
    setLoading(true);
    setLoadError(null);

    fetch(`/api/modules/list?userId=${encodeURIComponent(user.id)}`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(
            typeof body?.error === "string" && body.error
              ? body.error
              : "Failed to load modules",
          );
        }
        setModules((body?.modules ?? []) as ModuleDto[]);
      })
      .catch((e) =>
        setLoadError(e instanceof Error ? e.message : "Failed to load modules"),
      )
      .finally(() => setLoading(false));
  }, [user?.id]);

  const availableTags = useMemo(() => {
    const set = new Set<string>();
    for (const m of modules) {
      for (const t of m.source?.tags ?? []) {
        const n = normalizeTag(t);
        if (n) set.add(n);
      }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [modules]);

  const filteredModules = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const selected = (selectedTags ?? []).map(normalizeTag).filter(Boolean);

    return modules
      .filter((m) => (showSubmodules ? true : !m.isSubmodule))
      .filter((m) => {
        const hay = `${m.effectiveName ?? ""} ${m.effectiveDescription ?? ""} ${(m.source?.tags ?? []).join(" ")} ${m.source?.url ?? ""} ${m.versionTag ?? ""} ${m.terraformRootFolder ?? ""}`.toLowerCase();
        const matchesSearch = !q || hay.includes(q);

        const moduleTags = (m.source?.tags ?? []).map(normalizeTag).filter(Boolean);
        const matchesTags =
          selected.length === 0 || selected.every((t) => moduleTags.includes(t));

        return matchesSearch && matchesTags;
      });
  }, [modules, searchQuery, selectedTags, showSubmodules]);

  const activeFilterCount =
    (selectedTags?.length ?? 0) + (showSubmodules ? 0 : 1);

  function clearAll() {
    setSearchQuery("");
    setSelectedTags([]);
    setShowSubmodules(true);
  }

  if (!isAuthenticated) {
    return null;
  }

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-3">
            <SidebarTrigger />
            <div className="flex items-center gap-2">
              <Boxes className="h-5 w-5" />
              <h1 className="text-lg font-semibold">Modules</h1>
            </div>
          </div>
          <ModuleImportActions />
        </header>

        <main className="p-4 space-y-4">
          {/* Modern integrated search + filters bar */}
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="flex-1">
              <div className="flex items-center gap-2 rounded-md border border-input bg-background px-2 py-1.5 focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 ring-offset-background">
                <Search className="h-4 w-4 text-muted-foreground" />
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search modules (name, tags, url, ref, folder)"
                  className="border-0 focus-visible:ring-0 focus-visible:ring-offset-0 h-8 px-0"
                  aria-label="Search modules"
                />

                {searchQuery.trim() ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => setSearchQuery("")}
                    aria-label="Clear search"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                ) : null}

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant={activeFilterCount ? "secondary" : "outline"}
                      size="sm"
                      className="gap-2"
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
                        <div className="text-xs font-medium text-muted-foreground mb-2">
                          Tags
                        </div>
                        <TagsInput
                          value={selectedTags}
                          onChange={setSelectedTags}
                          suggestions={availableTags}
                          placeholder={
                            availableTags.length
                              ? "Add tag filters…"
                              : "No tags available"
                          }
                          disabled={availableTags.length === 0}
                        />
                      </div>

                      <div className="pt-1">
                        <div className="text-xs font-medium text-muted-foreground mb-2">
                          Visibility
                        </div>
                        <DropdownMenuCheckboxItem
                          checked={showSubmodules}
                          onCheckedChange={(v) => setShowSubmodules(Boolean(v))}
                        >
                          Show submodules
                        </DropdownMenuCheckboxItem>
                      </div>

                      <div className="flex items-center justify-end gap-2 pt-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={clearAll}
                          disabled={
                            !searchQuery.trim() &&
                            selectedTags.length === 0 &&
                            showSubmodules
                          }
                        >
                          Clear all
                        </Button>
                      </div>
                    </div>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              {(selectedTags.length > 0 || !showSubmodules) && (
                <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                  {selectedTags.map((t) => (
                    <span
                      key={t}
                      className="rounded border px-2 py-1 bg-background"
                    >
                      tag:{" "}
                      <span className="font-medium text-foreground">{t}</span>
                    </span>
                  ))}
                  {!showSubmodules ? (
                    <span className="rounded border px-2 py-1 bg-background">
                      <span className="font-medium text-foreground">root only</span>
                    </span>
                  ) : null}
                </div>
              )}
            </div>

            <div className="text-sm text-muted-foreground shrink-0">
              {loading ? "Loading…" : `${filteredModules.length} modules`}
            </div>
          </div>

          <Separator />

          {loading ? (
            <div className="text-sm text-muted-foreground">Loading</div>
          ) : loadError ? (
            <div className="text-sm text-destructive">{loadError}</div>
          ) : filteredModules.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No modules match your filters.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {filteredModules.map((mod) => (
                <Link
                  key={mod.id}
                  href={`/modules/${encodeURIComponent(mod.id)}`}
                  className="block"
                >
                  <Card className="h-full hover:bg-muted/40 transition-colors">
                    <CardContent className="p-4 space-y-2">
                      <div className="min-w-0">
                        <div className="font-medium truncate">
                          {mod.effectiveName ?? "(unnamed)"}
                        </div>
                        {mod.effectiveDescription ? (
                          <div className="text-sm text-muted-foreground line-clamp-2">
                            {mod.effectiveDescription}
                          </div>
                        ) : null}
                      </div>

                      <div className="text-xs text-muted-foreground space-y-1">
                        <div>
                          {mod.isSubmodule ? "Submodule" : "Root"} ·{" "}
                          {mod.terraformRootFolder ?? "."}
                        </div>
                        <div>
                          {mod.versionTag
                            ? `ref: ${mod.versionTag}`
                            : "ref: (none)"}
                        </div>
                        {mod.source?.url ? (
                          <div className="truncate">{mod.source.url}</div>
                        ) : null}
                        {mod.source?.tags?.length ? (
                          <div className="truncate">tags: {mod.source.tags.join(", ")}</div>
                        ) : null}
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>
          )}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
