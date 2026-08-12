"use client";

import { Badge } from "@terrablox/ui/badge";
import { ArrowUpRight, ExternalLink, Package, Workflow } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import type { ModuleDependent } from "@/lib/terraform/module-link";
import {
  CopyButton,
  EmptyMessage,
  FieldList,
  SearchField,
} from "./field-primitives";
import type { ModuleDependencyDto } from "./types";

interface DependenciesTabProps {
  dependencies: ModuleDependencyDto[];
  dependents?: ModuleDependent[];
  providers: { name: string; version: string | null }[];
}

/**
 * `sourceKind` is stored as a free-form string by the analyzer, so the labels
 * are looked up rather than switched on to keep unknown kinds renderable.
 */
const SOURCE_KIND_LABELS: Record<string, string> = {
  registry: "Registry",
  git: "Git",
  local: "Local",
  github: "GitHub",
  http: "HTTP",
};

function DependencyRow({ dependency }: { dependency: ModuleDependencyDto }) {
  const kindLabel =
    SOURCE_KIND_LABELS[dependency.sourceKind] ?? dependency.sourceKind;
  const link = dependency.linkedModule ?? null;

  return (
    <div className="group border-b px-4 py-3 last:border-b-0 hover:bg-muted/40">
      <div className="flex flex-wrap items-center gap-2">
        <code className="font-mono text-sm font-medium">{dependency.name}</code>
        <CopyButton
          label={`module ${dependency.name}`}
          value={dependency.name}
        />
        {dependency.version ? (
          <Badge variant="secondary">{dependency.version}</Badge>
        ) : null}
        <Badge variant="outline">{kindLabel}</Badge>

        <div className="ml-auto flex items-center gap-3">
          {link ? (
            <Link
              className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
              href={`/modules/${link.moduleId}`}
              title={
                link.exactVersion
                  ? `Open the imported module ${link.name}`
                  : `Version ${link.requestedRef} is not imported; opening ${link.versionTag ?? "the latest import"} instead`
              }
            >
              <ArrowUpRight className="h-3 w-3" />
              Open {link.name}
              {link.exactVersion ? null : (
                <span className="text-muted-foreground">
                  ({link.versionTag ?? "latest"})
                </span>
              )}
            </Link>
          ) : null}

          {dependency.registryUrl ? (
            <a
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
              href={dependency.registryUrl}
              rel="noreferrer"
              target="_blank"
            >
              <ExternalLink className="h-3 w-3" />
              Registry
            </a>
          ) : null}
        </div>
      </div>

      {dependency.source ? (
        <p className="mt-1.5 break-all font-mono text-xs text-muted-foreground">
          {dependency.source}
        </p>
      ) : null}
    </div>
  );
}

function DependentRow({ dependent }: { dependent: ModuleDependent }) {
  return (
    <Link
      className="flex items-center gap-3 border-b px-4 py-3 last:border-b-0 hover:bg-muted/40"
      href={`/modules/${dependent.moduleId}`}
    >
      <Workflow className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{dependent.name}</span>
          {dependent.versionTag ? (
            <Badge variant="secondary">{dependent.versionTag}</Badge>
          ) : null}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Calls this module as{" "}
          {dependent.calls.map((call, index) => (
            <span key={call.name}>
              {index > 0 ? ", " : null}
              <code className="font-mono">{call.name}</code>
              {call.exactVersion ? null : (
                <span> (asks for {call.requestedRef})</span>
              )}
            </span>
          ))}
        </p>
      </div>
      <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    </Link>
  );
}

export function DependenciesTab({
  dependencies,
  dependents,
  providers,
}: DependenciesTabProps) {
  const [query, setQuery] = useState("");

  const needle = query.trim().toLowerCase();
  const usedBy = dependents ?? [];

  const sorted = useMemo(
    () =>
      [...dependencies].sort((a, b) =>
        a.name.localeCompare(b.name, "en", { numeric: true }),
      ),
    [dependencies],
  );

  const filtered = useMemo(() => {
    if (!needle) return sorted;

    return sorted.filter(
      (d) =>
        d.name.toLowerCase().includes(needle) ||
        (d.source?.toLowerCase().includes(needle) ?? false),
    );
  }, [sorted, needle]);

  return (
    <div className="space-y-4">
      {providers.length > 0 ? (
        <div className="rounded-lg border bg-card p-4">
          <h4 className="mb-2 text-sm font-semibold">Required providers</h4>
          <div className="flex flex-wrap gap-2">
            {providers.map((p) => (
              <Badge key={p.name} variant="outline">
                {p.name}
                {p.version ? (
                  <span className="text-muted-foreground">{p.version}</span>
                ) : null}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}

      <SearchField
        onChange={setQuery}
        placeholder="Filter dependencies…"
        value={query}
      />

      <FieldList
        icon={<Package className="h-4 w-4" />}
        shown={filtered.length}
        title="Module calls"
        total={dependencies.length}
      >
        {filtered.length === 0 ? (
          <EmptyMessage>
            {dependencies.length === 0
              ? "This module does not call any other modules."
              : "No dependencies match the current filter."}
          </EmptyMessage>
        ) : (
          filtered.map((d) => (
            <DependencyRow
              dependency={d}
              key={`${d.sourceFile ?? ""}:${d.id}`}
            />
          ))
        )}
      </FieldList>

      {usedBy.length > 0 ? (
        <FieldList
          icon={<Workflow className="h-4 w-4" />}
          shown={usedBy.length}
          title="Used by"
          total={usedBy.length}
        >
          {usedBy.map((d) => (
            <DependentRow dependent={d} key={d.moduleId} />
          ))}
        </FieldList>
      ) : null}
    </div>
  );
}
