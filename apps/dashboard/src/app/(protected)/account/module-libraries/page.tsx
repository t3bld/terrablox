"use client";

import { useAuth } from "@terrablox/auth/hooks";
import { Badge } from "@terrablox/ui/badge";
import { Button } from "@terrablox/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@terrablox/ui/card";
import { SidebarInset, SidebarProvider } from "@terrablox/ui/sidebar";
import { Library, RefreshCw } from "lucide-react";
import { AppSidebar } from "@/components/app-sidebar";
import { PageHeader } from "@/components/layout/page-header";
import {
  CardGridSkeleton,
  PageSkeleton,
} from "@/components/layout/page-skeleton";
import { LibraryAccessHint } from "@/components/module-overview/library-access-hint";
import {
  type ModuleLibraryStatus,
  useModuleLibraries,
} from "@/components/module-overview/use-module-libraries";

const STATE_LABELS: Record<ModuleLibraryStatus["state"], string> = {
  never: "Not synced",
  available: "Available",
  "not-installed": "App required",
  "no-repos": "No repositories",
  unavailable: "Unavailable",
  error: "Error",
};

function statusVariant(
  library: ModuleLibraryStatus,
): "success" | "warning" | "destructive" | "secondary" {
  if (library.ready) return "success";
  if (library.state === "error") return "destructive";
  if (library.state === "not-installed" || library.state === "no-repos") {
    return "warning";
  }
  return "secondary";
}

function lastSync(iso: string | null): string {
  if (!iso) return "Never";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export default function ModuleLibrariesPage() {
  const { isAuthenticated, user } = useAuth();
  const { libraries, syncingIds, refresh } = useModuleLibraries({
    enabled: Boolean(user?.id),
    includeGlobal: true,
  });

  if (!isAuthenticated || !user) {
    return (
      <PageSkeleton
        breadcrumbs={[
          { label: "Account", href: "/account" },
          { label: "Module Libraries" },
        ]}
      >
        <CardGridSkeleton count={3} />
      </PageSkeleton>
    );
  }

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <PageHeader
          breadcrumbs={[
            { label: "Account", href: "/account" },
            { label: "Module Libraries" },
          ]}
        />

        <main className="flex-1 space-y-6 p-6">
          <div>
            <h1 className="font-semibold text-2xl tracking-tight">
              Module Libraries
            </h1>
            <p className="mt-1 text-muted-foreground text-sm">
              Global and account-specific libraries available to you.
            </p>
          </div>

          {libraries
            .filter((library) => library.scope === "user")
            .map((library) => (
              <LibraryAccessHint key={`hint-${library.id}`} library={library} />
            ))}

          {libraries.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
                <Library
                  aria-hidden="true"
                  className="h-8 w-8 text-muted-foreground"
                />
                <p className="font-medium">No module libraries available</p>
                <p className="max-w-md text-muted-foreground text-sm">
                  Libraries appear here after Terrablox can access their module
                  repositories for your account.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {libraries.map((library) => {
                const syncing =
                  library.syncing || syncingIds.includes(library.id);
                return (
                  <Card className="flex h-full flex-col" key={library.id}>
                    <CardHeader>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <CardTitle className="truncate text-lg">
                            {library.name}
                          </CardTitle>
                          <CardDescription className="mt-1">
                            {library.org}
                          </CardDescription>
                        </div>
                        <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                          {library.scope === "global" ? (
                            <Badge variant="secondary">Global</Badge>
                          ) : null}
                          <Badge variant={statusVariant(library)}>
                            {syncing ? "Syncing" : STATE_LABELS[library.state]}
                          </Badge>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="flex-1 space-y-4">
                      <dl className="grid grid-cols-3 gap-2">
                        {[
                          ["Repositories", library.repositoryCount],
                          ["Modules", library.moduleCount],
                          ["Submodules", library.submoduleCount],
                        ].map(([label, value]) => (
                          <div
                            className="rounded-md bg-muted/50 p-3"
                            key={label}
                          >
                            <dt className="text-[11px] text-muted-foreground">
                              {label}
                            </dt>
                            <dd className="mt-1 font-semibold text-xl tabular-nums">
                              {value}
                            </dd>
                          </div>
                        ))}
                      </dl>
                      <p className="text-[11px] text-muted-foreground">
                        Modules and submodules count the default branch only,
                        not tagged versions.
                      </p>
                      <div className="text-sm">
                        <span className="text-muted-foreground">
                          Last sync:{" "}
                        </span>
                        <span>{lastSync(library.lastSyncedAt)}</span>
                      </div>
                    </CardContent>
                    {library.scope === "global" ? (
                      <CardFooter className="text-muted-foreground text-xs">
                        Managed by your Terrablox administrator.
                      </CardFooter>
                    ) : library.ready || library.moduleCount > 0 ? (
                      <CardFooter>
                        <Button
                          aria-label={`Refresh the ${library.name} library`}
                          disabled={syncing}
                          onClick={() => refresh(library.id)}
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          <RefreshCw
                            aria-hidden="true"
                            className={`mr-2 h-4 w-4 ${syncing ? "animate-spin" : ""}`}
                          />
                          {syncing ? "Refreshing" : "Refresh"}
                        </Button>
                      </CardFooter>
                    ) : null}
                  </Card>
                );
              })}
            </div>
          )}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
