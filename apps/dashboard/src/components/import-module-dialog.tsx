"use client";

import { useAuth } from "@terrablox/auth/hooks";
import type {
  GitBranch,
  GitProviderId,
  GitRelease,
  GitRepo,
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
import { useEffect, useMemo, useState } from "react";
import { createModuleFromGitImport } from "@/actions/module-actions";
import { MultiRepoFolderPicker } from "@/components/multi-repo-folder-picker";
import { RepoFolderPicker } from "@/components/repo-folder-picker";
import { TagsInput } from "@/components/tags-input";

interface ImportModuleDialogProps {
  provider: GitProviderId;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Step = 1 | 2 | 3 | 4;

type RefChoice =
  | { type: "release"; name: string }
  | { type: "branch"; name: string };

const STEP_META: Record<Step, { title: string; description: string }> = {
  1: {
    title: "Choose a repository",
    description:
      "Pick the repo you want to import from your connected account.",
  },
  2: {
    title: "Choose a version",
    description: "Select a release tag or a branch to import.",
  },
  3: {
    title: "Module",
    description: "Set the module name, description, and tags.",
  },
  4: {
    title: "Terraform",
    description: "Select the Terraform root and any submodule folders.",
  },
};

function Stepper({ current }: { current: Step }) {
  const items: Array<{ step: Step; label: string }> = [
    { step: 1, label: "Repo" },
    { step: 2, label: "Version" },
    { step: 3, label: "Module" },
    { step: 4, label: "Terraform" },
  ];

  return (
    <ol className="flex items-center gap-2" aria-label="Import steps">
      {items.map((item, idx) => {
        const completed = item.step < current;
        const active = item.step === current;

        return (
          <li key={item.step} className="flex items-center gap-2">
            <div
              className={`flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${
                active
                  ? "border-primary text-primary"
                  : completed
                    ? "border-muted-foreground/30 text-foreground"
                    : "border-muted-foreground/20 text-muted-foreground"
              }`}
              aria-current={active ? "step" : undefined}
            >
              <span
                className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] ${
                  active
                    ? "bg-primary text-primary-foreground"
                    : completed
                      ? "bg-muted text-foreground"
                      : "bg-muted/50 text-muted-foreground"
                }`}
              >
                {item.step}
              </span>
              {item.label}
            </div>

            {idx < items.length - 1 ? (
              <span
                className="h-px w-6 bg-muted-foreground/20"
                aria-hidden="true"
              />
            ) : null}
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
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [refLoading, setRefLoading] = useState(false);
  const [refError, setRefError] = useState<string | null>(null);
  const [refChoice, setRefChoice] = useState<RefChoice | null>(null);
  const [refTab, setRefTab] = useState<"release" | "branch">("release");

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

  const providerName = provider.charAt(0).toUpperCase() + provider.slice(1);

  // Reset the wizard on open/close.
  useEffect(() => {
    if (open) {
      setStep(1);
      setSearchQuery("");
      setSelectedRepo(null);
      setRefChoice(null);
      setModuleName("");
      setModuleDescription("");
      setTags([]);
      setTagSuggestions([]);
      setSaveError(null);
      setRefError(null);
      setTerraformRootFolder(".");
      setTerraformSubmodulesFolders([]);
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

    async function fetchRefs() {
      setRefLoading(true);
      setRefError(null);
      setReleases([]);
      setBranches([]);
      setRefChoice(null);

      try {
        const [owner, repo] = repoToLoad.full_name.split("/");
        if (!owner || !repo) {
          throw new Error("Invalid repository name.");
        }

        const [releasesRes, branchesRes] = await Promise.all([
          fetch(
            `/api/git-provider/${provider}/repos/${owner}/${repo}/releases`,
          ),
          fetch(
            `/api/git-provider/${provider}/repos/${owner}/${repo}/branches`,
          ),
        ]);

        const [releasesBody, branchesBody] = await Promise.all([
          releasesRes.json(),
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
        const brs = (branchesBody?.branches ?? []) as GitBranch[];

        setReleases(rels);
        setBranches(brs);

        // Pick a sensible default so users can "Continue" quickly.
        if (rels.length > 0 && rels[0]) {
          setRefTab("release");
          setRefChoice({ type: "release", name: rels[0].tag_name });
        } else if (brs.length > 0 && brs[0]) {
          setRefTab("branch");
          setRefChoice({ type: "branch", name: brs[0].name });
        }
      } catch (err) {
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

  const stepMeta = STEP_META[step];

  async function onFinish() {
    if (!user?.id) {
      setSaveError("You must be signed in.");
      return;
    }
    if (!selectedRepo) {
      setSaveError("Choose a repository first.");
      return;
    }
    if (!refChoice) {
      setSaveError("Choose a release or branch first.");
      return;
    }

    setSaving(true);
    setSaveError(null);

    try {
      await createModuleFromGitImport({
        userId: user.id,
        repoFullName: selectedRepo.full_name,
        refType: refChoice.type,
        refName: refChoice.name,
        terraformRootFolder,
        terraformSubmodulesFolders,
        nameOverride: moduleName,
        description: moduleDescription,
        tags,
      });

      onOpenChange(false);
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : "Failed to create module.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[760px]">
        <DialogHeader className="space-y-3">
          <DialogTitle className="flex items-center gap-2">
            <Github className="h-5 w-5" />
            Import from {providerName}
          </DialogTitle>
          <DialogDescription>
            <div className="space-y-2">
              <Stepper current={step} />
              <div>
                <div className="text-sm font-medium text-foreground">
                  {stepMeta.title}
                </div>
                <div className="text-sm text-muted-foreground">
                  {stepMeta.description}
                </div>
              </div>
            </div>
          </DialogDescription>
        </DialogHeader>

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
                      }}
                      className={`group w-full text-left rounded-md border p-3 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                        selected ? "border-primary" : "border-transparent"
                      }`}
                      aria-pressed={selected}
                    >
                      <div className="flex items-start justify-between gap-3">
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
                        <div
                          className={`text-xs font-medium ${
                            selected
                              ? "text-primary"
                              : "text-muted-foreground group-hover:text-foreground"
                          }`}
                        >
                          {selected ? "Selected" : "Select"}
                        </div>
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
            <div className="rounded-md border bg-muted/20 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground">Repository</span>
                <span className="font-medium">{selectedRepo?.full_name}</span>
                {refChoice ? (
                  <>
                    <span className="text-muted-foreground">•</span>
                    <span className="text-muted-foreground">Selected</span>
                    <span className="font-medium">
                      {refChoice.type === "release" ? "Release" : "Branch"}:{" "}
                      {refChoice.name}
                    </span>
                  </>
                ) : null}
              </div>
            </div>

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
                    return (
                      <button
                        type="button"
                        key={r.id}
                        className={`w-full text-left rounded-md border p-3 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                          selected ? "border-primary" : "border-transparent"
                        }`}
                        onClick={() =>
                          setRefChoice({ type: "release", name: r.tag_name })
                        }
                        aria-pressed={selected}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="font-medium">{r.tag_name}</div>
                            <div className="text-xs text-muted-foreground truncate">
                              {r.name || "Release"}
                            </div>
                          </div>
                          <div
                            className={`text-xs ${selected ? "text-primary" : "text-muted-foreground"}`}
                          >
                            {selected ? "Selected" : "Select"}
                          </div>
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
                    return (
                      <button
                        type="button"
                        key={b.name}
                        className={`w-full text-left rounded-md border p-3 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                          selected ? "border-primary" : "border-transparent"
                        }`}
                        onClick={() =>
                          setRefChoice({ type: "branch", name: b.name })
                        }
                        aria-pressed={selected}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="font-medium">{b.name}</div>
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
                          <div
                            className={`text-xs ${selected ? "text-primary" : "text-muted-foreground"}`}
                          >
                            {selected ? "Selected" : "Select"}
                          </div>
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
            <div className="rounded-md border bg-muted/20 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground">Repository</span>
                <span className="font-medium">{selectedRepo?.full_name}</span>
                <span className="text-muted-foreground">•</span>
                <span className="text-muted-foreground">Version</span>
                <span className="font-medium">
                  {refChoice?.type === "release" ? "Release" : "Branch"}:{" "}
                  {refChoice?.name}
                </span>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="moduleName">Module name</Label>
              <Input
                id="moduleName"
                value={moduleName}
                onChange={(e) => setModuleName(e.target.value)}
                placeholder="e.g. vpc"
              />
              <p className="text-xs text-muted-foreground">
                This is how the module will show up in your dashboard.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="moduleDescription">Description</Label>
              <Input
                id="moduleDescription"
                value={moduleDescription}
                onChange={(e) => setModuleDescription(e.target.value)}
                placeholder="What does this module do?"
              />
              <p className="text-xs text-muted-foreground">
                Prefilled from the repository description. You can edit it.
              </p>
            </div>

            <TagsInput
              label="Tags"
              description="Use a few short, consistent tags (e.g. aws, networking, vpc)."
              value={tags}
              onChange={setTags}
              suggestions={tagSuggestions}
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
            <div className="rounded-md border bg-muted/20 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground">Repository</span>
                <span className="font-medium">{selectedRepo?.full_name}</span>
                <span className="text-muted-foreground">•</span>
                <span className="text-muted-foreground">Version</span>
                <span className="font-medium">
                  {refChoice?.type === "release" ? "Release" : "Branch"}:{" "}
                  {refChoice?.name}
                </span>
              </div>
            </div>

            {selectedRepo && refChoice ? (
              <RepoFolderPicker
                label="Terraform root path"
                description="Pick the folder inside the repo that contains the Terraform module root."
                value={terraformRootFolder}
                onChange={setTerraformRootFolder}
                provider="github"
                repoFullName={selectedRepo.full_name}
                refName={refChoice.name}
              />
            ) : (
              <div className="space-y-2">
                <Label htmlFor="terraformRoot">Terraform root path</Label>
                <Input
                  id="terraformRoot"
                  value={terraformRootFolder}
                  onChange={(e) => setTerraformRootFolder(e.target.value)}
                  placeholder="e.g. . or modules/vpc"
                />
              </div>
            )}

            {selectedRepo && refChoice ? (
              <MultiRepoFolderPicker
                label="Terraform submodule folders"
                description="Optional: if this repo contains multiple Terraform modules, add their folder paths."
                value={terraformSubmodulesFolders}
                onChange={setTerraformSubmodulesFolders}
                provider="github"
                repoFullName={selectedRepo.full_name}
                refName={refChoice.name}
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
                disabled={!canContinue || saving}
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
