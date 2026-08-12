"use client";

import { Badge } from "@terrablox/ui/badge";
import { Button } from "@terrablox/ui/button";
import { Card, CardContent } from "@terrablox/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@terrablox/ui/dropdown-menu";
import { Boxes, ChevronDown, GitBranch, Layers } from "lucide-react";
import Link from "next/link";

import { ModuleActionsMenu } from "@/components/module-actions/module-actions-menu";
import type { DeleteScope } from "@/lib/terraform/delete-scope";

import type { RepositoryDto } from "./types";

interface RepositoryCardProps {
  repository: RepositoryDto;
  onDeleted: (moduleId: string, scope: DeleteScope) => void;
}

/** Strips the `.git` suffix and scheme so the repo reads as `owner/name`. */
function shortRepoLabel(url: string | null): string | null {
  if (!url) return null;
  return (
    url
      .replace(/^https?:\/\/(www\.)?[^/]+\//i, "")
      .replace(/\.git$/i, "")
      .replace(/\/+$/, "") || null
  );
}

export function RepositoryCard({ repository, onDeleted }: RepositoryCardProps) {
  const latest = repository.latestVersion;
  if (!latest) return null;

  const repoLabel = shortRepoLabel(repository.url);
  const hasMultipleVersions = repository.versionCount > 1;

  return (
    <Card className="relative flex h-full flex-col transition-colors hover:bg-muted/40">
      <CardContent className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            {/* Stretched link: covers the card without nesting the interactive
                controls below inside an anchor. */}
            <Link
              className="block truncate font-medium after:absolute after:inset-0 after:rounded-lg focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring"
              href={`/modules/${encodeURIComponent(latest.id)}`}
            >
              {repository.name}
            </Link>
            {repoLabel ? (
              <div className="truncate text-xs text-muted-foreground">
                {repoLabel}
              </div>
            ) : null}
          </div>

          <div className="relative z-10">
            <ModuleActionsMenu
              module={{
                id: latest.id,
                name: repository.name,
                versionTag: latest.versionTag,
                repoUrl: repository.url,
                refUrl: latest.url,
                terraformRootFolder: latest.terraformRootFolder,
                isSubmodule: false,
                parentModuleId: null,
                versionCount: repository.versionCount,
              }}
              onDeleted={onDeleted}
              stopPropagation
            />
          </div>
        </div>

        {repository.description ? (
          <p className="line-clamp-2 text-sm text-muted-foreground">
            {repository.description}
          </p>
        ) : null}

        <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
          {hasMultipleVersions ? (
            <div className="relative z-10">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    className="h-7 gap-1.5 px-2 font-mono text-xs"
                    onClick={(e) => e.preventDefault()}
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    <GitBranch className="h-3.5 w-3.5" />
                    {latest.versionTag ?? "(no ref)"}
                    <ChevronDown className="h-3.5 w-3.5 opacity-60" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  className="max-h-72 w-56 overflow-y-auto"
                  onClick={(e) => e.preventDefault()}
                >
                  <DropdownMenuLabel>
                    {repository.versionCount} versions
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {repository.versions.map((version) => (
                    <DropdownMenuItem asChild key={version.id}>
                      <Link
                        href={`/modules/${encodeURIComponent(version.id)}`}
                        className="justify-between font-mono text-xs"
                      >
                        {version.versionTag ?? "(no ref)"}
                        {version.id === latest.id ? (
                          <span className="ml-2 font-sans text-[10px] uppercase tracking-wide text-muted-foreground">
                            latest
                          </span>
                        ) : null}
                      </Link>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ) : (
            <Badge className="gap-1.5 font-mono" variant="secondary">
              <GitBranch className="h-3.5 w-3.5" />
              {latest.versionTag ?? "(no ref)"}
            </Badge>
          )}

          {latest.submoduleCount > 0 ? (
            <Badge className="gap-1.5" variant="outline">
              <Layers className="h-3.5 w-3.5" />
              {latest.submoduleCount} submodule
              {latest.submoduleCount === 1 ? "" : "s"}
            </Badge>
          ) : null}

          {hasMultipleVersions ? (
            <Badge className="gap-1.5" variant="outline">
              <Boxes className="h-3.5 w-3.5" />
              {repository.versionCount} versions
            </Badge>
          ) : null}
        </div>

        {repository.tags.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {repository.tags.map((tag) => (
              <Badge className="text-[10px]" key={tag} variant="outline">
                {tag}
              </Badge>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
