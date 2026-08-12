"use client";

import { useAuth } from "@terrablox/auth/hooks";
import { Badge } from "@terrablox/ui/badge";
import { SidebarInset, SidebarProvider } from "@terrablox/ui/sidebar";
import {
  ArrowLeft,
  ArrowRightLeft,
  Boxes,
  ExternalLink,
  FileText,
  GitBranch,
  LayoutGrid,
  Network,
  Package,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { PageHeader } from "@/components/layout/page-header";
import { TabsNav, tabPanelProps } from "@/components/layout/tabs-nav";
import { ModuleActionsMenu } from "@/components/module-actions/module-actions-menu";
import { ArchitectureTab } from "@/components/module-detail/architecture-tab";
import { ConnectionsTab } from "@/components/module-detail/connections-tab";
import { DependenciesTab } from "@/components/module-detail/dependencies-tab";
import { ModuleDetailSkeleton } from "@/components/module-detail/detail-skeleton";
import { ReadmeTab } from "@/components/module-detail/readme-tab";
import { ResourcesTab } from "@/components/module-detail/resources-tab";
import { SourceTab } from "@/components/module-detail/source-tab";
import { SubmoduleSwitcher } from "@/components/module-detail/submodule-switcher";
import {
  type ModuleDetailDto,
  type ModuleSubmoduleDto,
  parseOutputs,
  parseVariables,
} from "@/components/module-detail/types";
import { VariablesTab } from "@/components/module-detail/variables-tab";
import { VersionSwitcher } from "@/components/module-detail/version-switcher";
import { useHashTab } from "@/lib/use-hash-tab";

type TabKey =
  | "readme"
  | "variables"
  | "dependencies"
  | "architecture"
  | "connections"
  | "resources"
  | "source";

const TAB_KEYS: readonly TabKey[] = [
  "readme",
  "variables",
  "dependencies",
  "architecture",
  "connections",
  "resources",
  "source",
];

/** Links handed out while inputs and outputs were separate tabs. */
const TAB_ALIASES: Readonly<Record<string, TabKey>> = {
  inputs: "variables",
  outputs: "variables",
};

const README_CANDIDATES = [
  "README.md",
  "readme.md",
  "README.MD",
  "Readme.md",
  "README.markdown",
];

function extractOwnerRepo(url: string): { owner: string; repo: string } | null {
  const m = url.match(
    /github\.com\/(?<owner>[^/]+)\/(?<repo>[^/#?]+)(?:[/?#].*)?$/i,
  );
  const owner = m?.groups?.["owner"];
  const repoRaw = m?.groups?.["repo"];
  if (!owner || !repoRaw) return null;
  return { owner, repo: repoRaw.replace(/\.git$/i, "") };
}

function decodeBase64Utf8(value: string): string {
  const binary = atob(value.replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function InfoField(props: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-muted-foreground">
        {props.label}
      </div>
      <div className="text-sm">{props.children}</div>
    </div>
  );
}

export default function ModuleDetailPage({
  params,
}: {
  params: { moduleId: string };
}) {
  const { isAuthenticated, user } = useAuth();
  const router = useRouter();
  const moduleId = params.moduleId;

  const [tab, setTab] = useHashTab<TabKey>(
    TAB_KEYS,
    "readme",
    moduleId,
    TAB_ALIASES,
  );
  const [mod, setMod] = useState<ModuleDetailDto | null>(null);
  const [parentMod, setParentMod] = useState<{
    id: string;
    effectiveName: string;
    submodules: ModuleSubmoduleDto[];
  } | null>(null);
  // A link to the retired submodules tab should still arrive at the list.
  const [submodulesOpen, setSubmodulesOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [readmeMd, setReadmeMd] = useState<string | null>(null);
  const [readmeLoading, setReadmeLoading] = useState(false);
  const [readmeError, setReadmeError] = useState<string | null>(null);

  // The submodules tab became a dropdown. `useHashTab` no longer knows the
  // fragment and falls back to the README, so open the dropdown instead of
  // dropping the reader somewhere unrelated, and correct the address bar.
  //
  // `moduleId` is listed without being read: like the hook's own `resetKey` it
  // exists to re-run this on navigating to another module.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate re-run trigger
  useEffect(() => {
    if (window.location.hash !== "#submodules") return;
    setSubmodulesOpen(true);
    window.history.replaceState(null, "", "#readme");
  }, [moduleId]);

  useEffect(() => {
    if (!user?.id || !moduleId) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`/api/modules/${encodeURIComponent(moduleId)}`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(
            typeof body?.error === "string" && body.error
              ? body.error
              : "Failed to load module",
          );
        }
        return (body?.module ?? null) as ModuleDetailDto | null;
      })
      .then((moduleDto) => {
        if (cancelled) return;
        setMod(moduleDto);

        const parentId = moduleDto?.isSubmodule
          ? moduleDto.parentModuleId
          : null;

        if (!parentId) {
          setParentMod(null);
          return;
        }

        // Breadcrumb and sibling switcher; failures are not worth surfacing.
        fetch(`/api/modules/${encodeURIComponent(parentId)}`)
          .then(async (r) => (r.ok ? await r.json() : null))
          .then((b) => {
            const p = b?.module as ModuleDetailDto | null;
            if (!cancelled && p?.id) {
              setParentMod({
                id: p.id,
                effectiveName: p.effectiveName ?? "Parent module",
                submodules: p.submodules ?? [],
              });
            }
          })
          .catch(() => undefined);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load module");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [user?.id, moduleId]);

  const repoRef = useMemo(() => {
    if (!mod?.source?.url) return null;
    const parsed = extractOwnerRepo(mod.source.url);
    if (!parsed) return null;
    return { ...parsed, ref: mod.versionTag };
  }, [mod?.source?.url, mod?.versionTag]);

  useEffect(() => {
    // Fetched lazily so opening other tabs does not spend GitHub rate limit.
    if (tab !== "readme") return;
    if (readmeMd !== null || readmeError !== null) return;
    if (!repoRef?.ref) return;

    const { owner, repo, ref } = repoRef;
    // A submodule's README lives inside its folder, not at the repo root.
    const folder =
      mod?.terraformRootFolder && mod.terraformRootFolder !== "."
        ? `${mod.terraformRootFolder.replace(/^\/+|\/+$/g, "")}/`
        : "";

    let cancelled = false;
    setReadmeLoading(true);
    setReadmeError(null);

    (async () => {
      for (const name of README_CANDIDATES) {
        // Prefer the module folder, but fall back to the repo root.
        for (const path of folder ? [`${folder}${name}`, name] : [name]) {
          try {
            const res = await fetch(
              `/api/git-provider/github/repos/${encodeURIComponent(
                owner,
              )}/${encodeURIComponent(repo)}/contents?ref=${encodeURIComponent(
                ref,
              )}&path=${encodeURIComponent(path)}`,
            );
            if (!res.ok) continue;

            const body = await res.json().catch(() => null);
            if (
              typeof body?.content !== "string" ||
              body?.encoding !== "base64"
            ) {
              continue;
            }

            if (!cancelled) {
              setReadmeMd(decodeBase64Utf8(body.content));
              setReadmeLoading(false);
            }
            return;
          } catch {
            // Try the next candidate.
          }
        }
      }

      if (!cancelled) {
        setReadmeError("No README found in this repository.");
        setReadmeLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [tab, repoRef, mod?.terraformRootFolder, readmeMd, readmeError]);

  const variables = useMemo(() => parseVariables(mod?.variables), [mod]);
  const outputs = useMemo(() => parseOutputs(mod?.outputs), [mod]);

  const providers = useMemo(
    () =>
      (mod?.providers ?? []).map((p) => ({ name: p.name, version: p.version })),
    [mod?.providers],
  );

  const readmeImageBase = useMemo(() => {
    if (!repoRef?.ref) return null;
    const folder =
      mod?.terraformRootFolder && mod.terraformRootFolder !== "."
        ? `/${mod.terraformRootFolder.replace(/^\/+|\/+$/g, "")}`
        : "";
    return `https://raw.githubusercontent.com/${repoRef.owner}/${repoRef.repo}/${repoRef.ref}${folder}`;
  }, [repoRef, mod?.terraformRootFolder]);

  if (!isAuthenticated) return null;

  const title = mod?.effectiveName ?? "Module";

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <PageHeader
          loading={loading}
          breadcrumbs={[
            { label: "Modules", href: "/modules" },
            ...(mod?.isSubmodule && parentMod
              ? [
                  {
                    label: parentMod.effectiveName,
                    href: `/modules/${encodeURIComponent(parentMod.id)}`,
                  },
                ]
              : []),
            { label: title },
          ]}
          actions={
            mod ? (
              <>
                <VersionSwitcher
                  currentModuleId={mod.id}
                  switchTargetId={
                    mod.isSubmodule ? (mod.parentModuleId ?? undefined) : mod.id
                  }
                  versions={mod.versions ?? []}
                />

                <ModuleActionsMenu
                  module={{
                    id: mod.id,
                    name: title,
                    versionTag: mod.versionTag,
                    repoUrl: mod.source?.url ?? null,
                    refUrl: mod.url,
                    terraformRootFolder: mod.terraformRootFolder,
                    isSubmodule: mod.isSubmodule,
                    parentModuleId: mod.parentModuleId,
                    versionCount: mod.versions?.length ?? 1,
                  }}
                  onDeleted={() => router.push("/modules")}
                />
              </>
            ) : null
          }
        />

        <main className="space-y-4 p-4">
          {loading ? (
            <ModuleDetailSkeleton />
          ) : error ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
              {error}
            </div>
          ) : !mod ? (
            <div className="text-sm text-muted-foreground">
              Module not found.
            </div>
          ) : (
            <>
              <section className="rounded-lg border bg-card p-4">
                {/* The name lives in the header; repeating it here would give
                    the page two titles. */}
                <div className="flex items-start justify-between gap-4">
                  <p className="min-w-0 text-sm leading-6 break-words">
                    {mod.isSubmodule ? (
                      <Badge variant="outline" className="mr-2 align-middle">
                        Submodule
                      </Badge>
                    ) : null}
                    {mod.effectiveDescription?.trim()
                      ? mod.effectiveDescription
                      : "No description provided."}
                  </p>

                  {mod.isSubmodule && parentMod ? (
                    <Link
                      className="inline-flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                      href={`/modules/${encodeURIComponent(parentMod.id)}`}
                    >
                      <ArrowLeft className="h-3.5 w-3.5" />
                      Return to {parentMod.effectiveName}
                    </Link>
                  ) : null}
                </div>

                <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <InfoField label="Version">
                    {mod.url && mod.versionTag ? (
                      <a
                        className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline"
                        href={mod.url}
                        rel="noreferrer"
                        target="_blank"
                      >
                        <GitBranch className="h-3.5 w-3.5" />
                        {mod.versionTag}
                      </a>
                    ) : (
                      <span className="text-muted-foreground">
                        {mod.versionTag ?? "(none)"}
                      </span>
                    )}
                  </InfoField>

                  <InfoField label="Repository">
                    {mod.source?.url ? (
                      <a
                        className="inline-flex items-center gap-1 truncate font-medium text-primary underline-offset-4 hover:underline"
                        href={mod.source.url}
                        rel="noreferrer"
                        target="_blank"
                      >
                        <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{mod.source.name}</span>
                      </a>
                    ) : (
                      <span className="text-muted-foreground">(none)</span>
                    )}
                  </InfoField>

                  <InfoField label="Folder">
                    <code className="font-mono text-xs text-muted-foreground">
                      {mod.terraformRootFolder || "."}
                    </code>
                  </InfoField>

                  <InfoField label="Tags">
                    {mod.source?.tags?.length ? (
                      <div className="flex flex-wrap gap-1.5">
                        {mod.source.tags.map((t) => (
                          <Badge key={t} variant="outline">
                            {t}
                          </Badge>
                        ))}
                      </div>
                    ) : (
                      <span className="text-muted-foreground">No tags.</span>
                    )}
                  </InfoField>
                </div>

                {/* A submodule lists its siblings, a root module its children;
                    either way the switcher stays put across every tab. */}
                <SubmoduleSwitcher
                  className="mt-4 border-t pt-4"
                  currentId={mod.isSubmodule ? mod.id : undefined}
                  onOpenChange={setSubmodulesOpen}
                  open={submodulesOpen}
                  submodules={
                    mod.isSubmodule
                      ? (parentMod?.submodules ?? [])
                      : (mod.submodules ?? [])
                  }
                />
              </section>

              <TabsNav
                tabs={[
                  { value: "readme", label: "README", icon: FileText },
                  {
                    value: "variables",
                    label: "Variables",
                    icon: ArrowRightLeft,
                    count: variables.length + outputs.length,
                  },
                  {
                    value: "dependencies",
                    label: "Dependencies",
                    icon: Package,
                    count: mod.dependencies?.length ?? 0,
                  },
                  {
                    value: "architecture",
                    label: "Architecture",
                    icon: LayoutGrid,
                  },
                  {
                    value: "connections",
                    label: "Connections",
                    icon: Network,
                    count: mod.references?.length ?? 0,
                  },
                  {
                    value: "resources",
                    label: "Resources",
                    icon: Boxes,
                    count: mod.resources?.length ?? 0,
                  },
                  { value: "source", label: "Source code", icon: FileText },
                ]}
                value={tab}
                onChange={setTab}
                idPrefix="module"
                label="Module views"
              />

              <div {...tabPanelProps("module", tab)} className="space-y-4">
                {tab === "readme" ? (
                  <ReadmeTab
                    error={readmeError}
                    imageBaseUrl={readmeImageBase}
                    loading={readmeLoading}
                    markdown={readmeMd}
                  />
                ) : null}

                {tab === "variables" ? (
                  <VariablesTab outputs={outputs} variables={variables} />
                ) : null}

                {tab === "dependencies" ? (
                  <DependenciesTab
                    dependencies={mod.dependencies ?? []}
                    dependents={mod.dependents ?? []}
                    providers={providers}
                  />
                ) : null}

                {tab === "architecture" ? (
                  <ArchitectureTab
                    dependencies={mod.dependencies ?? []}
                    moduleId={mod.id}
                    references={mod.references ?? []}
                    resources={mod.resources ?? []}
                  />
                ) : null}

                {tab === "connections" ? (
                  <ConnectionsTab
                    dependencies={mod.dependencies ?? []}
                    moduleId={mod.id}
                    references={mod.references ?? []}
                    resources={mod.resources ?? []}
                  />
                ) : null}

                {tab === "resources" ? (
                  <ResourcesTab resources={mod.resources ?? []} />
                ) : null}

                {tab === "source" ? (
                  <SourceTab
                    gitRef={repoRef?.ref ?? null}
                    owner={repoRef?.owner ?? null}
                    repo={repoRef?.repo ?? null}
                    repoUrl={mod.source?.url ?? null}
                    rootFolder={mod.terraformRootFolder}
                  />
                ) : null}
              </div>
            </>
          )}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
