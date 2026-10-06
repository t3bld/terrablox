import { Box } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ModuleDetail } from "@/components/module-detail";
import { asset } from "@/lib/assets";
import {
  catalogueSlugs,
  findCatalogueEntry,
  serviceGroups,
} from "@/lib/catalogue";

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
    title: `${entry.name} resources`,
    description: `Every AWS resource type the ${entry.name} module declares, grouped by service, at ${entry.version}.`,
  };
}

/**
 * The Resources tab: what the module is actually made of.
 *
 * Resource *types*, not instances. How many of each gets created is decided by inputs
 * at deploy time — `count`, `for_each`, a list of subnets — so a number here would be
 * a guess dressed as a fact. The architecture tab shows instances for one plausible
 * set of inputs; this is the complete vocabulary.
 *
 * Submodules are on this page rather than under a "Dependencies" heading, and the copy
 * says why: the dashboard's Dependencies tab lists the other modules a module calls,
 * its dependents, and its providers, and the committed snapshot carries none of that.
 * Filing submodules under that word would answer a question the data cannot.
 */
export default function ModuleResourcesPage({
  params,
}: {
  params: { slug: string };
}) {
  const entry = findCatalogueEntry(params.slug);
  if (!entry) notFound();

  const groups = serviceGroups(entry);
  const services = groups.length;

  return (
    <ModuleDetail entry={entry} tab="resources">
      {groups.length === 0 ? (
        <div className="rounded-lg border bg-muted/20 p-6">
          <h2 className="font-medium text-sm">No resources at the root</h2>
          <p className="mt-2 max-w-xl text-muted-foreground text-sm leading-relaxed">
            {entry.submodules.length > 0
              ? "This repository is a collection: its root declares nothing, and the resources live in the submodules listed below."
              : "This module declares no resources of its own."}
          </p>
        </div>
      ) : (
        <section>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="font-semibold text-sm">Resource types</h2>
            <p className="text-muted-foreground text-xs">
              {entry.resources.length} across{" "}
              {services === 1 ? "one service" : `${services} services`}
            </p>
          </div>

          <ul className="mt-3 space-y-2">
            {groups.map((group) => (
              <li
                className="flex items-start gap-3 rounded-lg border p-3"
                key={group.service}
              >
                {group.icon ? (
                  // biome-ignore lint/performance/noImgElement: a vendored SVG at a fixed size on a static host; next/image would pass it through untouched.
                  <img
                    alt=""
                    className="h-8 w-8 shrink-0"
                    src={asset(`/aws-icons/${group.icon}.svg`)}
                  />
                ) : (
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
                    <Box className="h-4 w-4 text-muted-foreground" />
                  </span>
                )}

                <div className="min-w-0 flex-1">
                  <p className="flex items-baseline gap-2 font-medium text-sm">
                    {group.service}
                    <span className="font-normal text-muted-foreground text-xs tabular-nums">
                      {group.types.length}
                    </span>
                  </p>

                  <ul className="mt-1.5 flex flex-wrap gap-1.5">
                    {group.types.map((type) => (
                      <li key={type}>
                        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.7rem]">
                          {type}
                        </code>
                      </li>
                    ))}
                  </ul>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-10">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="font-semibold text-sm">Submodules</h2>
          <p className="text-muted-foreground text-xs">
            {entry.submodules.length}
          </p>
        </div>

        {entry.submodules.length === 0 ? (
          <p className="mt-3 rounded-lg border bg-muted/20 p-4 text-muted-foreground text-sm leading-relaxed">
            A single module, with nothing nested inside it.
          </p>
        ) : (
          <>
            <p className="mt-1 max-w-2xl text-muted-foreground text-xs leading-relaxed">
              Nested modules in the same repository. Terrablox imports each one
              separately, so they appear in the library in their own right and
              the agent can place one without the others.
            </p>

            <ul className="mt-3 flex flex-wrap gap-1.5">
              {entry.submodules.map((name) => (
                <li key={name}>
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                    {name}
                  </code>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </ModuleDetail>
  );
}
