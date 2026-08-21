"use client";

import { Badge } from "@terrablox/ui/badge";
import { useMemo, useState } from "react";

import type { ModuleDependent } from "@/lib/terraform/module-link";
import {
  EmptyMessage,
  FieldList,
  LinkRow,
  SearchField,
} from "./field-primitives";
import type { ModuleDependencyDto } from "./types";

interface DependenciesTabProps {
  dependencies: ModuleDependencyDto[];
  dependents?: ModuleDependent[];
  providers: {
    name: string;
    version: string | null;
    docsUrl?: string | null;
  }[];
}

function githubRepositoryUrl(source: string | null): string | null {
  if (!source) return null;

  const raw = source.trim().replace(/^git::/, "");
  try {
    const url = new URL(raw);
    if (url.hostname !== "github.com" && url.hostname !== "www.github.com") {
      return null;
    }

    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\.git(?:\/.*)?\/?$/, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function DependencyRow({ dependency }: { dependency: ModuleDependencyDto }) {
  const link = dependency.linkedModule ?? null;
  // The imported copy is the useful destination; the repository and the
  // registry only stand in when this module was never imported here.
  const fallbackUrl =
    githubRepositoryUrl(dependency.source) ?? dependency.registryUrl;

  return (
    <LinkRow
      external={!link}
      href={link ? `/modules/${link.moduleId}` : fallbackUrl}
      label={
        link ? `Open ${link.name}` : `Open the source of ${dependency.name}`
      }
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <code className="font-mono text-sm font-medium">{dependency.name}</code>
        {dependency.version ? (
          <Badge variant="secondary">{dependency.version}</Badge>
        ) : null}
        {link && !link.exactVersion ? (
          <span className="text-xs text-muted-foreground">
            imported as {link.versionTag ?? "latest"}
          </span>
        ) : null}
      </div>

      {dependency.source ? (
        <p className="mt-1.5 break-all font-mono text-xs text-muted-foreground">
          {dependency.source}
        </p>
      ) : null}
    </LinkRow>
  );
}

function DependentRow({ dependent }: { dependent: ModuleDependent }) {
  const requestedRefs = [
    ...new Set(
      dependent.calls.map((call) => call.requestedRef ?? "unversioned"),
    ),
  ];

  return (
    <LinkRow
      href={`/modules/${dependent.moduleId}`}
      label={`Open ${dependent.name}`}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{dependent.name}</span>
        {requestedRefs.map((ref) => (
          <Badge key={ref} variant="secondary">
            {ref}
          </Badge>
        ))}
      </div>
    </LinkRow>
  );
}

export function DependenciesTab({
  dependencies,
  dependents,
  providers,
}: DependenciesTabProps) {
  const [query, setQuery] = useState("");
  const [showProviders, setShowProviders] = useState(true);
  const [showDependencies, setShowDependencies] = useState(true);
  const [showDependents, setShowDependents] = useState(true);

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

  const filteredProviders = useMemo(() => {
    if (!needle) return providers;

    return providers.filter(
      (provider) =>
        provider.name.toLowerCase().includes(needle) ||
        (provider.version?.toLowerCase().includes(needle) ?? false),
    );
  }, [providers, needle]);

  const filteredDependents = useMemo(() => {
    if (!needle) return usedBy;

    return usedBy.filter(
      (dependent) =>
        dependent.name.toLowerCase().includes(needle) ||
        (dependent.versionTag?.toLowerCase().includes(needle) ?? false) ||
        dependent.calls.some(
          (call) =>
            call.name.toLowerCase().includes(needle) ||
            (call.requestedRef?.toLowerCase().includes(needle) ?? false),
        ),
    );
  }, [usedBy, needle]);

  // Every section here is hidden when it is empty, so a module that declares
  // none of the three would otherwise leave a search box sitting over nothing.
  if (
    providers.length === 0 &&
    dependencies.length === 0 &&
    usedBy.length === 0
  ) {
    return (
      <p className="flex min-h-[12rem] items-center justify-center rounded-lg border border-dashed bg-muted/20 px-4 text-center text-muted-foreground text-sm">
        This module requires no providers, calls no other modules, and nothing
        imported here calls it.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <SearchField
        onChange={setQuery}
        placeholder="Filter providers and modules"
        value={query}
      />

      {providers.length > 0 ? (
        <FieldList
          collapsible
          onToggle={() => setShowProviders((open) => !open)}
          open={showProviders}
          shown={filteredProviders.length}
          title="Providers"
          total={providers.length}
        >
          {filteredProviders.length === 0 ? (
            <EmptyMessage>No providers match the current filter.</EmptyMessage>
          ) : (
            filteredProviders.map((provider) => (
              <LinkRow
                external
                href={provider.docsUrl}
                key={provider.name}
                label={`Open the ${provider.name} provider documentation`}
              >
                <div className="flex items-center gap-3">
                  <span className="font-mono text-sm font-medium">
                    {provider.name}
                  </span>
                  {provider.version ? (
                    <Badge variant="secondary">{provider.version}</Badge>
                  ) : null}
                </div>
              </LinkRow>
            ))
          )}
        </FieldList>
      ) : null}

      {dependencies.length > 0 ? (
        <FieldList
          collapsible
          onToggle={() => setShowDependencies((open) => !open)}
          open={showDependencies}
          shown={filtered.length}
          title="Modules"
          total={dependencies.length}
        >
          {filtered.length === 0 ? (
            <EmptyMessage>
              No dependencies match the current filter.
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
      ) : null}

      {usedBy.length > 0 ? (
        <FieldList
          collapsible
          onToggle={() => setShowDependents((open) => !open)}
          open={showDependents}
          shown={filteredDependents.length}
          title="Used by"
          total={usedBy.length}
        >
          {filteredDependents.length === 0 ? (
            <EmptyMessage>No modules match the current filter.</EmptyMessage>
          ) : (
            filteredDependents.map((d) => (
              <DependentRow dependent={d} key={d.moduleId} />
            ))
          )}
        </FieldList>
      ) : null}
    </div>
  );
}
