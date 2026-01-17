"use client";

import { useAuth } from "@terrablox/auth/hooks";
import { Card, CardContent } from "@terrablox/ui/card";
import { Input } from "@terrablox/ui/input";
import { Separator } from "@terrablox/ui/separator";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@terrablox/ui/sidebar";
import { Boxes, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { ModuleImportActions } from "@/components/module-import-actions";

interface ModuleSourceDto {
  id: string;
  name: string;
  description: string | null;
  tags: string[];
  url: string;
  provider: string;
  versions: Array<{
    id: string;
    versionTag: string | null;
    terraformRootFolder: string | null;
    isSubmodule: boolean;
    parentModuleId: string | null;
    updatedAt: string;
    submoduleName?: string | null;
    effectiveName?: string;
    effectiveDescription?: string | null;
  }>;
}

export default function ModulesPage() {
  const { isAuthenticated, user } = useAuth();
  const [sources, setSources] = useState<ModuleSourceDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

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
        setSources((body?.sources ?? []) as ModuleSourceDto[]);
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : "Failed to load modules"))
      .finally(() => setLoading(false));
  }, [user?.id]);

  const filteredSources = useMemo(() => {
    if (!searchQuery.trim()) return sources;
    const q = searchQuery.toLowerCase();
    return sources.filter((s) => {
      const hay = `${s.name} ${s.description ?? ""} ${(s.tags ?? []).join(" ")}`.toLowerCase();
      return hay.includes(q);
    });
  }, [sources, searchQuery]);

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
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search modules"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
              aria-label="Search modules"
            />
          </div>

          <Separator />

          {loading ? (
            <div className="text-sm text-muted-foreground">Loading</div>
          ) : loadError ? (
            <div className="text-sm text-destructive">{loadError}</div>
          ) : filteredSources.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No modules yet. Use “Import from GitHub” to add your first one.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3">
              {filteredSources.map((source) => (
                <Card key={source.id}>
                  <CardContent className="p-4 space-y-3">
                    <div>
                      <div className="font-medium">{source.name}</div>
                      {source.description ? (
                        <div className="text-sm text-muted-foreground">
                          {source.description}
                        </div>
                      ) : null}
                      <div className="text-xs text-muted-foreground mt-1">
                        {source.provider} {source.url}
                      </div>
                      {source.tags?.length ? (
                        <div className="text-xs text-muted-foreground mt-1">
                          tags: {source.tags.join(", ")}
                        </div>
                      ) : null}
                    </div>

                    <Separator />

                    <div className="space-y-1">
                      <div className="text-xs font-medium text-muted-foreground">
                        Imported versions
                      </div>
                      <div className="space-y-1">
                        {source.versions.map((v) => (
                          <div
                            key={v.id}
                            className="text-sm flex items-center justify-between"
                          >
                            <div className="min-w-0">
                              <div className="truncate">
                                {v.effectiveName ?? "(unnamed)"} {" "}
                                {v.isSubmodule ? "Submodule" : "Root"} {" "}
                                {v.terraformRootFolder ?? "."}
                              </div>
                              <div className="text-xs text-muted-foreground">
                                {v.versionTag ? `ref: ${v.versionTag}` : "ref: (none)"}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
