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
import { AlertTriangle, Loader2, Trash2 } from "lucide-react";
import { useState } from "react";

interface DeleteProjectDialogProps {
  projectId: string;
  projectName: string;
  /** Shown so it is obvious the repository survives the delete. */
  repoFullName: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: (projectId: string) => void;
}

/**
 * Confirms deleting a project.
 *
 * No impact request, unlike the module dialog: everything a project cascades
 * into belongs to that project alone (its graph, its chat, its operation log),
 * so there is nothing to go and look up — the list below is the whole of it.
 */
export function DeleteProjectDialog({
  projectId,
  projectName,
  repoFullName,
  open,
  onOpenChange,
  onDeleted,
}: DeleteProjectDialogProps) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          <div className="flex items-center gap-2 font-medium">
            <AlertTriangle className="h-4 w-4" />
            This also removes
          </div>

          <ul className="mt-2 space-y-1">
            {[
              "the graph: its blocks and the connections between them",
              "the chat history with the project agent",
              "the record of plans, applies and their outcomes",
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

        {/* The Terraform itself lives in Git, so deleting here loses no code. */}
        <p className="text-sm text-muted-foreground">
          The repository{" "}
          {repoFullName ? (
            <code className="font-mono text-xs">{repoFullName}</code>
          ) : (
            "it points at"
          )}{" "}
          is left untouched, including every commit TerraBlox made to it.
        </p>

        {error ? (
          <p className="text-sm text-destructive" role="alert">
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
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
