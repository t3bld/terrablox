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

import { ModuleIcon } from "@/components/module-icon";
import type { RepositoryDto } from "./types";

interface RepositoryCardProps {
  repository: RepositoryDto;
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

export function RepositoryCard({ repository }: RepositoryCardProps) {
  const current = repository.defaultVersion;
  if (!current) return null;

  const repoLabel = shortRepoLabel(repository.url);
  const hasMultipleVersions = repository.versionCount > 1;

  return (
    <Card className="relative flex h-full flex-col transition-colors hover:bg-muted/40">
      <CardContent className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex items-start gap-3">
          <ModuleIcon
            icon={{
              sourceId: repository.sourceId,
              iconMode: repository.iconMode,
              hasIcon: repository.hasIcon,
              iconName: repository.iconName,
            }}
          />

          <div className="min-w-0 flex-1">
            {/* Stretched link: covers the card without nesting the interactive
                controls below inside an anchor. */}
            <Link
              className="block truncate font-medium after:absolute after:inset-0 after:rounded-lg focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring"
              href={`/modules/${encodeURIComponent(current.id)}`}
            >
              {repository.name}
            </Link>
            {repoLabel ? (
              <div className="truncate text-xs text-muted-foreground">
                {repoLabel}
              </div>
            ) : null}
          </div>
        </div>

        {repository.description ? (
          <p className="line-clamp-2 text-sm text-muted-foreground">
            {repository.description}
          </p>
        ) : null}

        {/* Every chip in this row is pinned to the same height. The version
            picker is a Button and the rest are Badges; the two components pad
            differently, so left to their defaults the row came out uneven. */}
        <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
          {hasMultipleVersions ? (
            <div className="relative z-10">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    className="h-6 gap-1.5 px-2 font-mono text-xs"
                    onClick={(e) => e.preventDefault()}
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    <GitBranch className="h-3.5 w-3.5" />
                    {current.versionTag ?? "(no ref)"}
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
                        {version.id === current.id ? (
                          <span className="ml-2 font-sans text-[10px] uppercase tracking-wide text-muted-foreground">
                            default
                          </span>
                        ) : null}
                      </Link>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ) : (
            <Badge className="h-6 gap-1.5 px-2 font-mono" variant="secondary">
              <GitBranch className="h-3.5 w-3.5" />
              {current.versionTag ?? "(no ref)"}
            </Badge>
          )}

          {current.submoduleCount > 0 ? (
            <Badge className="h-6 gap-1.5 px-2" variant="outline">
              <Layers className="h-3.5 w-3.5" />
              {current.submoduleCount} submodule
              {current.submoduleCount === 1 ? "" : "s"}
            </Badge>
          ) : null}

          {hasMultipleVersions ? (
            <Badge className="h-6 gap-1.5 px-2" variant="outline">
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
