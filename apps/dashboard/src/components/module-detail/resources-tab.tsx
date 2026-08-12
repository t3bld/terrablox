"use client";

import { Badge } from "@terrablox/ui/badge";
import { Input } from "@terrablox/ui/input";
import { cn } from "@terrablox/ui/lib/utils";
import { Boxes, Database, ExternalLink, Search } from "lucide-react";
import { useMemo, useState } from "react";

import type { ModuleResourceDto } from "./types";

interface ResourcesTabProps {
  resources: ModuleResourceDto[];
}

interface ProviderGroup {
  provider: string;
  providerUrl: string | null;
  resources: ModuleResourceDto[];
}

function groupByProvider(resources: ModuleResourceDto[]): ProviderGroup[] {
  const groups = new Map<string, ProviderGroup>();

  for (const resource of resources) {
    const existing = groups.get(resource.providerName);

    if (existing) {
      existing.resources.push(resource);
      // The first entry may not carry a docs URL; take the first one that does.
      existing.providerUrl ??= resource.providerUrl;
    } else {
      groups.set(resource.providerName, {
        provider: resource.providerName,
        providerUrl: resource.providerUrl,
        resources: [resource],
      });
    }
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      resources: [...group.resources].sort((a, b) =>
        `${a.resourceType}.${a.resourceName ?? ""}`.localeCompare(
          `${b.resourceType}.${b.resourceName ?? ""}`,
        ),
      ),
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

function ResourceCard({ resource }: { resource: ModuleResourceDto }) {
  const isData = resource.kind === "data";

  return (
    <li className="group flex items-start gap-3 border-b px-4 py-3 last:border-b-0 hover:bg-muted/40">
      <span
        className={cn(
          // Fixed square that matches the min-height of the title row below, so
          // the icon stays optically centred against the first line of text.
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
          isData
            ? "bg-muted text-muted-foreground"
            : "bg-primary/10 text-primary",
        )}
      >
        {isData ? (
          <Database className="h-3.5 w-3.5" />
        ) : (
          <Boxes className="h-3.5 w-3.5" />
        )}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex min-h-7 flex-wrap items-center gap-2">
          <code className="font-mono text-sm font-medium">
            {resource.resourceType}
            {resource.resourceName ? (
              <span className="text-muted-foreground">
                .{resource.resourceName}
              </span>
            ) : null}
          </code>

          {isData ? <Badge variant="secondary">data source</Badge> : null}

          {resource.resourceUrl ? (
            <a
              className="flex items-center gap-1 text-xs font-medium text-primary underline-offset-4 opacity-0 transition-opacity hover:underline group-hover:opacity-100 focus-visible:opacity-100"
              href={resource.resourceUrl}
              rel="noreferrer"
              target="_blank"
            >
              Docs
              <ExternalLink className="h-3 w-3" />
            </a>
          ) : null}
        </div>

        {resource.resourceDescription ? (
          <p className="mt-1 text-sm text-muted-foreground">
            {resource.resourceDescription}
          </p>
        ) : null}
      </div>
    </li>
  );
}

export function ResourcesTab({ resources }: ResourcesTabProps) {
  const [query, setQuery] = useState("");

  const needle = query.trim().toLowerCase();

  const groups = useMemo(() => {
    const filtered = needle
      ? resources.filter(
          (r) =>
            r.resourceType.toLowerCase().includes(needle) ||
            (r.resourceName?.toLowerCase().includes(needle) ?? false) ||
            r.providerName.toLowerCase().includes(needle),
        )
      : resources;

    return groupByProvider(filtered);
  }, [resources, needle]);

  const shown = groups.reduce((sum, g) => sum + g.resources.length, 0);

  if (resources.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-12 text-center">
        <Boxes className="h-8 w-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          No resources or data sources were found in this module.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter resources…"
            type="search"
            value={query}
          />
        </div>
        <Badge variant="secondary">
          {shown === resources.length
            ? `${resources.length} resources`
            : `${shown} / ${resources.length} resources`}
        </Badge>
      </div>

      {groups.length === 0 ? (
        <p className="rounded-lg border border-dashed py-12 text-center text-sm text-muted-foreground">
          No resources match the current filter.
        </p>
      ) : (
        groups.map((group) => (
          <section
            className="overflow-hidden rounded-lg border bg-card"
            key={group.provider}
          >
            <header className="flex items-center gap-2 border-b bg-muted/30 px-4 py-2.5">
              <h3 className="text-sm font-semibold">{group.provider}</h3>
              <Badge variant="secondary">{group.resources.length}</Badge>
              {group.providerUrl ? (
                <a
                  className="ml-auto flex items-center gap-1 text-xs font-medium text-primary underline-offset-4 hover:underline"
                  href={group.providerUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  Provider docs
                  <ExternalLink className="h-3 w-3" />
                </a>
              ) : null}
            </header>

            <ul>
              {group.resources.map((resource) => (
                <ResourceCard key={resource.id} resource={resource} />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
