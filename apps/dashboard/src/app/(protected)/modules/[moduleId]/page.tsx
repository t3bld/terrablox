"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { useAuth } from "@terrablox/auth/hooks";
import { Card, CardContent } from "@terrablox/ui/card";
import { Separator } from "@terrablox/ui/separator";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@terrablox/ui/sidebar";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { AppSidebar } from "@/components/app-sidebar";

type TabKey =
  | "readme"
  | "variables"
  | "dependencies"
  | "resources"
  | "submodules"
  | "source";

interface ModuleDetailDto {
  id: string;
  effectiveName: string;
  effectiveDescription: string | null;
  versionTag: string | null;
  url: string | null;
  terraformRootFolder: string | null;
  isSubmodule: boolean;
  submoduleName: string | null;
  parentModuleId: string | null;
  variables: unknown;
  outputs: unknown;
  resources: Array<{
    id: string;
    providerName: string;
    resourceType: string;
    resourceName: string | null;
  }>;
  submodules?: Array<{
    id: string;
    submoduleName: string | null;
    terraformRootFolder: string | null;
  }>;
  source: {
    id: string;
    name: string;
    description: string | null;
    tags: string[];
    url: string;
    provider: string;
  } | null;
}

function TabButton(props: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={
        props.active
          ? "px-3 py-2 text-sm font-medium border-b-2 border-foreground"
          : "px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
      }
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

function extractOwnerRepo(url: string): { owner: string; repo: string } | null {
  // supports: https://github.com/owner/repo(.git)
  const m = url.match(/github\.com\/(?<owner>[^/]+)\/(?<repo>[^/#?]+)(?:[/?#].*)?$/i);
  const owner = m?.groups?.owner;
  const repoRaw = m?.groups?.repo;
  if (!owner || !repoRaw) return null;
  const repo = repoRaw.replace(/\.git$/i, "");
  return { owner, repo };
}

export default function ModuleDetailPage({
  params,
}: {
  params: { moduleId: string };
}) {
  const { isAuthenticated, user } = useAuth();
  const moduleId = params.moduleId;

  const [tab, setTab] = useState<TabKey>("readme");
  const [mod, setMod] = useState<ModuleDetailDto | null>(null);
  const [parentMod, setParentMod] = useState<
    | {
        id: string;
        effectiveName: string;
      }
    | null
  >(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [readmeMd, setReadmeMd] = useState<string | null>(null);
  const [readmeLoading, setReadmeLoading] = useState(false);
  const [readmeError, setReadmeError] = useState<string | null>(null);

  useEffect(() => {
    if (!user?.id || !moduleId) return;

    setLoading(true);
    setError(null);

    fetch(
      `/api/modules/${encodeURIComponent(moduleId)}?userId=${encodeURIComponent(
        user.id,
      )}`,
    )
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(
            typeof body?.error === "string" && body.error
              ? body.error
              : "Failed to load module",
          );
        }
        const moduleDto = (body?.module ?? null) as ModuleDetailDto | null;
        setMod(moduleDto);

        // If this is a submodule, fetch its parent for breadcrumb display.
        const parentId = moduleDto?.isSubmodule ? moduleDto?.parentModuleId : null;
        if (parentId) {
          fetch(
            `/api/modules/${encodeURIComponent(parentId)}?userId=${encodeURIComponent(
              user.id,
            )}`,
          )
            .then(async (r) => {
              const b = await r.json().catch(() => ({}));
              if (!r.ok) return;
              const p = (b?.module ?? null) as
                | { id: string; effectiveName?: string }
                | null;
              if (p?.id) {
                setParentMod({
                  id: p.id,
                  effectiveName: p.effectiveName ?? "Parent Module",
                });
              }
            })
            .catch(() => {
              // ignore breadcrumb fetch errors
            });
        } else {
          setParentMod(null);
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load module"))
      .finally(() => setLoading(false));
  }, [user?.id, moduleId]);

  useEffect(() => {
    if (!mod?.source?.url || !mod.versionTag || !user?.id) return;

    // only fetch when README tab is open (keeps it snappy)
    if (tab !== "readme") return;

    const parsed = extractOwnerRepo(mod.source.url);
    if (!parsed) {
      setReadmeError("Unsupported repo URL.");
      return;
    }

    const { owner, repo } = parsed;

    setReadmeLoading(true);
    setReadmeError(null);

    // Try common README names in order.
    const candidates = ["README.md", "readme.md", "README.MD", "Readme.md"];

    (async () => {
      for (const path of candidates) {
        try {
          const res = await fetch(
            `/api/git-provider/github/repos/${encodeURIComponent(
              owner,
            )}/${encodeURIComponent(repo)}/contents?ref=${encodeURIComponent(
              mod.versionTag ?? "",
            )}&path=${encodeURIComponent(path)}`,
          );

          if (!res.ok) continue;
          const body: unknown = await res.json().catch(() => null);
          const content: unknown = (body as any)?.content;
          const encoding: unknown = (body as any)?.encoding;
          if (typeof content !== "string") continue;
          if (encoding !== "base64") continue;

          const decoded = atob(content.replace(/\n/g, ""));
          setReadmeMd(decoded);
          setReadmeLoading(false);
          return;
        } catch {
          // keep trying next candidate
        }
      }

      setReadmeMd(null);
      setReadmeError("README.md not found in repository.");
      setReadmeLoading(false);
    })();
  }, [mod?.source?.url, mod?.versionTag, tab, user?.id]);

  const title = mod?.effectiveName ?? "Module";

  const variablesRows = useMemo(() => {
    const vars = Array.isArray((mod as any)?.variables) ? ((mod as any).variables as any[]) : [];
    return vars.map((v) => ({
      name: String(v?.name ?? ""),
      description: (v?.description ?? null) as string | null,
      type: (v?.type ?? null) as string | null,
      default: v?.default,
      sensitive: v?.sensitive === true,
    }));
  }, [mod]);

  const outputsRows = useMemo(() => {
    const outs = Array.isArray((mod as any)?.outputs) ? ((mod as any).outputs as any[]) : [];
    return outs.map((o) => ({
      name: String(o?.name ?? ""),
      description: (o?.description ?? null) as string | null,
      sensitive: o?.sensitive === true,
    }));
  }, [mod]);

  if (!isAuthenticated) return null;

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-3">
            <SidebarTrigger />
            <div className="min-w-0">
              <div className="text-xs text-muted-foreground">
                <Link href="/modules" className="hover:underline">
                  Modules
                </Link>

                {mod?.isSubmodule && parentMod ? (
                  <>
                    <span className="mx-2">/</span>
                    <Link
                      href={`/modules/${encodeURIComponent(parentMod.id)}`}
                      className="hover:underline"
                    >
                      {parentMod.effectiveName}
                    </Link>
                    <span className="mx-2">/</span>
                    <span className="truncate">{title}</span>
                  </>
                ) : (
                  <>
                    <span className="mx-2">/</span>
                    <span className="truncate">{title}</span>
                  </>
                )}
              </div>
              <h1 className="text-lg font-semibold truncate">{title}</h1>
            </div>
          </div>
        </header>

        <main className="p-4 space-y-4">
          {loading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : error ? (
            <div className="text-sm text-destructive">{error}</div>
          ) : !mod ? (
            <div className="text-sm text-muted-foreground">Module not found.</div>
          ) : (
            <>
              {/* General info section (above tabs) */}
              <div className="space-y-4">
                <div className="space-y-1">
                  <div className="text-xs font-medium text-muted-foreground">
                    Description
                  </div>
                  <div className="text-sm leading-6 break-words">
                    {mod.effectiveDescription?.trim()
                      ? mod.effectiveDescription
                      : "No description provided."}
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="text-xs font-medium text-muted-foreground">Tags</div>
                  {mod.source?.tags?.length ? (
                    <div className="flex flex-wrap gap-2">
                      {mod.source.tags.map((t) => (
                        <span
                          key={t}
                          className="inline-flex items-center rounded-md border bg-muted/40 px-2 py-1 text-xs"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground">No tags.</div>
                  )}
                </div>

                <div className="space-y-1">
                  <div className="text-xs font-medium text-muted-foreground">Version</div>
                  {mod.url && mod.versionTag ? (
                    <a
                      className="text-sm underline break-all"
                      href={mod.url}
                      target="_blank"
                      rel="noreferrer"
                      title="Open repository at selected version"
                    >
                      {mod.versionTag}
                    </a>
                  ) : (
                    <div className="text-sm text-muted-foreground">
                      {mod.versionTag ? mod.versionTag : "(none)"}
                    </div>
                  )}
                </div>

                {mod.source?.url ? (
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-muted-foreground">Repository</div>
                    <a
                      className="text-sm underline break-all"
                      href={mod.source.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {mod.source.url}
                    </a>
                  </div>
                ) : null}
              </div>

              <div className="border-b flex items-center gap-1 overflow-x-auto">
                <TabButton active={tab === "readme"} onClick={() => setTab("readme")}>
                  README
                </TabButton>
                <TabButton
                  active={tab === "variables"}
                  onClick={() => setTab("variables")}
                >
                  Variables
                </TabButton>
                <TabButton
                  active={tab === "dependencies"}
                  onClick={() => setTab("dependencies")}
                >
                  Dependencies
                </TabButton>
                <TabButton
                  active={tab === "resources"}
                  onClick={() => setTab("resources")}
                >
                  Resources
                </TabButton>
                {!mod.isSubmodule ? (
                  <TabButton
                    active={tab === "submodules"}
                    onClick={() => setTab("submodules")}
                  >
                    Submodules
                  </TabButton>
                ) : null}
                <TabButton active={tab === "source"} onClick={() => setTab("source")}>
                  Source code
                </TabButton>
              </div>

              {tab === "readme" ? (
                <div className="space-y-3">
                  {readmeLoading ? (
                    <div className="text-sm text-muted-foreground">Loading README…</div>
                  ) : readmeError ? (
                    <div className="text-sm text-muted-foreground">{readmeError}</div>
                  ) : readmeMd ? (
                    <div className="rounded-md border bg-background p-3 md:p-4 overflow-hidden">
                      {/*
                        Keep README compact and always fit to screen:
                        - wrap long words/urls
                        - never allow content to force the page wider
                        - allow horizontal scroll only inside code blocks / tables
                      */}
                      <div data-readme-prose>
                        <article className="prose prose-sm max-w-none dark:prose-invert text-sm leading-6 break-words">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {readmeMd}
                          </ReactMarkdown>
                        </article>
                      </div>

                      <style jsx global>{`
                        /* Scope styles strictly to the README renderer */
                        [data-readme-prose] {
                          overflow-wrap: anywhere;
                          word-break: break-word;
                        }
                        [data-readme-prose] pre {
                          max-width: 100%;
                          overflow-x: auto;
                        }
                        [data-readme-prose] code {
                          word-break: break-word;
                          white-space: pre-wrap;
                        }
                        /* keep tables from blowing up the layout */
                        [data-readme-prose] table {
                          display: block;
                          max-width: 100%;
                          overflow-x: auto;
                        }
                        [data-readme-prose] img {
                          max-width: 100%;
                          height: auto;
                        }
                      `}</style>
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground">No README available.</div>
                  )}
                </div>
              ) : null}

              {tab === "variables" ? (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <Card>
                    <CardContent className="p-4">
                      <div className="text-sm font-medium">Inputs</div>
                      <div className="text-xs text-muted-foreground">
                        Terraform variables
                      </div>
                      <Separator className="my-3" />

                      {variablesRows.length === 0 ? (
                        <div className="text-sm text-muted-foreground">
                          No variables detected.
                        </div>
                      ) : (
                        <div className="space-y-3">
                          {variablesRows.map((v) => (
                            <div key={v.name} className="text-sm">
                              <div className="font-medium">{v.name}</div>
                              <div className="text-xs text-muted-foreground">
                                {v.description ?? ""}
                                {v.type ? ` · type: ${v.type}` : ""}
                                {v.sensitive ? " · sensitive" : ""}
                              </div>
                              {typeof v.default !== "undefined" ? (
                                <pre className="text-xs bg-muted p-2 rounded mt-1 overflow-auto">
                                  {JSON.stringify(v.default, null, 2)}
                                </pre>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  <Card>
                    <CardContent className="p-4">
                      <div className="text-sm font-medium">Outputs</div>
                      <div className="text-xs text-muted-foreground">
                        Terraform outputs
                      </div>
                      <Separator className="my-3" />

                      {outputsRows.length === 0 ? (
                        <div className="text-sm text-muted-foreground">
                          No outputs detected.
                        </div>
                      ) : (
                        <div className="space-y-3">
                          {outputsRows.map((o) => (
                            <div key={o.name} className="text-sm">
                              <div className="font-medium">{o.name}</div>
                              <div className="text-xs text-muted-foreground">
                                {o.description ?? ""}
                                {o.sensitive ? " · sensitive" : ""}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </div>
              ) : null}

              {tab === "dependencies" ? (
                <div className="space-y-2">
                  <div className="text-sm text-muted-foreground">
                    Dependency analysis isn’t persisted yet. Next step would be to store module calls
                    from the analyzer and show them here.
                  </div>
                </div>
              ) : null}

              {tab === "resources" ? (
                <div className="space-y-2">
                  {mod.resources?.length ? (
                    <div className="space-y-2">
                      {mod.resources.map((r) => (
                        <div key={r.id} className="text-sm">
                          <div className="font-medium">
                            {r.providerName} · {r.resourceType}
                            {r.resourceName ? `.${r.resourceName}` : ""}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground">No resources detected.</div>
                  )}
                </div>
              ) : null}

              {tab === "submodules" && !mod.isSubmodule ? (
                <div className="space-y-2">
                  {(mod.submodules?.length ?? 0) === 0 ? (
                    <div className="text-sm text-muted-foreground">No submodules imported.</div>
                  ) : (
                    <div className="space-y-2">
                      {mod.submodules?.map((s) => (
                        <Link
                          key={s.id}
                          href={`/modules/${encodeURIComponent(s.id)}`}
                          className="block rounded px-2 py-2 hover:bg-muted"
                        >
                          <div className="text-sm font-medium">
                            {s.submoduleName ?? "(unnamed)"}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            folder: {s.terraformRootFolder ?? "."}
                          </div>
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}

              {tab === "source" ? (
                <div className="space-y-2">
                  <div className="text-sm text-muted-foreground">
                    Opens the source repository (root module).
                  </div>

                  {mod.source?.url ? (
                    <a
                      className="text-sm underline"
                      href={mod.source.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open repo root
                    </a>
                  ) : null}

                  {mod.url ? (
                    <div className="text-sm">
                      <a
                        className="underline"
                        href={mod.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open repo at selected ref
                      </a>
                    </div>
                  ) : null}

                  {mod.terraformRootFolder ? (
                    <div className="text-xs text-muted-foreground">
                      Imported folder: {mod.terraformRootFolder}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
