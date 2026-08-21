"use client";

import { Badge } from "@terrablox/ui/badge";
import { Button } from "@terrablox/ui/button";
import { SidebarInset, SidebarProvider } from "@terrablox/ui/sidebar";
import {
  ArrowLeft,
  ArrowRightLeft,
  Boxes,
  ExternalLink,
  FileText,
  GitBranch,
  LayoutGrid,
  Package,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { PageHeader } from "@/components/layout/page-header";
import { TabsNav, tabPanelProps } from "@/components/layout/tabs-nav";
import { ModuleActionsMenu } from "@/components/module-actions/module-actions-menu";
import { ArchitectureTab } from "@/components/module-detail/architecture-tab";
import { CostsTab } from "@/components/module-detail/costs-tab";
import { DependenciesTab } from "@/components/module-detail/dependencies-tab";
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
import { ModuleIcon } from "@/components/module-icon";
import { githubFileUrl } from "@/lib/terraform/resource-label";
import { useHashTab } from "@/lib/use-hash-tab";

type TabKey =
  | "readme"
  | "architecture"
  | "costs"
  | "dependencies"
  | "resources"
  | "variables"
  | "code";

/** Listed in the order they appear on the bar; `code` sits off it, see below. */
const TAB_KEYS: readonly TabKey[] = [
  "readme",
  "architecture",
  "costs",
  "dependencies",
  "resources",
  "variables",
  "code",
];

/** Fragments from tabs that have since been merged or renamed. */
const TAB_ALIASES: Readonly<Record<string, TabKey>> = {
  inputs: "variables",
  outputs: "variables",
  source: "code",
  // Connections was folded into the architecture graph as its Detail level,
  // then dropped: it drew every Terraform block as an equal card, which the
  // Resources tab already lists more legibly. The alias stays so an existing
  // `#connections` link lands on the diagram rather than silently on the README.
  connections: "architecture",
};

const README_CANDIDATES = [
  "README.md",
  "readme.md",
  "README.MD",
  "Readme.md",
  "README.markdown",
];

export interface ModuleParentDto {
  id: string;
  effectiveName: string;
  submodules: ModuleSubmoduleDto[];
}

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

/**
 * The module detail screen.
 *
 * The module itself arrives from the server, so this component only owns what
 * genuinely belongs to the browser: the selected tab and the README, which is
 * fetched lazily to keep the GitHub rate limit for readers who want it.
 */
export function ModuleDetailView({
  mod,
  parentMod,
}: {
  mod: ModuleDetailDto;
  parentMod: ModuleParentDto | null;
}) {
  const router = useRouter();
  const moduleId = mod.id;

  const [tab, setTab] = useHashTab<TabKey>(
    TAB_KEYS,
    "readme",
    moduleId,
    TAB_ALIASES,
  );
  // A link to the retired submodules tab should still arrive at the list.
  const [submodulesOpen, setSubmodulesOpen] = useState(false);

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

  // The switchers navigate within the same route segment, so this component
  // stays mounted and would otherwise keep the previous module's README.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate re-run trigger
  useEffect(() => {
    setReadmeMd(null);
    setReadmeError(null);
  }, [moduleId]);

  const repoRef = useMemo(() => {
    if (!mod.source?.url) return null;
    const parsed = extractOwnerRepo(mod.source.url);
    if (!parsed) return null;
    return { ...parsed, ref: mod.versionTag };
  }, [mod.source?.url, mod.versionTag]);

  useEffect(() => {
    // Fetched lazily so opening other tabs does not spend GitHub rate limit.
    if (tab !== "readme") return;
    if (readmeMd !== null || readmeError !== null) return;
    if (!repoRef?.ref) return;

    const { owner, repo, ref } = repoRef;
    // A submodule's README lives inside its folder, not at the repo root.
    const folder =
      mod.terraformRootFolder && mod.terraformRootFolder !== "."
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
  }, [tab, repoRef, mod.terraformRootFolder, readmeMd, readmeError]);

  /**
   * Where one of this module's files can be read on GitHub.
   *
   * Built here because it needs all three of the clone URL, the imported ref and
   * the analysed root folder — `sourceFile` is recorded relative to that folder,
   * not to the repository. The architecture panel takes this as a function so it
   * never has to know any of that.
   */
  const architectureFileUrl = useCallback(
    (sourceFile: string) =>
      githubFileUrl({
        cloneUrl: mod.source?.url,
        file: sourceFile,
        ref: mod.versionTag,
        rootFolder: mod.terraformRootFolder,
      }),
    [mod.source?.url, mod.versionTag, mod.terraformRootFolder],
  );

  const variables = useMemo(() => parseVariables(mod.variables), [mod]);
  const outputs = useMemo(() => parseOutputs(mod.outputs), [mod]);

  const providers = useMemo(
    () =>
      (mod.providers ?? []).map((p) => ({
        docsUrl: p.docsUrl,
        name: p.name,
        version: p.version,
      })),
    [mod.providers],
  );

  const readmeImageBase = useMemo(() => {
    if (!repoRef?.ref) return null;
    const folder =
      mod.terraformRootFolder && mod.terraformRootFolder !== "."
        ? `/${mod.terraformRootFolder.replace(/^\/+|\/+$/g, "")}`
        : "";
    return `https://raw.githubusercontent.com/${repoRef.owner}/${repoRef.repo}/${repoRef.ref}${folder}`;
  }, [repoRef, mod.terraformRootFolder]);

  const title = mod.effectiveName ?? "Module";

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <PageHeader
          breadcrumbs={[
            { label: "Modules", href: "/modules" },
            ...(mod.isSubmodule && parentMod
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
            <>
              <VersionSwitcher
                currentModuleId={mod.id}
                switchTargetId={
                  mod.isSubmodule ? (mod.parentModuleId ?? undefined) : mod.id
                }
                versions={mod.versions ?? []}
              />

              <ModuleActionsMenu
                canDelete={!mod.isBuiltin}
                deleteOnly
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
          }
        />

        <main className="space-y-4 p-4">
          <section className="rounded-lg border bg-card p-4">
            {/* The name lives in the header; repeating it here would give
                the page two titles. The icon goes next to the description
                instead — it belongs to the repository, and this is the first
                block on the page that is about the repository. */}
            <div className="flex items-start gap-3">
              <ModuleIcon
                className="h-10 w-10"
                icon={{
                  sourceId: mod.sourceId,
                  iconMode: mod.source?.iconMode ?? "repo",
                  hasIcon: Boolean(mod.source?.iconUrl),
                  iconName: mod.source?.iconName ?? null,
                }}
              />

              <p className="min-w-0 flex-1 text-sm leading-6 break-words">
                {mod.isSubmodule ? (
                  <Badge variant="outline" className="mr-2 align-middle">
                    Submodule
                  </Badge>
                ) : null}
                {mod.effectiveDescription?.trim()
                  ? mod.effectiveDescription
                  : "No description provided."}
              </p>
            </div>

            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
                    {/* The repository's own name, not the module's display name.
                        A link labelled "SQS" pointing at terrablox-aws-sqs hides
                        the one fact this row exists to give. */}
                    <span className="truncate">
                      {repoRef?.repo ?? mod.source.name}
                    </span>
                  </a>
                ) : (
                  <span className="text-muted-foreground">(none)</span>
                )}
              </InfoField>

              {/* Dropped entirely when there are none. A row reading "No tags."
                  spends a column of the header saying nothing. */}
              {mod.source?.tags?.length ? (
                <InfoField label="Tags">
                  <div className="flex flex-wrap gap-1.5">
                    {mod.source.tags.map((t) => (
                      <Badge key={t} variant="outline">
                        {t}
                      </Badge>
                    ))}
                  </div>
                </InfoField>
              ) : null}
            </div>

            {/* A submodule lists its siblings, a root module its children;
                either way the switcher stays put across every tab. */}
            {(mod.isSubmodule && parentMod) || mod.submodules?.length ? (
              <div className="mt-4 flex flex-wrap items-center gap-2 border-t pt-4">
                <SubmoduleSwitcher
                  className="flex"
                  currentId={mod.isSubmodule ? mod.id : undefined}
                  onOpenChange={setSubmodulesOpen}
                  open={submodulesOpen}
                  submodules={
                    mod.isSubmodule
                      ? (parentMod?.submodules ?? [])
                      : (mod.submodules ?? [])
                  }
                />

                {mod.isSubmodule && parentMod ? (
                  <Button
                    asChild
                    className="h-8 gap-1.5 text-xs"
                    variant="outline"
                  >
                    <Link href={`/modules/${encodeURIComponent(parentMod.id)}`}>
                      <ArrowLeft className="h-3.5 w-3.5" />
                      Return to main module
                    </Link>
                  </Button>
                ) : null}
              </div>
            ) : null}
          </section>

          <TabsNav
            tabs={[
              { value: "readme", label: "Readme", icon: FileText },
              {
                value: "architecture",
                label: "Architecture",
                icon: LayoutGrid,
              },
              { value: "costs", label: "Costs", icon: Wallet },
              {
                value: "dependencies",
                label: "Dependencies",
                icon: Package,
                count: providers.length + (mod.dependencies?.length ?? 0),
              },
              {
                value: "resources",
                label: "Resources",
                icon: Boxes,
                count: mod.resources?.length ?? 0,
              },
              {
                value: "variables",
                label: "Variables",
                icon: ArrowRightLeft,
                count: variables.length + outputs.length,
              },
              // No `code` entry: the file browser is off the tab bar. Everything
              // behind it is left standing — the tab key, the `source` alias and
              // the panel below still work — so `#code` in a URL opens it and
              // putting it back is one line.
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
                fileUrl={architectureFileUrl}
                moduleId={mod.id}
                references={mod.references ?? []}
                resources={mod.resources ?? []}
              />
            ) : null}

            {tab === "resources" ? (
              <ResourcesTab resources={mod.resources ?? []} />
            ) : null}

            {tab === "costs" ? (
              <CostsTab resources={mod.resources ?? []} variables={variables} />
            ) : null}

            {tab === "code" ? (
              <SourceTab
                gitRef={repoRef?.ref ?? null}
                owner={repoRef?.owner ?? null}
                repo={repoRef?.repo ?? null}
                repoUrl={mod.source?.url ?? null}
                rootFolder={mod.terraformRootFolder}
              />
            ) : null}
          </div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
