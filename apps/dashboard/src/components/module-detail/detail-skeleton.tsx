import { Skeleton } from "@terrablox/ui/skeleton";

const INFO_FIELDS = ["version", "repository", "folder", "tags"];
const TABS = [
  "readme",
  "variables",
  "dependencies",
  "architecture",
  "connections",
  "resources",
  "source",
];

/**
 * Placeholder for the module detail body.
 *
 * Shared by the route-level `loading.tsx` and the in-page fetch state: the two
 * phases follow each other directly, so a differing layout would read as a
 * flicker rather than as continued loading.
 */
export function ModuleDetailSkeleton() {
  return (
    <div className="space-y-4">
      <section className="rounded-lg border bg-card p-4">
        <Skeleton className="h-6 w-64 max-w-full" />
        <Skeleton className="mt-2 h-4 w-96 max-w-full" />

        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {INFO_FIELDS.map((field) => (
            <div className="space-y-2" key={field}>
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-4 w-28" />
            </div>
          ))}
        </div>
      </section>

      <div className="flex items-center gap-4 border-b pb-2">
        {TABS.map((tab) => (
          <Skeleton className="h-4 w-20" key={tab} />
        ))}
      </div>

      <Skeleton className="h-64 w-full" />
    </div>
  );
}
