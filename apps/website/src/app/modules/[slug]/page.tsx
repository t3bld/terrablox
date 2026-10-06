import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ModuleArchitecture } from "@/components/module-architecture";
import { ModuleDetail } from "@/components/module-detail";
import { asset } from "@/lib/assets";
import { catalogueSlugs, findCatalogueEntry } from "@/lib/catalogue";

export function generateStaticParams(): { slug: string }[] {
  return catalogueSlugs().map((slug) => ({ slug }));
}

export function generateMetadata({
  params,
}: {
  params: { slug: string };
}): Metadata {
  const entry = findCatalogueEntry(params.slug);
  if (!entry) return {};

  return {
    title: entry.name,
    description:
      entry.description ??
      `The ${entry.name} module in the Terrablox library, pinned to ${entry.version}.`,
  };
}

/** The Architecture tab: what this module deploys, as the product draws it. */
export default function ModuleArchitecturePage({
  params,
}: {
  params: { slug: string };
}) {
  const entry = findCatalogueEntry(params.slug);
  if (!entry) notFound();

  return (
    <ModuleDetail entry={entry} tab="architecture">
      {entry.architecture ? (
        <ModuleArchitecture
          architecture={entry.architecture}
          iconBasePath={asset("/aws-icons")}
        />
      ) : (
        <div className="rounded-lg border bg-muted/20 p-6">
          <h2 className="font-medium text-sm">Nothing to draw</h2>
          <p className="mt-2 max-w-xl text-muted-foreground text-sm leading-relaxed">
            {entry.submodules.length > 0
              ? "This repository is a collection rather than a single module: its root declares no resources of its own, and each submodule is a module in its own right. Terrablox imports all of them, so they appear individually in the library."
              : "This module declares no resources at the root of the repository, so there is no architecture to project."}
          </p>

          {entry.submodules.length > 0 ? (
            <ul className="mt-4 flex flex-wrap gap-1.5">
              {entry.submodules.map((name) => (
                <li key={name}>
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                    {name}
                  </code>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </ModuleDetail>
  );
}
