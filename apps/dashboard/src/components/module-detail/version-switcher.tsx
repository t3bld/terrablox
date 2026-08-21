"use client";

import { Button } from "@terrablox/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@terrablox/ui/dropdown-menu";
import { Check, ChevronDown, GitBranch } from "lucide-react";
import Link from "next/link";

import { pickDefaultVersion } from "@/lib/terraform/versions";

export interface ModuleVersionRef {
  id: string;
  versionTag: string | null;
  createdAt: string;
}

interface VersionSwitcherProps {
  /** Sorted newest first by the API. */
  versions: ModuleVersionRef[];
  currentModuleId: string;
  /**
   * Submodules have no versions of their own; the switcher then targets the
   * parent so switching does not silently drop the user out of the submodule.
   */
  switchTargetId?: string;
}

export function VersionSwitcher({
  versions,
  currentModuleId,
  switchTargetId,
}: VersionSwitcherProps) {
  const activeId = switchTargetId ?? currentModuleId;
  const current = versions.find((v) => v.id === activeId);
  // The one a repository opens at — its tracked branch, or the newest release if
  // it has none. Marked so a reader can tell where they were sent by default from
  // where they navigated deliberately.
  const fallback = pickDefaultVersion(versions);

  const label = current?.versionTag ?? "(no ref)";

  if (versions.length <= 1) {
    return (
      <div className="flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-xs text-muted-foreground">
        <GitBranch className="h-3.5 w-3.5" />
        {label}
      </div>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button className="h-8 gap-1.5 font-mono text-xs" variant="outline">
          <GitBranch className="h-3.5 w-3.5" />
          {label}
          {current && fallback && current.id === fallback.id ? (
            <span className="font-sans text-[10px] uppercase tracking-wide text-muted-foreground">
              default
            </span>
          ) : null}
          <ChevronDown className="h-3.5 w-3.5 opacity-60" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="end"
        className="max-h-80 w-60 overflow-y-auto"
      >
        <DropdownMenuLabel>{versions.length} versions</DropdownMenuLabel>
        <DropdownMenuSeparator />

        {versions.map((version) => {
          const isActive = version.id === activeId;

          return (
            <DropdownMenuItem asChild key={version.id}>
              <Link
                className="justify-between font-mono text-xs"
                href={`/modules/${encodeURIComponent(version.id)}`}
              >
                <span className="flex items-center gap-2">
                  {isActive ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <span className="w-3.5" />
                  )}
                  {version.versionTag ?? "(no ref)"}
                </span>
                {fallback && version.id === fallback.id ? (
                  <span className="font-sans text-[10px] uppercase tracking-wide text-muted-foreground">
                    default
                  </span>
                ) : null}
              </Link>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
