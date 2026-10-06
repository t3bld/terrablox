import { Box } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ModuleDetail } from "@/components/module-detail";
import { asset } from "@/lib/assets";
import {
  catalogueSlugs,
  costBuckets,
  findCatalogueEntry,
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
    title: `${entry.name} costs`,
    description: `Which resources the ${entry.name} module creates that bill for existing, and which are priced by usage.`,
  };
}

/** The Costs tab: which resources bill, grouped the way the dashboard groups them. */
export default function ModuleCostsPage({
  params,
}: {
  params: { slug: string };
}) {
  const entry = findCatalogueEntry(params.slug);
  if (!entry) notFound();

  const buckets = costBuckets(entry);

  return (
    <ModuleDetail entry={entry} tab="costs">
      {buckets.length === 0 ? (
        <div className="rounded-lg border bg-muted/20 p-6">
          <h2 className="font-medium text-sm">No resources to price</h2>
          <p className="mt-2 max-w-xl text-muted-foreground text-sm leading-relaxed">
            This module declares no resources at the root of the repository.
            {entry.submodules.length > 0
              ? " Its submodules do, and each is priced on its own page."
              : ""}
          </p>
        </div>
      ) : (
        <div className="space-y-8">
          {buckets.map((bucket) => (
            <section key={bucket.costClass}>
              <div className="flex items-center gap-2">
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${bucket.dot}`}
                />
                <h2 className="font-semibold text-sm">{bucket.label}</h2>
                <span className="text-muted-foreground text-xs">
                  {bucket.resources.length}
                </span>
              </div>

              <p className="mt-1 max-w-2xl text-muted-foreground text-xs leading-relaxed">
                {bucket.hint}
              </p>

              <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                {bucket.resources.map((resource) => (
                  <li
                    className="flex items-start gap-3 rounded-lg border p-3"
                    key={resource.type}
                  >
                    {resource.icon ? (
                      // biome-ignore lint/performance/noImgElement: a vendored SVG at a fixed size on a static host; next/image would pass it through untouched.
                      <img
                        alt=""
                        className="h-8 w-8 shrink-0"
                        src={asset(`/aws-icons/${resource.icon}.svg`)}
                      />
                    ) : (
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
                        <Box className="h-4 w-4 text-muted-foreground" />
                      </span>
                    )}

                    <div className="min-w-0">
                      <p className="font-medium text-sm">{resource.service}</p>
                      <code className="block truncate font-mono text-muted-foreground text-xs">
                        {resource.type}
                      </code>
                      {resource.driver ? (
                        <p className="mt-1 text-muted-foreground text-xs leading-relaxed">
                          {resource.driver}
                        </p>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </ModuleDetail>
  );
}
