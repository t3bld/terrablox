import { resolveCatalogueEntry } from "@terrablox/catalogue";
import {
  bucketResourceTypes,
  type CostBucket,
} from "@terrablox/terraform/aws-cost-drivers";

import type { Stack } from "./stack.js";

/** A bucket as this server reports it: each resource says which call it came from. */
export type StackCostBucket = CostBucket<{ from: string }>;

/**
 * What a stack would bill for, grouped by how.
 *
 * No prices. The table behind this says what a resource type charges *for* — an hour of
 * existing, a gigabyte transferred, nothing at all — and turning that into an amount needs
 * a region, a size and a guess at traffic, none of which are in a module's interface. A
 * number would be more satisfying and would be invented, so what comes back is the shape
 * of the bill.
 *
 * The grouping, the order and the labels come from `@terrablox/terraform` because the
 * marketing site's cost tab needs the same three and used to define them again. What is
 * left here is the one thing only this server knows: which call a resource came from, so a
 * stack holding two copies of a module can say which one costs what.
 */
export function summariseCost(stack: Stack): StackCostBucket[] {
  const resources: Array<{ type: string; extra: { from: string } }> = [];

  for (const call of stack.calls) {
    const entry = resolveCatalogueEntry(call.module);
    if (!entry) continue;

    for (const type of entry.resources) {
      resources.push({ type, extra: { from: call.name } });
    }
  }

  const buckets = bucketResourceTypes(resources);

  // Sorted here rather than in the shared function: a stable order matters for reading a
  // list, and what to sort *by* is the caller's business — this one has a second key.
  for (const bucket of buckets) {
    bucket.resources.sort(
      (a, b) =>
        a.type.localeCompare(b.type) ||
        a.extra.from.localeCompare(b.extra.from),
    );
  }

  return buckets;
}
