"use client";

import { Badge } from "@terrablox/ui/badge";
import { Button } from "@terrablox/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@terrablox/ui/dropdown-menu";
import { Check, ChevronDown, FolderTree } from "lucide-react";
import Link from "next/link";

export interface SubmoduleRef {
  id: string;
  submoduleName: string | null;
  terraformRootFolder: string | null;
}

interface SubmoduleSwitcherProps {
  submodules: SubmoduleRef[];
  /**
   * Set while viewing a submodule: the list then holds its siblings, so the
   * control reads as a switch and marks the one already open.
   */
  currentId?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * Applied to the wrapper. Spacing lives here rather than on the caller's own
   * element so that nothing is left behind when there is no list to offer.
   */
  className?: string;
}

/**
 * Reaches the submodules of a repository from the module they belong to.
 *
 * A dropdown rather than a tab because a submodule is a separate page, not
 * another view of this one — the list was only ever a launch pad, and as a tab
 * it occupied the same rank as the tabs that actually describe this module.
 * Keeping it beside the metadata also makes it reachable from every tab.
 */
export function SubmoduleSwitcher({
  submodules,
  currentId,
  open,
  onOpenChange,
  className,
}: SubmoduleSwitcherProps) {
  const isSwitching = currentId !== undefined;

  // On a submodule page the only entry may be the page one, leaving nowhere to
  // go; the link back to the parent already covers that case.
  const hasSomewhereToGo = isSwitching
    ? submodules.some((s) => s.id !== currentId)
    : submodules.length > 0;

  if (!hasSomewhereToGo) return null;

  return (
    <div className={className}>
      <DropdownMenu modal={false} onOpenChange={onOpenChange} open={open}>
        <DropdownMenuTrigger asChild>
          <Button className="h-8 gap-1.5 text-xs" variant="outline">
            <FolderTree className="h-3.5 w-3.5" />
            {isSwitching ? "Change submodule" : "Submodules"}
            {isSwitching ? null : (
              <Badge variant="secondary">{submodules.length}</Badge>
            )}
            <ChevronDown className="h-3.5 w-3.5 opacity-60" />
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent
          align="start"
          className="max-h-80 w-72 overflow-y-auto"
        >
          <DropdownMenuLabel>
            {submodules.length} submodule{submodules.length === 1 ? "" : "s"}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />

          {submodules.map((submodule) => {
            const isActive = submodule.id === currentId;

            return (
              <DropdownMenuItem asChild key={submodule.id}>
                <Link
                  className="cursor-pointer"
                  href={`/modules/${encodeURIComponent(submodule.id)}`}
                >
                  <span className="flex min-w-0 items-start gap-2">
                    {isSwitching ? (
                      isActive ? (
                        <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      ) : (
                        <span className="w-3.5 shrink-0" />
                      )
                    ) : (
                      <FolderTree className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    )}

                    <span className="min-w-0">
                      <span className="block truncate font-medium text-sm">
                        {submodule.submoduleName ?? "(unnamed)"}
                      </span>
                      {/* Two submodules can read alike; the folder says which
                          code each one is. */}
                      <code className="block truncate font-mono text-muted-foreground text-xs">
                        {submodule.terraformRootFolder || "."}
                      </code>
                    </span>
                  </span>
                </Link>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
