"use client";

import { useAuth } from "@terrablox/auth/hooks";
import type {
  GitBranch,
  GitProviderId,
  GitRelease,
  GitRepo,
  GitTag,
} from "@terrablox/git-import";
import { Button } from "@terrablox/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@terrablox/ui/dialog";
import { Input } from "@terrablox/ui/input";
import { Label } from "@terrablox/ui/label";
import { Github, Loader2, Search } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { MultiRepoFolderPicker } from "@/components/multi-repo-folder-picker";
import { FolderPicker } from "@/components/repo-folder-picker";
import { TagsInput } from "@/components/tags-input";
import {
  type CompanySettingsDto,
  findSubmoduleFolders,
} from "@/lib/company-settings";

interface ImportModuleDialogProps {
  provider: GitProviderId;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Fired once the import request succeeded, before the dialog closes. The
   * module already exists in the database at this point, so a caller can
   * refetch immediately.
   */
  onImported?: () => void;
}

type Step = 1 | 2 | 3 | 4;

type RefChoice =
  | { type: "release"; name: string }
  | { type: "tag"; name: string }
  | { type: "branch"; name: string };

function Stepper({ current }: { current: Step }) {
  const items: Array<{ step: Step; label: string }> = [
    { step: 1, label: "Repository" },
    { step: 2, label: "Version" },
    { step: 3, label: "Description" },
    { step: 4, label: "Terraform" },
  ];

  return (
    <ol
      className="mx-auto flex w-full max-w-[520px] items-center justify-center gap-3"
      aria-label="Import steps"
    >
      {items.map((item) => {
        const completed = item.step < current;
        const active = item.step === current;

        return (
          <li key={item.step} className="flex items-center gap-2">
            <span
              className={`h-2.5 w-2.5 rounded-full ${
                active
                  ? "bg-primary"
                  : completed
                    ? "bg-foreground/70"
                    : "bg-muted-foreground/30"
              }`}
              aria-hidden="true"
            />
            <span
              className={`text-xs font-medium ${
                active
                  ? "text-foreground"
                  : completed
                    ? "text-muted-foreground"
                    : "text-muted-foreground"
              }`}
            >
              {item.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function ImportModuleDialog({
  provider,
  open,
  onOpenChange,
  onImported,
}: ImportModuleDialogProps) {
  const { user } = useAuth();

  const [step, setStep] = useState<Step>(1);

  // Step 1
  const [repos, setRepos] = useState<GitRepo[]>([]);
  const [reposLoading, setReposLoading] = useState(true);
  const [reposError, setReposError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedRepo, setSelectedRepo] = useState<GitRepo | null>(null);

  // Step 2
  const [releases, setReleases] = useState<GitRelease[]>([]);
  // Git tags of the repository. Distinct from the user-defined metadata `tags`
  // in step 3, which have nothing to do with git.
  const [gitTags, setGitTags] = useState<GitTag[]>([]);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [refLoading, setRefLoading] = useState(false);
  const [refError, setRefError] = useState<string | null>(null);
  const [refChoice, setRefChoice] = useState<RefChoice | null>(null);
  const [refTab, setRefTab] = useState<"release" | "tag" | "branch">("release");
  // Which repo the current ref lists belong to. The fetch effect is keyed on
  // `step`, so without this it re-runs on every Back and wipes the user's
  // choice — painful with hundreds of tags.
  const loadedRefsForRepo = useRef<string | null>(null);

  // Step 3
  const [moduleName, setModuleName] = useState("");
  const [moduleDescription, setModuleDescription] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Step 4
  const [terraformRootFolder, setTerraformRootFolder] = useState(".");
  const [terraformSubmodulesFolders, setTerraformSubmodulesFolders] = useState<
    string[]
  >([]);

  // Company-wide conventions. Null while unknown so nothing is applied early.
  const [companySettings, setCompanySettings] =
    useState<CompanySettingsDto | null>(null);
  const [discovery, setDiscovery] = useState<{
    status: "idle" | "loading" | "done" | "error";
    folders: string[];
    message?: string;
  }>({ status: "idle", folders: [] });
  // Auto-discovery must apply once per repo+ref, otherwise stepping back and
  // forth would resurrect submodules the user deliberately removed.
  const appliedDiscoveryFor = useRef<string | null>(null);
  const appliedCompanyRoot = useRef(false);

  // Reset the wizard on open/close.
  useEffect(() => {
    if (open) {
      setStep(1);
      setSearchQuery("");
      setSelectedRepo(null);
      setRefChoice(null);
      loadedRefsForRepo.current = null;
      setModuleName("");
      setModuleDescription("");
      setTags([]);
      setTagSuggestions([]);
      setSaveError(null);
      setRefError(null);
      setTerraformRootFolder(".");
      setTerraformSubmodulesFolders([]);
      setDiscovery({ status: "idle", folders: [] });
      appliedDiscoveryFor.current = null;
      appliedCompanyRoot.current = false;
    }
  }, [open]);

  // Prefill description from repo when chosen.
  useEffect(() => {
    if (!selectedRepo) return;
    setModuleDescription(selectedRepo.description ?? "");
  }, [selectedRepo]);

  // Load tag suggestions for the signed-in user.
  useEffect(() => {
    if (!open) return;

    async function fetchTags() {
      try {
        const res = await fetch("/api/tags");
        const body = await res.json();
        if (!res.ok) return;
        setTagSuggestions((body?.tags ?? []) as string[]);
      } catch {
        // Non-blocking.
      }
    }

    fetchTags();
  }, [open]);

  // Load company conventions once per opening.
  useEffect(() => {
    if (!open) return;

    let cancelled = false;

    fetch("/api/company-settings")
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (cancelled) return;
        setCompanySettings(
          (body?.settings as CompanySettingsDto | undefined) ?? null,
        );
      })
      .catch(() => {
        // Conventions are a convenience; the wizard stays fully usable without.
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  // Apply the company's default root folder, but only before the user reaches
  // the folder step so it never overwrites a deliberate choice.
  useEffect(() => {
    if (!open || appliedCompanyRoot.current) return;

    const root = companySettings?.terraformRootFolder;
    if (!root) return;

    appliedCompanyRoot.current = true;
    if (step < 4) {
      setTerraformRootFolder(root);
    }
  }, [open, companySettings, step]);

  // Step 1: fetch repos
  useEffect(() => {
    if (!open) return;

    async function fetchRepos() {
      setReposLoading(true);
      setReposError(null);

      const identity = user?.identities?.find((id) => id.provider === provider);
      if (!identity) {
        setReposError(
          `Your ${provider} account isn’t linked yet. Link it in Account Settings to import repositories.`,
        );
        setReposLoading(false);
        return;
      }

      try {
        const response = await fetch(`/api/git-provider/${provider}/repos`);
        const body = await response.json();

        if (!response.ok) {
          const scopes = body?.scopes ? ` (scopes: ${body.scopes})` : "";
          setReposError(
            body?.error
              ? `${body.error}${scopes}`
              : "Failed to fetch repositories.",
          );
          return;
        }

        setRepos(body.repos ?? []);
      } catch (err) {
        setReposError(
          err instanceof Error ? err.message : "An unknown error occurred.",
        );
      } finally {
        setReposLoading(false);
      }
    }

    fetchRepos();
  }, [open, provider, user]);

  const filteredRepos = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return repos;
    return repos.filter((repo) => repo.full_name.toLowerCase().includes(q));
  }, [repos, searchQuery]);

  // Step 2: fetch refs when repo selected
  useEffect(() => {
    if (!open) return;
    if (step !== 2) return;
    if (!selectedRepo) return;

    const repoToLoad = selectedRepo;

    // Already loaded for this repo (e.g. the user navigated back) — keep the
    // lists and the current selection instead of refetching and resetting.
    if (loadedRefsForRepo.current === repoToLoad.full_name) return;

    async function fetchRefs() {
      setRefLoading(true);
      setRefError(null);
      setReleases([]);
      setGitTags([]);
      setBranches([]);
      setRefChoice(null);

      try {
        const [owner, repo] = repoToLoad.full_name.split("/");
        if (!owner || !repo) {
          throw new Error("Invalid repository name.");
        }

        const base = `/api/git-provider/${provider}/repos/${owner}/${repo}`;

        const [releasesRes, tagsRes, branchesRes] = await Promise.all([
          fetch(`${base}/releases`),
          fetch(`${base}/tags`),
          fetch(`${base}/branches`),
        ]);

        const [releasesBody, tagsBody, branchesBody] = await Promise.all([
          releasesRes.json(),
          tagsRes.json(),
          branchesRes.json(),
        ]);

        if (!releasesRes.ok) {
          const scopes = releasesBody?.scopes
            ? ` (scopes: ${releasesBody.scopes})`
            : "";
          throw new Error(
            releasesBody?.error
              ? `${releasesBody.error}${scopes}`
              : "Failed to fetch releases.",
          );
        }

        if (!tagsRes.ok) {
          const scopes = tagsBody?.scopes
            ? ` (scopes: ${tagsBody.scopes})`
            : "";
          throw new Error(
            tagsBody?.error
              ? `${tagsBody.error}${scopes}`
              : "Failed to fetch tags.",
          );
        }

        if (!branchesRes.ok) {
          const scopes = branchesBody?.scopes
            ? ` (scopes: ${branchesBody.scopes})`
            : "";
          throw new Error(
            branchesBody?.error
              ? `${branchesBody.error}${scopes}`
              : "Failed to fetch branches.",
          );
        }

        const rels = (releasesBody?.releases ?? []) as GitRelease[];
        const tgs = (tagsBody?.tags ?? []) as GitTag[];
        const brs = (branchesBody?.branches ?? []) as GitBranch[];

        setReleases(rels);
        setGitTags(tgs);
        setBranches(brs);
        loadedRefsForRepo.current = repoToLoad.full_name;

        // Pick a sensible default so users can "Continue" quickly.
        if (rels.length > 0 && rels[0]) {
          setRefTab("release");
          setRefChoice({ type: "release", name: rels[0].tag_name });
        } else if (tgs.length > 0 && tgs[0]) {
          setRefTab("tag");
          setRefChoice({ type: "tag", name: tgs[0].name });
        } else if (brs.length > 0 && brs[0]) {
          setRefTab("branch");
          setRefChoice({ type: "branch", name: brs[0].name });
        }
      } catch (err) {
        loadedRefsForRepo.current = null;
        setRefError(
          err instanceof Error ? err.message : "Failed to load versions.",
        );
      } finally {
        setRefLoading(false);
      }
    }

    fetchRefs();
  }, [open, provider, selectedRepo, step]);

  const canContinue =
    (step === 1 && !!selectedRepo) ||
    (step === 2 && !!refChoice) ||
    step === 3 ||
    step === 4;

  // We no longer render step meta title/description in the header.
  // const stepMeta = STEP_META[step];

  async function onFinish() {
    // If the exact version is already imported, this dialog is effectively a viewer.
    if (existingImport) {
      onOpenChange(false);
      return;
    }

    if (!user?.id) {
      setSaveError("You must be signed in.");
      return;
    }
    if (!selectedRepo) {
      setSaveError("Choose a repository first.");
      return;
    }
    if (!refChoice) {
      setSaveError("Choose a release, tag or branch first.");
      return;
    }

    setSaving(true);
    setSaveError(null);

    try {
      const res = await fetch("/api/modules/import-from-git", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: user.id,
          repoFullName: selectedRepo.full_name,
          refType: refChoice.type,
          refName: refChoice.name,
          terraformRootFolder,
          terraformSubmodulesFolders,
          nameOverride: moduleName,
          description: moduleDescription,
          tags,
        }),
      });

      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(
          typeof body?.error === "string" && body.error
            ? body.error
            : "Failed to create module.",
        );
      }

      onImported?.();
      onOpenChange(false);
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : "Failed to create module.",
      );
    } finally {
      setSaving(false);
    }
  }

  const [existingImport, setExistingImport] = useState<{
    source: {
      name: string;
      description: string | null;
      tags: string[];
      url: string;
    };
    module: {
      id: string;
      versionTag: string | null;
      terraformRootFolder: string | null;
      terraformSubmodulesFolders: string[];
      url: string | null;
    };
  } | null>(null);
  const [existingImportLoading, setExistingImportLoading] = useState(false);

  const [repoImportedInfo, setRepoImportedInfo] = useState<{
    source: {
      name: string;
      description: string | null;
      tags: string[];
      url: string;
    };
    importedVersions: string[];
  } | null>(null);
  const [repoImportedLoading, setRepoImportedLoading] = useState(false);

  const importedVersionSet = useMemo(() => {
    return new Set(
      (repoImportedInfo?.importedVersions ?? []).map((v) => v.trim()),
    );
  }, [repoImportedInfo?.importedVersions]);

  const lockRepoProvidedFields = !!repoImportedInfo;
  // When a repo already has a module_source, we don't allow changing terraform paths/folders.
  // For already-imported versions we display the stored folders from the DB via lookup-import.
  const lockTerraformFields = !!repoImportedInfo;

  const companyDiscoveryHint = useMemo(() => {
    const path = companySettings?.terraformSubmodulesPath;
    if (!path || lockTerraformFields) return undefined;

    if (discovery.status === "loading") {
      return `Looking for submodules in ${path}/ …`;
    }
    if (discovery.status === "error") {
      return `Could not apply the company convention: ${discovery.message}`;
    }
    if (discovery.status === "done") {
      return discovery.folders.length > 0
        ? `Pre-selected ${discovery.folders.length} submodule${
            discovery.folders.length === 1 ? "" : "s"
          } found in ${path}/ (company setting).`
        : `No submodules found in ${path}/ (company setting).`;
    }

    return undefined;
  }, [
    companySettings?.terraformSubmodulesPath,
    discovery,
    lockTerraformFields,
  ]);

  // When repo is selected, check whether it was imported before and which versions exist.
  useEffect(() => {
    if (!open) return;
    if (!user?.id) return;
    if (!selectedRepo) {
      setRepoImportedInfo(null);
      return;
    }

    setRepoImportedLoading(true);
    fetch(
      `/api/modules/imported-versions?userId=${encodeURIComponent(
        user.id,
      )}&repoFullName=${encodeURIComponent(selectedRepo.full_name)}`,
    )
      .then(async (res) => {
        const b = (await res.json().catch(() => null)) as any;
        if (!res.ok) {
          setRepoImportedInfo(null);
          return;
        }

        if (
          b?.repoImported &&
          b?.source &&
          Array.isArray(b?.importedVersions)
        ) {
          setRepoImportedInfo({
            source: b.source,
            importedVersions: b.importedVersions,
          });
          // Populate fields from the source; these are stored on terraform_module_sources.
          setModuleName(String(b.source?.name ?? moduleName));
          setModuleDescription(String(b.source?.description ?? ""));
          setTags(Array.isArray(b.source?.tags) ? b.source.tags : []);
        } else {
          setRepoImportedInfo(null);
        }
      })
      .catch(() => setRepoImportedInfo(null))
      .finally(() => setRepoImportedLoading(false));
  }, [open, user?.id, selectedRepo?.full_name]);

  // When repo + ref are chosen, check whether the root module is already imported.
  useEffect(() => {
    if (!open) return;
    if (!user?.id) return;
    if (!selectedRepo || !refChoice) {
      setExistingImport(null);
      return;
    }

    setExistingImportLoading(true);

    fetch(
      `/api/modules/lookup-import?userId=${encodeURIComponent(
        user.id,
      )}&repoFullName=${encodeURIComponent(
        selectedRepo.full_name,
      )}&refName=${encodeURIComponent(refChoice.name)}&terraformRootFolder=${encodeURIComponent(
        terraformRootFolder || ".",
      )}`,
    )
      .then(async (res) => {
        const b = (await res.json().catch(() => null)) as any;
        if (!res.ok) {
          setExistingImport(null);
          return;
        }
        if (b?.exists && b?.source && b?.module) {
          setExistingImport({ source: b.source, module: b.module });
          // Populate existing values so the user sees what's in DB.
          setModuleName(String(b.source?.name ?? moduleName));
          setModuleDescription(String(b.source?.description ?? ""));
          setTags(Array.isArray(b.source?.tags) ? b.source.tags : []);
          setTerraformRootFolder(
            String(b.module?.terraformRootFolder ?? terraformRootFolder ?? "."),
          );
          setTerraformSubmodulesFolders(
            Array.isArray(b.module?.terraformSubmodulesFolders)
              ? b.module.terraformSubmodulesFolders
              : [],
          );
        } else {
          setExistingImport(null);
        }
      })
      .catch(() => setExistingImport(null))
      .finally(() => setExistingImportLoading(false));
    // We intentionally include terraformRootFolder: if the user changes it, we re-check.
  }, [
    open,
    user?.id,
    selectedRepo?.full_name,
    refChoice?.name,
    terraformRootFolder,
  ]);

  // Pre-select submodules using the company convention. Stored values from a
  // previous import always win, so this waits for both lookups to settle.
  useEffect(() => {
    const submodulesPath = companySettings?.terraformSubmodulesPath;
    const repoFullName = selectedRepo?.full_name;
    const refName = refChoice?.name;
    if (!open || !repoFullName || !refName || !submodulesPath) return;
    if (existingImportLoading || repoImportedLoading) return;
    if (existingImport || repoImportedInfo) return;

    const key = `${repoFullName}@${refName}@${submodulesPath}`;
    if (appliedDiscoveryFor.current === key) return;
    appliedDiscoveryFor.current = key;

    // The response is matched against the ref rather than an effect-scoped
    // flag: unrelated dependencies (the import lookups) settle while the tree
    // is in flight, and cancelling on every re-run would strand the request.
    const isCurrent = () => appliedDiscoveryFor.current === key;
    setDiscovery({ status: "loading", folders: [] });

    const [owner, repo] = repoFullName.split("/");
    fetch(
      `/api/git-provider/github/repos/${owner}/${repo}/tree?ref=${encodeURIComponent(
        refName,
      )}`,
    )
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as {
          entries?: Array<{ path: string; type: string }>;
          error?: string;
        } | null;

        if (!isCurrent()) return;

        if (!res.ok) {
          setDiscovery({
            status: "error",
            folders: [],
            message: body?.error ?? "Could not read the repository tree.",
          });
          return;
        }

        const folders = findSubmoduleFolders(
          (body?.entries ?? [])
            .filter((entry) => entry.type === "blob")
            .map((entry) => entry.path),
          submodulesPath,
        );

        setDiscovery({ status: "done", folders });
        if (folders.length > 0) {
          setTerraformSubmodulesFolders(folders);
        }
      })
      .catch((e: unknown) => {
        if (!isCurrent()) return;
        setDiscovery({
          status: "error",
          folders: [],
          message:
            e instanceof Error ? e.message : "Could not read the repository.",
        });
      });
  }, [
    open,
    selectedRepo?.full_name,
    refChoice?.name,
    companySettings?.terraformSubmodulesPath,
    existingImport,
    existingImportLoading,
    repoImportedInfo,
    repoImportedLoading,
  ]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[760px]">
        <DialogHeader className="space-y-3">
          <DialogTitle className="flex items-center justify-center gap-2 text-center">
            <Github className="h-5 w-5" />
            Import from GitHub
          </DialogTitle>
          <DialogDescription>
            <div className="space-y-2">
              <Stepper current={step} />
            </div>
          </DialogDescription>
        </DialogHeader>

        {existingImport && (step === 3 || step === 4) ? (
          <div className="rounded-md border bg-muted/30 p-3 text-sm">
            This module is already imported for this version. The fields below
            are read-only and show what’s stored in the database.
          </div>
        ) : null}

        {step === 1 ? (
          <>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search repositories…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10"
                aria-label="Search repositories"
              />
            </div>

            <div className="space-y-2 h-[320px] overflow-y-auto pr-2">
              {reposLoading ? (
                <div className="flex items-center justify-center h-full">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : reposError ? (
                <div className="flex flex-col items-center justify-center h-full text-center">
                  <p className="text-sm text-destructive">{reposError}</p>
                  <Button asChild variant="link" className="mt-2">
                    <Link href="/account">Open Account Settings</Link>
                  </Button>
                </div>
              ) : filteredRepos.length > 0 ? (
                filteredRepos.map((repo) => {
                  const selected = selectedRepo?.full_name === repo.full_name;
                  return (
                    <button
                      type="button"
                      key={repo.id}
                      onClick={() => {
                        setSelectedRepo(repo);
                        setModuleName(repo.name);
                        setStep(2);
                      }}
                      className={`group w-full text-left rounded-md border p-3 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                        selected ? "border-primary" : "border-transparent"
                      }`}
                      aria-pressed={selected}
                    >
                      <div className="min-w-0">
                        <div className="font-medium truncate">
                          {repo.full_name}
                        </div>
                        {repo.description ? (
                          <div className="text-sm text-muted-foreground line-clamp-2">
                            {repo.description}
                          </div>
                        ) : (
                          <div className="text-sm text-muted-foreground">
                            No description
                          </div>
                        )}
                      </div>
                    </button>
                  );
                })
              ) : (
                <div className="flex flex-col items-center justify-center h-full text-center">
                  <p className="text-sm text-muted-foreground">
                    No repositories found.
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Try a different search term, or check organization access in
                    your GitHub connection.
                  </p>
                </div>
              )}
            </div>
          </>
        ) : null}

        {step === 2 ? (
          <div className="space-y-4">
            {repoImportedInfo ? (
              <div className="rounded-md border bg-muted/20 p-3 text-sm text-muted-foreground">
                This repository was imported before. Versions already imported
                are disabled.
              </div>
            ) : null}

            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant={refTab === "release" ? "default" : "outline"}
                size="sm"
                onClick={() => setRefTab("release")}
              >
                Releases ({releases.length})
              </Button>
              <Button
                type="button"
                variant={refTab === "tag" ? "default" : "outline"}
                size="sm"
                onClick={() => setRefTab("tag")}
              >
                Tags ({gitTags.length})
              </Button>
              <Button
                type="button"
                variant={refTab === "branch" ? "default" : "outline"}
                size="sm"
                onClick={() => setRefTab("branch")}
              >
                Branches ({branches.length})
              </Button>
            </div>

            {refLoading ? (
              <div className="flex items-center justify-center h-[260px]">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : refError ? (
              <div className="text-sm text-destructive">{refError}</div>
            ) : refTab === "release" ? (
              <div className="space-y-2 h-[260px] overflow-y-auto pr-2">
                {releases.length === 0 ? (
                  <div className="rounded-md border p-3 text-sm text-muted-foreground">
                    No releases found for this repository. Switch to Branches to
                    pick a branch instead.
                  </div>
                ) : (
                  releases.map((r) => {
                    const selected =
                      refChoice?.type === "release" &&
                      refChoice.name === r.tag_name;

                    const alreadyImported = importedVersionSet.has(r.tag_name);

                    return (
                      <button
                        type="button"
                        key={r.id}
                        className={`w-full text-left rounded-md border p-3 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                          selected ? "border-primary" : "border-transparent"
                        } ${alreadyImported ? "opacity-60 cursor-not-allowed" : ""}`}
                        onClick={() => {
                          if (alreadyImported) return;
                          setRefChoice({ type: "release", name: r.tag_name });
                          setStep(3);
                        }}
                        aria-pressed={selected}
                        aria-disabled={alreadyImported}
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <div className="font-medium">{r.tag_name}</div>
                            {alreadyImported ? (
                              <span className="text-[11px] rounded border px-2 py-0.5 text-muted-foreground">
                                Already imported
                              </span>
                            ) : null}
                          </div>
                          <div className="text-xs text-muted-foreground truncate">
                            {r.name || "Release"}
                          </div>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            ) : refTab === "tag" ? (
              <div className="space-y-2 h-[260px] overflow-y-auto pr-2">
                {gitTags.length === 0 ? (
                  <div className="rounded-md border p-3 text-sm text-muted-foreground">
                    No tags found for this repository.
                  </div>
                ) : (
                  gitTags.map((t) => {
                    const selected =
                      refChoice?.type === "tag" && refChoice.name === t.name;

                    const alreadyImported = importedVersionSet.has(t.name);

                    return (
                      <button
                        type="button"
                        key={t.name}
                        className={`w-full text-left rounded-md border p-3 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                          selected ? "border-primary" : "border-transparent"
                        } ${alreadyImported ? "opacity-60 cursor-not-allowed" : ""}`}
                        onClick={() => {
                          if (alreadyImported) return;
                          setRefChoice({ type: "tag", name: t.name });
                          setStep(3);
                        }}
                        aria-pressed={selected}
                        aria-disabled={alreadyImported}
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <div className="font-medium">{t.name}</div>
                            {alreadyImported ? (
                              <span className="text-[11px] rounded border px-2 py-0.5 text-muted-foreground">
                                Already imported
                              </span>
                            ) : null}
                          </div>
                          {t.commitSha ? (
                            <div className="text-xs text-muted-foreground">
                              {t.commitSha.slice(0, 7)}
                            </div>
                          ) : null}
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            ) : (
              <div className="space-y-2 h-[260px] overflow-y-auto pr-2">
                {branches.length === 0 ? (
                  <div className="rounded-md border p-3 text-sm text-muted-foreground">
                    No branches found.
                  </div>
                ) : (
                  branches.map((b) => {
                    const selected =
                      refChoice?.type === "branch" && refChoice.name === b.name;

                    const alreadyImported = importedVersionSet.has(b.name);

                    return (
                      <button
                        type="button"
                        key={b.name}
                        className={`w-full text-left rounded-md border p-3 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                          selected ? "border-primary" : "border-transparent"
                        } ${alreadyImported ? "opacity-60 cursor-not-allowed" : ""}`}
                        onClick={() => {
                          if (alreadyImported) return;
                          setRefChoice({ type: "branch", name: b.name });
                          setStep(3);
                        }}
                        aria-pressed={selected}
                        aria-disabled={alreadyImported}
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <div className="font-medium">{b.name}</div>
                            {alreadyImported ? (
                              <span className="text-[11px] rounded border px-2 py-0.5 text-muted-foreground">
                                Already imported
                              </span>
                            ) : null}
                          </div>
                          {b.commitSha ? (
                            <div className="text-xs text-muted-foreground">
                              {b.commitSha.slice(0, 7)}
                            </div>
                          ) : (
                            <div className="text-xs text-muted-foreground">
                              {" "}
                            </div>
                          )}
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </div>
        ) : null}

        {step === 3 ? (
          <div className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="moduleName">Module name</Label>
              <Input
                id="moduleName"
                value={moduleName}
                onChange={(e) => setModuleName(e.target.value)}
                placeholder="What is the name of your module?"
                disabled={lockRepoProvidedFields}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="moduleDescription">Description</Label>
              <Input
                id="moduleDescription"
                value={moduleDescription}
                onChange={(e) => setModuleDescription(e.target.value)}
                placeholder="What does this module do?"
                disabled={lockRepoProvidedFields}
              />
            </div>

            <TagsInput
              label="Tags"
              value={tags}
              onChange={setTags}
              suggestions={tagSuggestions}
              disabled={lockRepoProvidedFields}
            />

            {saveError ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                {saveError}
              </div>
            ) : null}
          </div>
        ) : null}

        {step === 4 ? (
          <div className="space-y-5">
            {selectedRepo && refChoice ? (
              <FolderPicker
                label="Terraform root path"
                value={terraformRootFolder}
                onChange={setTerraformRootFolder}
                provider="github"
                repoFullName={selectedRepo.full_name}
                refName={refChoice.name}
                disabled={lockTerraformFields}
              />
            ) : (
              <div className="space-y-2">
                <Label htmlFor="terraformRoot">Terraform root path</Label>
                <Input
                  id="terraformRoot"
                  value={terraformRootFolder}
                  onChange={(e) => setTerraformRootFolder(e.target.value)}
                  placeholder="e.g. . or modules/vpc"
                  disabled={lockTerraformFields}
                />
              </div>
            )}

            {selectedRepo && refChoice ? (
              <MultiRepoFolderPicker
                label="Terraform submodule folders"
                value={terraformSubmodulesFolders}
                onChange={(next) => {
                  // Any manual edit ends auto-discovery for this repo+ref.
                  appliedDiscoveryFor.current = "manual";
                  setTerraformSubmodulesFolders(next);
                }}
                provider="github"
                repoFullName={selectedRepo.full_name}
                refName={refChoice.name}
                disabled={lockTerraformFields}
                {...(companyDiscoveryHint
                  ? { description: companyDiscoveryHint }
                  : {})}
              />
            ) : null}

            {saveError ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                {saveError}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="flex items-center justify-between border-t pt-4">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              if (saving) return;
              if (step === 1) {
                onOpenChange(false);
              } else {
                setStep((s) => {
                  if (s === 2) return 1;
                  if (s === 3) return 2;
                  return 3;
                });
              }
            }}
          >
            {step === 1 ? "Cancel" : "Back"}
          </Button>

          <div className="flex items-center gap-2">
            {step < 4 ? (
              <Button
                type="button"
                onClick={() => {
                  if (step === 1 && selectedRepo) setStep(2);
                  if (step === 2 && refChoice) setStep(3);
                  if (step === 3) setStep(4);
                }}
                disabled={
                  !canContinue ||
                  saving ||
                  existingImportLoading ||
                  repoImportedLoading
                }
              >
                Continue
              </Button>
            ) : (
              <Button type="button" onClick={onFinish} disabled={saving}>
                {saving ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Importing…
                  </>
                ) : existingImport ? (
                  "Close"
                ) : (
                  "Import module"
                )}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
