"use client";

import { Button } from "@terrablox/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@terrablox/ui/dropdown-menu";
import { MoreHorizontal, Trash2 } from "lucide-react";
import { useState } from "react";

import { DeleteProjectDialog } from "./delete-project-dialog";

interface ProjectActionsMenuProps {
  projectId: string;
  /** Null while the project is still loading; the menu stays disabled. */
  projectName: string | null;
  repoFullName: string | null;
  onDeleted: (projectId: string) => void;
  /** Stops the click bubbling into a surrounding link (project cards). */
  stopPropagation?: boolean;
}

/**
 * The "…" menu in the project header.
 *
 * Delete is the only entry: renaming and re-pointing a project are settings
 * that belong on a form, and a one-item menu is still the right home for the
 * one action that must not sit next to them as a stray button.
 */
export function ProjectActionsMenu({
  projectId,
  projectName,
  repoFullName,
  onDeleted,
  stopPropagation = false,
}: ProjectActionsMenuProps) {
  const [confirming, setConfirming] = useState(false);

  const swallow = (event: React.SyntheticEvent) => {
    if (!stopPropagation) return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={`Actions for ${projectName ?? "this project"}`}
            className="h-8 w-8 shrink-0 text-muted-foreground"
            // Deleting a project whose name has not arrived yet would ask for
            // confirmation without being able to say what is being deleted.
            disabled={!projectName}
            onClick={swallow}
            size="icon"
            type="button"
            variant="ghost"
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end" className="w-48" onClick={swallow}>
          <DropdownMenuItem
            className="text-destructive focus:bg-destructive/10 focus:text-destructive"
            onSelect={() => setConfirming(true)}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DeleteProjectDialog
        onDeleted={onDeleted}
        onOpenChange={setConfirming}
        open={confirming}
        projectId={projectId}
        projectName={projectName ?? "this project"}
        repoFullName={repoFullName}
      />
    </>
  );
}
