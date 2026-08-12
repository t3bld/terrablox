"use client";

import type { GitRepo } from "@terrablox/git-import";
import { Button } from "@terrablox/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@terrablox/ui/dialog";
import { Input } from "@terrablox/ui/input";
import { Label } from "@terrablox/ui/label";
import { AlertCircle, GitBranch, Lock, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { ProjectDto } from "@/lib/projects/types";

interface CreateProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (project: ProjectDto) => void;
}

type RepoMode = "existing" | "new";

/**
 * Creates a project and binds it to a repository in one step.
 *
 * The binding cannot be deferred: everything the project shows is read from the
 * repository, so the dialog either adopts one the user already has or creates
 * an empty one for them.
 */
export function CreateProjectDialog({
  open,
  onOpenChange,
  onCreated,
}: CreateProjectDialogProps) {
  const [mode, setMode] = useState<RepoMode>("existing");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [rootFolder, setRootFolder] = useState(".");

  const [repos, setRepos] = useState<GitRepo[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [reposError, setReposError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);

  const [newRepoName, setNewRepoName] = useState("");
  const [newRepoOwner, setNewRepoOwner] = useState("");
  const [newRepoPrivate, setNewRepoPrivate] = useState(true);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset on close so a cancelled attempt does not bleed into the next one.
  useEffect(() => {
    if (open) return;
    setMode("existing");
    setName("");
    setDescription("");
    setRootFolder(".");
    setSearch("");
    setSelectedRepo(null);
    setNewRepoName("");
    setNewRepoOwner("");
    setNewRepoPrivate(true);
    setError(null);
  }, [open]);

  useEffect(() => {
    if (!open || mode !== "existing" || repos.length > 0) return;

    let cancelled = false;
    setReposLoading(true);
    setReposError(null);

    fetch("/api/git-provider/github/repos")
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok)
          throw new Error(body?.error ?? "Failed to load repositories");
        if (!cancelled) setRepos(body.repos ?? []);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setReposError(
            err instanceof Error ? err.message : "Failed to load repositories",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setReposLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, mode, repos.length]);

  const filteredRepos = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return repos.slice(0, 50);
    return repos
      .filter((repo) => repo.full_name.toLowerCase().includes(query))
      .slice(0, 50);
  }, [repos, search]);

  const canSubmit =
    name.trim().length > 0 &&
    (mode === "existing"
      ? Boolean(selectedRepo)
      : newRepoName.trim().length > 0);

  function selectRepo(repo: GitRepo) {
    setSelectedRepo(repo.full_name);
    // The repo name is the most likely project name, but never overwrite what
    // the user already typed.
    if (!name.trim()) setName(repo.name);
  }

  async function submit() {
    if (!canSubmit || submitting) return;

    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || null,
          terraformRootFolder: rootFolder,
          repo:
            mode === "existing"
              ? { mode: "existing", fullName: selectedRepo }
              : {
                  mode: "new",
                  name: newRepoName.trim(),
                  owner: newRepoOwner.trim() || null,
                  private: newRepoPrivate,
                },
        }),
      });

      const body = await response.json();
      if (!response.ok) {
        throw new Error(body?.error ?? "Failed to create project");
      }

      onCreated(body.project as ProjectDto);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            Every project is backed by a Git repository. Changes you make in the
            graph or through the agent are committed there.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="project-name">Project name</Label>
            <Input
              id="project-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Platform landing zone"
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="project-description">Description</Label>
            <Input
              id="project-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Optional"
            />
          </div>

          <div className="flex gap-2 rounded-lg border p-1">
            <ModeButton
              active={mode === "existing"}
              onClick={() => setMode("existing")}
              label="Use existing repository"
            />
            <ModeButton
              active={mode === "new"}
              onClick={() => setMode("new")}
              label="Create new repository"
            />
          </div>

          {mode === "existing" ? (
            <div className="space-y-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search repositories"
                  className="pl-9"
                />
              </div>

              <div className="h-56 overflow-y-auto rounded-lg border">
                {reposLoading ? (
                  <p className="p-4 text-sm text-muted-foreground">
                    Loading repositories…
                  </p>
                ) : reposError ? (
                  <p className="flex items-start gap-2 p-4 text-sm text-destructive">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    {reposError}
                  </p>
                ) : filteredRepos.length === 0 ? (
                  <p className="p-4 text-sm text-muted-foreground">
                    No repositories match your search.
                  </p>
                ) : (
                  <ul>
                    {filteredRepos.map((repo) => (
                      <li key={repo.id}>
                        <button
                          type="button"
                          onClick={() => selectRepo(repo)}
                          className={`flex w-full items-center gap-2 border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-muted/60 ${
                            selectedRepo === repo.full_name ? "bg-muted" : ""
                          }`}
                        >
                          <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <span className="truncate">{repo.full_name}</span>
                          {repo.private ? (
                            <Lock className="ml-auto h-3 w-3 shrink-0 text-muted-foreground" />
                          ) : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid gap-2">
                <Label htmlFor="repo-name">Repository name</Label>
                <Input
                  id="repo-name"
                  value={newRepoName}
                  onChange={(event) => setNewRepoName(event.target.value)}
                  placeholder="platform-landing-zone"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="repo-owner">Organisation</Label>
                <Input
                  id="repo-owner"
                  value={newRepoOwner}
                  onChange={(event) => setNewRepoOwner(event.target.value)}
                  placeholder="Leave empty to create under your account"
                />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={newRepoPrivate}
                  onChange={(event) => setNewRepoPrivate(event.target.checked)}
                  className="h-4 w-4"
                />
                Private repository
              </label>
            </div>
          )}

          <div className="grid gap-2">
            <Label htmlFor="root-folder">Terraform folder</Label>
            <Input
              id="root-folder"
              value={rootFolder}
              onChange={(event) => setRootFolder(event.target.value)}
              placeholder="."
            />
            <p className="text-xs text-muted-foreground">
              Folder inside the repository that holds the root configuration.
            </p>
          </div>

          {error ? (
            <p className="flex items-start gap-2 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit || submitting}>
            {submitting ? "Creating…" : "Create project"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ModeButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-muted"
      }`}
    >
      {label}
    </button>
  );
}
