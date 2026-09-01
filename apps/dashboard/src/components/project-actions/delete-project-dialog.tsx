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
import { AlertTriangle, Github, Loader2, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

interface DeleteProjectDialogProps {
  projectId: string;
  projectName: string;
  /** Shown so it is obvious the repository survives the delete. */
  repoFullName: string | null;
  /**
   * The repository could not be read just now. Only the reassurance changes:
   * deleting has never depended on reaching GitHub, and this is usually the
   * reason somebody is here.
   */
  repoUnreachable?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: (projectId: string) => void;
}

/**
 * Confirms deleting a project, and says exactly where the line falls.
 *
 * One action, not a choice. Offering "also delete the repository" was tried and
 * dropped: it needs an OAuth scope that would let TerraBlox delete any repository
 * the user owns, for something done a handful of times, and the result is
 * irreversible on a side we do not own. Somebody who wants the repository gone
 * does it on GitHub, where that confirmation belongs.
 *
 * What the dialog owes the reader instead is the boundary, stated rather than
 * implied: this removes what TerraBlox knows, the code is in Git and stays there.
 * No impact request either — everything a project cascades into belongs to that
 * project alone, so the list below is the whole of it.
 */
export function DeleteProjectDialog({
  projectId,
  projectName,
  repoFullName,
  repoUnreachable = false,
  open,
  onOpenChange,
  onDeleted,
}: DeleteProjectDialogProps) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A failure left on screen would reappear the next time the dialog opens, on
  // whichever project that happens to be.
  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  const handleDelete = () => {
    setDeleting(true);
    setError(null);

    fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: "DELETE",
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(
            typeof body?.error === "string" ? body.error : "Failed to delete",
          );
        }
      })
      .then(() => {
        onOpenChange(false);
        onDeleted(projectId);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : "Failed to delete project");
      })
      .finally(() => setDeleting(false));
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Delete project?</DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{projectName}</span>
            {" will be removed from TerraBlox. This cannot be undone."}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-destructive text-sm">
          <div className="flex items-center gap-2 font-medium">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            Removed from TerraBlox
          </div>

          <ul className="mt-2 space-y-1">
            {[
              "the graph: its blocks and the connections between them",
              "the chat history with the project agent",
              "the record of plans, applies and their outcomes",
              "the agent settings that applied to this project only",
            ].map((item) => (
              <li className="flex items-start gap-2" key={item}>
                <span
                  aria-hidden
                  className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-current"
                />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* The Terraform itself lives in Git, so deleting here loses no code. Said
            as its own block rather than a footnote: it is the one thing a person is
            actually worried about when they hover over a red button.

            Unless we could not reach the repository, in which case the same
            sentence is a false assurance — and the reader is most likely here
            *because* they deleted it. Then the block answers the question they do
            have: is this going to work at all. */}
        <div className="rounded-md border p-3 text-sm">
          <div className="flex items-center gap-2 font-medium">
            <Github className="h-4 w-4 shrink-0" />
            {repoUnreachable ? "Not readable on GitHub" : "Kept on GitHub"}
          </div>
          <p className="mt-2 text-muted-foreground">
            {repoUnreachable ? (
              <>
                {repoFullName ? (
                  <code className="font-mono text-xs">{repoFullName}</code>
                ) : (
                  "The repository this project points at"
                )}{" "}
                could not be read — deleted, renamed, or no longer covered by
                TerraBlox's access. Deleting here does not depend on it and will
                work. Nothing is deleted on GitHub either way, so if the
                repository is still there, it and its commits stay as they are.
              </>
            ) : repoFullName ? (
              <>
                <code className="font-mono text-xs">{repoFullName}</code> is
                left untouched, with every commit TerraBlox made to it. Your
                Terraform is not lost, and another project reading this
                repository keeps working. Delete the repository on GitHub if you
                want it gone.
              </>
            ) : (
              "The repository this project points at is left untouched, with every commit TerraBlox made to it."
            )}
          </p>
        </div>

        {error ? (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button
            disabled={deleting}
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            disabled={deleting}
            onClick={handleDelete}
            type="button"
            variant="destructive"
          >
            {deleting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="mr-2 h-4 w-4" />
            )}
            Delete project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
