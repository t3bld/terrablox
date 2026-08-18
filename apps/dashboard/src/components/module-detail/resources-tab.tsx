"use client";

import { Badge } from "@terrablox/ui/badge";
import { useMemo, useState } from "react";

import { serviceOfResource } from "@/lib/terraform/aws-services";
import {
  EmptyMessage,
  FieldList,
  LinkRow,
  SearchField,
} from "./field-primitives";
import type { ModuleResourceDto } from "./types";

interface ResourcesTabProps {
  resources: ModuleResourceDto[];
}

/**
 * One row per resource *type*, not per block.
 *
 * `aws_appautoscaling_policy.cpu_scaling` and `.memory_scaling` are two
 * distinct Terraform blocks, but as two rows they read as two unrelated things
 * when they are one decision: this module scales on CPU and on memory. Folding
 * them keeps that fact and moves the block names to where they belong — detail
 * under the type, not a headline of their own.
 */
interface TypeRow {
  key: string;
  resourceType: string;
  /** Block names, e.g. `cpu_scaling`. Empty when a block carries no name. */
  names: string[];
  count: number;
  docsUrl: string | null;
  description: string | null;
}

interface ServiceGroup {
  service: string;
  rows: TypeRow[];
  count: number;
  isData: boolean;
}

const DATA_GROUP = "Data sources";

function foldByType(resources: ModuleResourceDto[]): TypeRow[] {
  const rows = new Map<string, TypeRow>();

  for (const resource of resources) {
    const isData = resource.kind === "data";
    const key = `${isData ? "data." : ""}${resource.resourceType}`;
    const existing = rows.get(key);

    if (existing) {
      existing.count += 1;
      if (resource.resourceName) existing.names.push(resource.resourceName);
      // The first block of a type may carry neither, so take the first that does.
      existing.docsUrl ??= resource.resourceUrl;
      existing.description ??= resource.resourceDescription;
      continue;
    }

    rows.set(key, {
      key,
      resourceType: resource.resourceType,
      names: resource.resourceName ? [resource.resourceName] : [],
      count: 1,
      docsUrl: resource.resourceUrl,
      description: resource.resourceDescription,
    });
  }

  for (const row of rows.values()) {
    row.names.sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  }

  return [...rows.values()].sort(
    (a, b) => b.count - a.count || a.resourceType.localeCompare(b.resourceType),
  );
}

function groupByService(resources: ModuleResourceDto[]): ServiceGroup[] {
  const byService = new Map<string, ModuleResourceDto[]>();

  for (const resource of resources) {
    // Data sources are read, not created. Mixing them into the service groups
    // overstates what the module builds, which is what this tab is asked.
    const service =
      resource.kind === "data"
        ? DATA_GROUP
        : serviceOfResource(resource.resourceType, resource.providerName);

    const existing = byService.get(service);
    if (existing) existing.push(resource);
    else byService.set(service, [resource]);
  }

  return [...byService.entries()]
    .map(([service, entries]) => ({
      service,
      isData: service === DATA_GROUP,
      count: entries.length,
      rows: foldByType(entries),
    }))
    .sort((a, b) => {
      // Read-only inputs belong after everything the module creates.
      if (a.isData !== b.isData) return a.isData ? 1 : -1;
      return b.count - a.count || a.service.localeCompare(b.service);
    });
}

export function ResourcesTab({ resources }: ResourcesTabProps) {
  const [query, setQuery] = useState("");
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());

  const needle = query.trim().toLowerCase();

  const filtered = useMemo(() => {
    if (!needle) return resources;

    return resources.filter(
      (resource) =>
        resource.resourceType.toLowerCase().includes(needle) ||
        (resource.resourceName?.toLowerCase().includes(needle) ?? false) ||
        serviceOfResource(resource.resourceType, resource.providerName)
          .toLowerCase()
          .includes(needle),
    );
  }, [resources, needle]);

  const groups = useMemo(() => groupByService(filtered), [filtered]);
  const allGroups = useMemo(() => groupByService(resources), [resources]);

  const totalsByService = useMemo(
    () => new Map(allGroups.map((group) => [group.service, group.count])),
    [allGroups],
  );

  if (resources.length === 0) {
    return (
      <p className="rounded-lg border border-dashed py-12 text-center text-sm text-muted-foreground">
        No resources or data sources were found in this module.
      </p>
    );
  }

  function toggle(service: string) {
    setClosed((current) => {
      const next = new Set(current);
      if (!next.delete(service)) next.add(service);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      <SearchField
        onChange={setQuery}
        placeholder="Filter resources..."
        value={query}
      />

      {groups.length === 0 ? (
        <p className="rounded-lg border border-dashed py-12 text-center text-sm text-muted-foreground">
          No resources match the current filter.
        </p>
      ) : (
        groups.map((group) => (
          <FieldList
            collapsible
            key={group.service}
            onToggle={() => toggle(group.service)}
            open={!closed.has(group.service)}
            shown={group.count}
            title={group.service}
            total={totalsByService.get(group.service) ?? group.count}
          >
            {group.rows.length === 0 ? (
              <EmptyMessage>
                No resources match the current filter.
              </EmptyMessage>
            ) : (
              group.rows.map((row) => (
                <LinkRow
                  external
                  href={row.docsUrl}
                  key={row.key}
                  label={`Open the ${row.resourceType} documentation`}
                >
                  <div className="flex items-center gap-2">
                    <code className="font-mono text-sm font-medium">
                      {row.resourceType}
                    </code>

                    {row.count > 1 ? (
                      <Badge variant="secondary">{row.count}</Badge>
                    ) : null}
                  </div>

                  {row.names.length > 0 ? (
                    <p className="mt-1 break-words font-mono text-xs text-muted-foreground">
                      {row.names.join(", ")}
                    </p>
                  ) : null}

                  {row.description ? (
                    <p className="mt-1 text-sm text-muted-foreground">
                      {row.description}
                    </p>
                  ) : null}
                </LinkRow>
              ))
            )}
          </FieldList>
        ))
      )}
    </div>
  );
}
