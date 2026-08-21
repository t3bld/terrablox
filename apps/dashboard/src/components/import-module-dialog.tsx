"use client";

import { useAuth } from "@terrablox/auth/hooks";
import type {
  GitBranch,
  GitProviderId,
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
import { IconChoice, type RepoIconState } from "@/components/icon-picker";
import { TagsInput } from "@/components/tags-input";
import {
  findRepoIconPath,
  type IconChoiceValue,
  isIconMode,
} from "@/lib/modules/icon";

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

type Step = 1 | 2 | 3;

type RefChoice = { type: "branch" | "tag"; name: string };

type ImportedSource = {
  name: string;
  description: string | null;
  tags: string[];
  url: string;
  /** Stored icon choice. Absent on responses written before it existed. */
  iconMode?: string | null;
  iconName?: string | null;
  hasIcon?: boolean;
};

type ImportedModule = {
  id: string;
  versionTag: string | null;
  terraformRootFolder: string | null;
  terraformSubmodulesFolders: string[];
  url: string | null;
};

type ImportedVersionsResponse = {
  repoImported?: boolean;
  /** The repository is part of the catalogue TerraBlox ships with. */
  isBuiltin?: boolean;
  source?: ImportedSource;
  importedVersions?: string[];
};

type LookupImportResponse = {
  exists?: boolean;
  isBuiltin?: boolean;
  source?: ImportedSource;
  module?: ImportedModule;
};

function Stepper({ current }: { current: Step }) {
  const items: Array<{ step: Step; label: string }> = [
    { step: 1, label: "Repository" },
    { step: 2, label: "Version" },
    { step: 3, label: "Details" },
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

  // What is already in the database for this repo. Declared ahead of the ref
  // lists because the step-2 default selection has to skip versions that are
  // imported already.
  const [existingImport, setExistingImport] = useState<{
    source: ImportedSource;
    module: ImportedModule;
  } | null>(null);
  const [existingImportLoading, setExistingImportLoading] = useState(false);

  const [repoImportedInfo, setRepoImportedInfo] = useState<{
    source: ImportedSource;
    importedVersions: string[];
    isBuiltin: boolean;
  } | null>(null);
  const [repoImportedLoading, setRepoImportedLoading] = useState(false);

  const importedVersionSet = useMemo(() => {
    return new Set(
      (repoImportedInfo?.importedVersions ?? []).map((v) => v.trim()),
    );
  }, [repoImportedInfo?.importedVersions]);

  // Step 2
  // Git tags of the repository. Distinct from the user-defined metadata `tags`
  // in step 3, which have nothing to do with git.
  const [gitTags, setGitTags] = useState<GitTag[]>([]);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [refLoading, setRefLoading] = useState(false);
  const [refError, setRefError] = useState<string | null>(null);
  // Several refs can be imported in one go, so the selection is a list. The
  // order is the order they were picked, which is also the import order.
  const [refChoices, setRefChoices] = useState<RefChoice[]>([]);
  const [refTab, setRefTab] = useState<"branch" | "tag">("branch");
  // Which repo the current ref lists belong to. The fetch effect is keyed on
  // `step`, so without this it re-runs on every Back and wipes the user's
  // choice — painful with hundreds of tags.
  const loadedRefsForRepo = useRef<string | null>(null);
  // Some lookups only make sense for a single ref (does this exact version
  // already exist, which tree holds the icon). The first pick stands in for the
  // whole selection there.
  const primaryRef = refChoices[0] ?? null;

  // Step 3
  const [moduleName, setModuleName] = useState("");
  const [moduleDescription, setModuleDescription] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([]);
  const [icon, setIcon] = useState<IconChoiceValue>({
    mode: "repo",
    iconName: null,
  });
  const [repoIcon, setRepoIcon] = useState<RepoIconState>({
    status: "unknown",
  });
  // Set once the choice came out of the database, which stops the fallback below
  // from rewriting a stored `repo` into `none` just because the file has since
  // been deleted upstream. The control is read-only in that case and has to show
  // what is stored, not what we would pick today.
  const iconFromStore = useRef(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // How many refs finished, so a multi-ref import can report progress instead of
  // looking stuck for as long as it takes GitHub to answer.
  const [savedRefCount, setSavedRefCount] = useState(0);

  // Reset the wizard on open/close.
  useEffect(() => {
    if (open) {
      setStep(1);
      setSearchQuery("");
      setSelectedRepo(null);
      setRefChoices([]);
      loadedRefsForRepo.current = null;
      setModuleName("");
      setModuleDescription("");
      setTags([]);
      setTagSuggestions([]);
      setIcon({ mode: "repo", iconName: null });
      setRepoIcon({ status: "unknown" });
      iconFromStore.current = false;
      setSaveError(null);
      setSavedRefCount(0);
      setRefError(null);
    }
  }, [open]);

  // Prefill description from repo when chosen. The text belongs to the
  // repository itself, not to any one ref, which is why it is seeded here once
  // and not re-read for each selected branch or tag. An empty repository
  // description stays empty rather than being invented.
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

    // Without this, a slow response for a previously selected repo would land
    // after the user switched repos and mark its refs as loaded — offering
    // versions that belong to a different repository.
    const controller = new AbortController();

    async function fetchRefs() {
      setRefLoading(true);
      setRefError(null);
      setGitTags([]);
      setBranches([]);
      setRefChoices([]);

      try {
        const [owner, repo] = repoToLoad.full_name.split("/");
        if (!owner || !repo) {
          throw new Error("Invalid repository name.");
        }

        const base = `/api/git-provider/${provider}/repos/${encodeURIComponent(
          owner,
        )}/${encodeURIComponent(repo)}`;

        const read = async (resource: string) => {
          const res = await fetch(`${base}/${resource}`, {
            signal: controller.signal,
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) {
            throw new Error(body?.error ?? `Failed to fetch ${resource}.`);
          }
          return body;
        };

        const [tagsBody, branchesBody] = await Promise.all([
          read("tags"),
          read("branches"),
        ]);

        const tgs = (tagsBody?.tags ?? []) as GitTag[];
        const brs = (branchesBody?.branches ?? []) as GitBranch[];

        if (controller.signal.aborted) return;

        setGitTags(tgs);
        setBranches(brs);
        loadedRefsForRepo.current = repoToLoad.full_name;

        // Pick sensible defaults so users can "Continue" quickly: the branch the
        // repository itself considers current, plus the newest tag — the two refs
        // people actually want. Anything already imported is skipped because
        // those rows cannot be selected.
        const defaults: RefChoice[] = [];

        const defaultBranch =
          brs.find((b) => b.name === repoToLoad.default_branch) ??
          brs.find((b) => b.name === "main") ??
          brs.find((b) => b.name === "master");
        if (defaultBranch && !importedVersionSet.has(defaultBranch.name)) {
          defaults.push({ type: "branch", name: defaultBranch.name });
        }

        // The provider sorts tags newest-first numerically, so the head is the
        // latest version.
        const newestTag = tgs[0];
        if (newestTag && !importedVersionSet.has(newestTag.name)) {
          defaults.push({ type: "tag", name: newestTag.name });
        }

        setRefTab("branch");
        setRefChoices(defaults);
      } catch (err) {
        if (controller.signal.aborted) return;
        loadedRefsForRepo.current = null;
        setRefError(
          err instanceof Error ? err.message : "Failed to load versions.",
        );
      } finally {
        if (!controller.signal.aborted) setRefLoading(false);
      }
    }

    fetchRefs();

    return () => controller.abort();
  }, [open, provider, selectedRepo, step, importedVersionSet]);

  // The defaults are picked when the refs load, but which versions already exist
  // arrives from a separate lookup that can land afterwards. Without this, a
  // pre-selected ref could turn out to be imported already — and its row is then
  // not clickable, so the user could not take it out of a selection they never
  // made. Pruning here rather than relaxing the row keeps "already imported means
  // not selectable" true in one place.
  useEffect(() => {
    if (importedVersionSet.size === 0) return;

    setRefChoices((prev) => {
      const kept = prev.filter(
        (choice) => !importedVersionSet.has(choice.name),
      );
      return kept.length === prev.length ? prev : kept;
    });
  }, [importedVersionSet]);

  const canContinue =
    (step === 1 && !!selectedRepo) ||
    (step === 2 && refChoices.length > 0) ||
    step === 3;

  /** Compares by type and name because the choices are recreated per render. */
  function isRefSelected(type: RefChoice["type"], name: string) {
    return refChoices.some(
      (choice) => choice.type === type && choice.name === name,
    );
  }

  function toggleRefChoice(type: RefChoice["type"], name: string) {
    setRefChoices((prev) =>
      prev.some((choice) => choice.type === type && choice.name === name)
        ? prev.filter(
            (choice) => !(choice.type === type && choice.name === name),
          )
        : [...prev, { type, name }],
    );
  }

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
    if (refChoices.length === 0) {
      setSaveError("Choose at least one branch or tag first.");
      return;
    }

    setSaving(true);
    setSaveError(null);
    setSavedRefCount(0);

    let succeeded = 0;

    try {
      // Sequential on purpose: every call fans out into GitHub API requests and
      // the server writes each module in its own transaction. Firing them all at
      // once buys nothing and gets us rate-limited.
      for (const choice of refChoices) {
        const res = await fetch("/api/modules/import-from-git", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: user.id,
            repoFullName: selectedRepo.full_name,
            refType: choice.type,
            refName: choice.name,
            nameOverride: moduleName,
            description: moduleDescription,
            tags,
            icon,
          }),
        });

        const body = await res.json().catch(() => ({}));

        if (!res.ok) {
          const message =
            typeof body?.error === "string" && body.error
              ? body.error
              : "Failed to create module.";
          throw new Error(`${choice.name}: ${message}`);
        }

        succeeded += 1;
        setSavedRefCount(succeeded);
      }

      onImported?.();
      onOpenChange(false);
    } catch (err) {
      // Whatever got imported before the failure stays imported — undoing it
      // would throw away work the user asked for. The list still needs to know.
      if (succeeded > 0) onImported?.();
      setSaveError(
        err instanceof Error ? err.message : "Failed to create module.",
      );
    } finally {
      setSaving(false);
    }
  }

  const lockRepoProvidedFields = !!repoImportedInfo;

  /**
   * Shows the icon choice already stored for this repository.
   *
   * Guarded on `iconMode` being present so that a response from an older build —
   * or any other source that does not carry the field — leaves the control on its
   * own default instead of resetting it to a mode nobody chose.
   */
  function applyStoredIcon(source: ImportedSource) {
    if (!source.iconMode) return;

    iconFromStore.current = true;
    setIcon({
      mode: isIconMode(source.iconMode) ? source.iconMode : "repo",
      iconName: source.iconName ?? null,
    });
  }

  // When repo is selected, check whether it was imported before and which versions exist.
  // Only `full_name` identifies the repo for this lookup; the rest of the object
  // changes identity on every list refresh and would refetch for nothing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: narrowed on purpose
  useEffect(() => {
    if (!open) return;
    if (!user?.id) return;
    if (!selectedRepo) {
      setRepoImportedInfo(null);
      return;
    }

    const controller = new AbortController();
    setRepoImportedLoading(true);
    fetch(
      `/api/modules/imported-versions?repoFullName=${encodeURIComponent(
        selectedRepo.full_name,
      )}`,
      { signal: controller.signal },
    )
      .then(async (res) => {
        const body = (await res
          .json()
          .catch(() => null)) as ImportedVersionsResponse | null;
        if (!res.ok || !body?.repoImported || !body.source) {
          setRepoImportedInfo(null);
          return;
        }

        setRepoImportedInfo({
          source: body.source,
          importedVersions: body.importedVersions ?? [],
          isBuiltin: body.isBuiltin ?? false,
        });
        // Populate fields from the source; these live on terraform_module_sources.
        setModuleName((prev) => body.source?.name ?? prev);
        setModuleDescription(body.source.description ?? "");
        setTags(body.source.tags ?? []);
        applyStoredIcon(body.source);
      })
      .catch(() => {
        if (!controller.signal.aborted) setRepoImportedInfo(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setRepoImportedLoading(false);
      });

    return () => controller.abort();
  }, [open, user?.id, selectedRepo?.full_name]);

  // When repo + ref are chosen, check whether the root module is already imported.
  // Narrowed to the identifying fields for the same reason as the lookup above.
  // biome-ignore lint/correctness/useExhaustiveDependencies: narrowed on purpose
  useEffect(() => {
    if (!open) return;
    if (!user?.id) return;
    if (!selectedRepo || !primaryRef) {
      setExistingImport(null);
      return;
    }

    const controller = new AbortController();
    setExistingImportLoading(true);

    fetch(
      `/api/modules/lookup-import?repoFullName=${encodeURIComponent(
        selectedRepo.full_name,
      )}&refName=${encodeURIComponent(primaryRef.name)}`,
      { signal: controller.signal },
    )
      .then(async (res) => {
        const body = (await res
          .json()
          .catch(() => null)) as LookupImportResponse | null;
        if (!res.ok || !body?.exists || !body.source || !body.module) {
          setExistingImport(null);
          return;
        }

        setExistingImport({ source: body.source, module: body.module });
        // Show what is actually stored rather than the freshly guessed values.
        setModuleName((prev) => body.source?.name ?? prev);
        setModuleDescription(body.source.description ?? "");
        setTags(body.source.tags ?? []);
        applyStoredIcon(body.source);
      })
      .catch(() => {
        if (!controller.signal.aborted) setExistingImport(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setExistingImportLoading(false);
      });

    return () => controller.abort();
  }, [open, user?.id, selectedRepo?.full_name, primaryRef?.name]);

  // Does the repository ship an `icon.png`? Decides whether the icon step offers
  // it at all, so it is looked up rather than guessed.
  //
  // Asked of the default branch, not of the ref being imported, because that is
  // where the importer reads it from. Asking about the ref would hide the option
  // for anyone importing a tag older than the file — and then store an icon the
  // dialog had just said was not there.
  useEffect(() => {
    const repoFullName = selectedRepo?.full_name;
    const refName = selectedRepo?.default_branch ?? primaryRef?.name;

    if (!open || !repoFullName || !refName) {
      setRepoIcon({ status: "unknown" });
      return;
    }

    const [owner, repo] = repoFullName.split("/");
    if (!owner || !repo) return;

    const controller = new AbortController();
    setRepoIcon({ status: "loading" });

    fetch(
      `/api/git-provider/github/repos/${owner}/${repo}/tree?ref=${encodeURIComponent(
        refName,
      )}`,
      { signal: controller.signal },
    )
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as {
          entries?: Array<{ path: string; type: string }>;
        } | null;

        if (controller.signal.aborted) return;

        if (!res.ok) {
          // Unreadable is not the same as absent, but for this control it has to
          // behave the same way: we cannot offer a file we could not see.
          setRepoIcon({ status: "absent" });
          return;
        }

        const path = findRepoIconPath(
          (body?.entries ?? [])
            .filter((entry) => entry.type === "blob")
            .map((entry) => entry.path),
        );

        setRepoIcon(
          path
            ? {
                status: "present",
                path,
                previewUrl: `https://raw.githubusercontent.com/${repoFullName}/${encodeURIComponent(
                  refName,
                )}/${path}`,
              }
            : { status: "absent" },
        );
      })
      .catch(() => {
        if (!controller.signal.aborted) setRepoIcon({ status: "absent" });
      });

    return () => controller.abort();
  }, [
    open,
    selectedRepo?.full_name,
    selectedRepo?.default_branch,
    primaryRef?.name,
  ]);

  // `repo` is the initial mode because it is the right answer whenever it is
  // available. Once we know it is not, the choice moves to the plain mark rather
  // than sitting on an option the user cannot select.
  useEffect(() => {
    if (repoIcon.status !== "absent") return;
    if (iconFromStore.current) return;
    setIcon((prev) =>
      prev.mode === "repo" ? { ...prev, mode: "none" } : prev,
    );
  }, [repoIcon.status]);

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

        {existingImport && step === 3 ? (
          <div className="rounded-md border bg-muted/30 p-3 text-sm">
            This module is already imported for this version. The fields below
            are read-only and show what’s stored in the database.
          </div>
        ) : null}

        {step === 1 ? (
          <>
            <div className="relative rounded-md border border-input bg-background focus-within:border-primary">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search repositories"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="border-0 pl-10 focus-visible:ring-0 focus-visible:ring-offset-0"
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
                {repoImportedInfo.isBuiltin
                  ? "This repository ships with TerraBlox and is already in your module list. Its versions are disabled; pick another ref to add one of your own."
                  : "This repository was imported before. Versions already imported are disabled."}
              </div>
            ) : null}

            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant={refTab === "branch" ? "default" : "outline"}
                size="sm"
                onClick={() => setRefTab("branch")}
              >
                Branches ({branches.length})
              </Button>
              <Button
                type="button"
                variant={refTab === "tag" ? "default" : "outline"}
                size="sm"
                onClick={() => setRefTab("tag")}
              >
                Tags ({gitTags.length})
              </Button>
            </div>

            {refLoading ? (
              <div className="flex items-center justify-center h-[260px]">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : refError ? (
              <div className="text-sm text-destructive">{refError}</div>
            ) : refTab === "tag" ? (
              <div className="space-y-2 h-[260px] overflow-y-auto pr-2">
                {gitTags.length === 0 ? (
                  <div className="rounded-md border p-3 text-sm text-muted-foreground">
                    No tags found for this repository.
                  </div>
                ) : (
                  gitTags.map((t) => {
                    const selected = isRefSelected("tag", t.name);

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
                          toggleRefChoice("tag", t.name);
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
                    const selected = isRefSelected("branch", b.name);

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
                          toggleRefChoice("branch", b.name);
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

            <div className="space-y-2">
              {/* Not a `Label`: the control is a group of buttons, so there is no
                  single form element for a label to point at. */}
              <p className="text-sm font-medium leading-none">Icon</p>
              <IconChoice
                disabled={lockRepoProvidedFields}
                onChange={setIcon}
                repoIcon={repoIcon}
                value={icon}
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

        <div className="flex items-center justify-between border-t pt-4">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              if (saving) return;
              if (step === 1) {
                onOpenChange(false);
              } else {
                setStep((s) => (s === 3 ? 2 : 1));
              }
            }}
          >
            {step === 1 ? "Cancel" : "Back"}
          </Button>

          <div className="flex items-center gap-2">
            {step < 3 ? (
              <Button
                type="button"
                onClick={() => {
                  if (step === 1 && selectedRepo) setStep(2);
                  if (step === 2 && refChoices.length > 0) setStep(3);
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
                    {refChoices.length > 1
                      ? `Importing ${Math.min(
                          savedRefCount + 1,
                          refChoices.length,
                        )} of ${refChoices.length}…`
                      : "Importing…"}
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
