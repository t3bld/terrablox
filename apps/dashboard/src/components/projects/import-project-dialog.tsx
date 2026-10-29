"use client";

import { Button } from "@terrablox/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@terrablox/ui/dialog";
import { Label } from "@terrablox/ui/label";
import { AlertCircle } from "lucide-react";
import { useEffect, useState } from "react";

import { GithubInstallHint } from "@/components/github-install-hint";
import type { ProjectDto } from "@/lib/projects/types";
import { AppRepoPicker, type AppRepoSelection } from "./app-repo-picker";

interface ImportProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: (project: ProjectDto) => void;
}

/** Where to send somebody whose repository is not in the picker yet. */
interface RepoAccess {
  /** Whether the app is installed on any account this user can see. */
  installed: boolean;
  installUrl: string;
  /** Set while an organisation owner has yet to approve the app. */
  pendingRequestAt: string | null;
}

/**
 * Imports a repository that already exists on GitHub as a project.
 *
 * Terrablox creates no repository: it needs the GitHub App's Administration
 * permission, which organisations refuse to grant and which cannot work on an
 * installation limited to selected repositories anyway. So the repository is made
 * on GitHub, by whoever is allowed to, and picked here from what the installation
 * was granted.
 *
 * Nothing but the repository is asked. The project is named after it on the server,
 * and only repositories without any Terraform are accepted (the server says so if
 * one is not), so there is exactly one possible Terraform root and nothing asks for
 * one.
 */
export function ImportProjectDialog({
  open,
  onOpenChange,
  onImported,
}: ImportProjectDialogProps) {
  /**
   * The project's own repository, in the picker's shape.
   *
   * Only `fullName` is sent. The branch stays the repository's default, which is what
   * GitHub created the README on and what the server resolves when none is given.
   */
  const [repo, setRepo] = useState<AppRepoSelection | null>(null);
  const [appRepo, setAppRepo] = useState<AppRepoSelection | null>(null);

  const [access, setAccess] = useState<RepoAccess | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset on close so a cancelled attempt does not bleed into the next one. The
  // access answer is kept: it is a fact about the account, not about this attempt.
  useEffect(() => {
    if (open) return;
    setRepo(null);
    setAppRepo(null);
    setError(null);
  }, [open]);

  // Asked on open rather than when the picker opens, because the answer decides what
  // the dialog shows *instead of* the picker: with no installation there is nothing
  // to pick, and the remedy is a link to GitHub.
  useEffect(() => {
    if (!open) return;

    let cancelled = false;

    fetch("/api/github/installations")
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (cancelled || typeof body?.installUrl !== "string") return;
        setAccess({
          installed:
            Array.isArray(body.installations) && body.installations.length > 0,
          installUrl: body.installUrl,
          pendingRequestAt:
            typeof body.pendingRequestAt === "string"
              ? body.pendingRequestAt
              : null,
        });
      })
      .catch(() => {
        // Left to the picker, which explains an empty list on its own. Failing
        // loudly here would block the dialog over a hint.
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  const canSubmit = repo !== null;

  async function submit() {
    if (!canSubmit || submitting || !repo) return;

    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo: { fullName: repo.fullName },
          appRepo,
        }),
      });

      const body = await response.json().catch(() => null);
      if (!response.ok) {
        // The server's refusals are written to be shown as they are: each one says
        // what to change on GitHub.
        throw new Error(body?.error ?? "Failed to import repository");
      }

      onImported(body.project as ProjectDto);
      onOpenChange(false);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to import repository",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Import an existing GitHub repository</DialogTitle>
          <DialogDescription>
            Choose where Terrablox should write the generated infrastructure.
          </DialogDescription>
        </DialogHeader>

        {/* `pt-2` on top of the dialog's own header spacing: the description sat
            close enough to the first label to read as its caption. */}
        <div className="space-y-4 pt-2">
          {/* Replaces the picker rather than sitting beside it: with no
              installation there is nothing to choose, and a picker that opens onto
              an explanation reads as a broken picker. */}
          {access && !access.installed ? (
            <GithubInstallHint
              installUrl={access.installUrl}
              pendingRequestAt={access.pendingRequestAt}
            />
          ) : (
            <div className="grid gap-2">
              <Label htmlFor="project-repo">Infrastructure Repository</Label>
              <AppRepoPicker
                clearable={false}
                disabled={submitting}
                onChange={(next) => {
                  setRepo(next);
                  // A refusal was about the previous choice.
                  setError(null);
                }}
                placeholder="Choose a repository"
                triggerId="project-repo"
                value={repo}
              />
            </div>
          )}

          {/* Asked here rather than later because it changes the first answer the
              agent gives. Infrastructure that fits an application has to come
              from how that application is built, and nobody wants to describe
              their own codebase in a chat box. */}
          {/* The explanation sits between the label and the control, because it
              is what tells someone whether to fill the field in at all — read
              after the picker it arrives too late to be a decision. */}
          <div className="grid gap-2 border-t pt-4">
            <Label htmlFor="app-repo">
              Application repository{" "}
              <span className="font-normal text-muted-foreground">
                — optional
              </span>
            </Label>
            <p className="text-xs text-muted-foreground">
              The agent gets read-only access to the application repository you
              are building this infrastructure for.
            </p>
            <AppRepoPicker
              disabled={submitting}
              onChange={setAppRepo}
              placeholder="None"
              triggerId="app-repo"
              value={appRepo}
            />
          </div>

          {error ? (
            <p
              className="flex items-start gap-2 text-sm text-destructive"
              role="alert"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            disabled={submitting}
            onClick={() => onOpenChange(false)}
            variant="outline"
          >
            Cancel
          </Button>
          <Button disabled={!canSubmit || submitting} onClick={submit}>
            {submitting ? "Importing…" : "Import repository"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
