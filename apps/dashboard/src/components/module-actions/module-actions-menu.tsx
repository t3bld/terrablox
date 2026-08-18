"use client";

import { Button } from "@terrablox/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@terrablox/ui/dropdown-menu";

import {
  Check,
  Copy,
  CornerLeftUp,
  ExternalLink,
  MoreHorizontal,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import type { DeleteScope } from "@/lib/terraform/delete-scope";

import { DeleteModuleDialog } from "./delete-module-dialog";

export interface ModuleActionsTarget {
  id: string;
  name: string;
  versionTag: string | null;
  repoUrl: string | null;
  /** Repository URL pinned to `versionTag`, if the import recorded one. */
  refUrl: string | null;
  terraformRootFolder: string | null;
  isSubmodule: boolean;
  parentModuleId: string | null;
  /** Number of imported refs of the same repository. */
  versionCount: number;
}

interface ModuleActionsMenuProps {
  module: ModuleActionsTarget;
  onDeleted: (moduleId: string, scope: DeleteScope) => void;
  /** Stops the click bubbling into a surrounding link (overview cards). */
  stopPropagation?: boolean;
  align?: "start" | "end";
  /** Detail pages expose deletion separately from repository navigation. */
  deleteOnly?: boolean;
}

/**
 * Builds the `module` block a consumer would paste into their Terraform code.
 *
 * Uses the `git::` form rather than a registry address because these modules
 * are imported straight from a repository and may well be private.
 */
function buildTerraformSnippet(module: ModuleActionsTarget): string {
  const blockName =
    module.name
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "") || "module";

  if (!module.repoUrl) {
    return `module "${blockName}" {\n  source = "<repository URL unavailable>"\n}\n`;
  }

  const base = module.repoUrl.replace(/\.git$/i, "").replace(/\/+$/, "");
  const folder =
    module.terraformRootFolder && module.terraformRootFolder !== "."
      ? `//${module.terraformRootFolder.replace(/^\/+|\/+$/g, "")}`
      : "";
  const ref = module.versionTag ? `?ref=${module.versionTag}` : "";

  return `module "${blockName}" {\n  source = "git::${base}.git${folder}${ref}"\n}\n`;
}

export function ModuleActionsMenu({
  module,
  onDeleted,
  stopPropagation = false,
  align = "end",
  deleteOnly = false,
}: ModuleActionsMenuProps) {
  const [deleteScope, setDeleteScope] = useState<DeleteScope | null>(null);
  const [copied, setCopied] = useState(false);

  const swallow = (event: React.SyntheticEvent) => {
    if (!stopPropagation) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const handleCopySnippet = () => {
    void navigator.clipboard
      .writeText(buildTerraformSnippet(module))
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  };

  // With a single version the distinction is noise, so the menu collapses to
  // one unambiguous entry that still deletes the repository entry as a whole.
  const hasMultipleVersions = !module.isSubmodule && module.versionCount > 1;

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={`Actions for ${module.name}`}
            className="h-8 w-8 shrink-0 text-muted-foreground"
            onClick={swallow}
            size="icon"
            type="button"
            variant="ghost"
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align={align} className="w-60" onClick={swallow}>
          {!deleteOnly ? (
            <>
              <DropdownMenuItem onSelect={handleCopySnippet}>
                {copied ? (
                  <Check className="mr-2 h-4 w-4 text-emerald-600" />
                ) : (
                  <Copy className="mr-2 h-4 w-4" />
                )}
                {copied ? "Copied!" : "Copy module source"}
              </DropdownMenuItem>

              {module.isSubmodule && module.parentModuleId ? (
                <DropdownMenuItem asChild>
                  <Link
                    href={`/modules/${encodeURIComponent(module.parentModuleId)}`}
                  >
                    <CornerLeftUp className="mr-2 h-4 w-4" />
                    Go to parent module
                  </Link>
                </DropdownMenuItem>
              ) : null}

              {module.repoUrl || module.refUrl ? (
                <DropdownMenuSeparator />
              ) : null}

              {module.repoUrl ? (
                <DropdownMenuItem asChild>
                  <a href={module.repoUrl} rel="noreferrer" target="_blank">
                    <ExternalLink className="mr-2 h-4 w-4" />
                    Open repository
                  </a>
                </DropdownMenuItem>
              ) : null}

              {module.refUrl && module.versionTag ? (
                <DropdownMenuItem asChild>
                  <a href={module.refUrl} rel="noreferrer" target="_blank">
                    <ExternalLink className="mr-2 h-4 w-4" />
                    Open at {module.versionTag}
                  </a>
                </DropdownMenuItem>
              ) : null}

              <DropdownMenuSeparator />
            </>
          ) : null}

          {hasMultipleVersions ? (
            <>
              <DropdownMenuItem
                className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                onSelect={() => setDeleteScope("version")}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Delete {module.versionTag ?? "this version"}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                onSelect={() => setDeleteScope("module")}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Delete all {module.versionCount} versions
              </DropdownMenuItem>
            </>
          ) : (
            <DropdownMenuItem
              className="text-destructive focus:bg-destructive/10 focus:text-destructive"
              onSelect={() => setDeleteScope("version")}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete…
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <DeleteModuleDialog
        moduleId={module.id}
        moduleName={module.name}
        onDeleted={onDeleted}
        onOpenChange={(open) => {
          if (!open) setDeleteScope(null);
        }}
        open={deleteScope !== null}
        scope={deleteScope ?? "version"}
        versionTag={module.versionTag}
      />
    </>
  );
}
