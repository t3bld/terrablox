import {
  CATALOGUE_ENTRIES,
  type CatalogueArchitecture,
  type CatalogueEntry,
} from "@terrablox/catalogue";
import type { ArchitectureDiagramNode } from "@terrablox/graph";
import {
  bucketResourceTypes,
  type CostBucketKey,
} from "@terrablox/terraform/aws-cost-drivers";
import {
  iconOfService,
  serviceOfResource,
} from "@terrablox/terraform/aws-services";

/**
 * The module catalogue as the public pages read it: the site's half of it.
 *
 * The snapshot and the lookups over it moved to `@terrablox/catalogue` once the MCP
 * server needed them too, and a package may not import from an app. What stayed here is
 * what only a page wants — the bucket colours, the diagram's own node shape, the
 * narrowing the grid needs — because presentation in a data package is how a data
 * package stops being one.
 *
 * The cost classification is computed here rather than read from the snapshot, and that
 * asymmetry is deliberate: it is a table in `@terrablox/terraform`, the same one the
 * dashboard reads, so a module's resources are classified at build time instead of being
 * frozen into the file. Change the table, rebuild the site, and the pages agree with the
 * product without regenerating anything.
 */

export type {
  CatalogueArchitecture,
  CatalogueEntry,
  CataloguePort,
} from "@terrablox/catalogue";
export {
  catalogueSlugs,
  findCatalogueEntry,
  repoHomeUrl,
  repoName,
  repoUrl,
  sortedInputs,
} from "@terrablox/catalogue";

/**
 * The layout's nodes in the shape the diagram component takes.
 *
 * A translation, not a widening: the projection calls a container's kind `type`, the
 * diagram calls it `frame` and accepts a narrower set; an attachment carries the
 * addresses it folded together, and the diagram only ever shows how many there were.
 * The dashboard performs the same mapping inline in its architecture tab, which is
 * why this exists here rather than in the snapshot — generated data should not carry
 * a component's view of itself.
 *
 * The dashboard's version also fills in expansion state and links to nested modules.
 * Neither applies here: these pages draw one module at a time and nothing is
 * expandable, so those fields are deliberately left unset rather than faked.
 */
export function toDiagramNodes(
  architecture: CatalogueArchitecture,
): ArchitectureDiagramNode[] {
  return architecture.nodes.map((node) => ({
    id: node.id,
    frame:
      node.type === "vpc"
        ? ("vpc" as const)
        : node.type === "module"
          ? ("module" as const)
          : node.type === "subnet"
            ? node.icon === "subnet-public"
              ? ("subnet-public" as const)
              : ("subnet-private" as const)
            : null,
    label: node.label,
    sublabel: node.sublabel,
    icon: node.icon,
    count: node.addresses.length,
    zone: node.zone,
    attachments: node.attachments?.map((attachment) => ({
      service: attachment.service,
      icon: attachment.icon,
      count: attachment.addresses.length,
    })),
    moduleCall: node.isModuleCall,
    parentId: node.parentId,
    position: node.position,
    width: node.width,
    height: node.height,
  }));
}

export interface CostResource {
  type: string;
  /** What the amount scales with, in the terms AWS bills in. */
  driver: string | null;
  /** The AWS service this type belongs to, for grouping and for the icon. */
  service: string;
  icon: string | undefined;
}

export interface CostBucket {
  /** `unclassified` is not a cost class; it is the absence of one. */
  costClass: CostBucketKey;
  label: string;
  hint: string;
  /** Tailwind class for the dot, matching the dashboard's own palette. */
  dot: string;
  resources: CostResource[];
}

/**
 * The dot colours, which are the only part of this the site still owns.
 *
 * The order, the labels and the hints moved to `@terrablox/terraform` once the MCP
 * server's stack review needed the same three and had defined them a second time — two
 * copies of a bucket order is the kind of duplication nobody notices until they disagree
 * about whether NAT gateways are recurring. Colours stayed: a Tailwind class in a data
 * package is how a data package stops being one.
 *
 * Amber marks what bills whether or not anyone uses it — the one class a reader has to
 * look at before deploying.
 */
const BUCKET_DOT: Record<CostBucketKey, string> = {
  recurring: "bg-amber-500",
  usage: "bg-sky-500",
  unclassified: "border border-muted-foreground/60",
  free: "bg-muted-foreground/40",
};

/**
 * A module's resources grouped by what they do to a bill.
 *
 * Ordered `recurring`, `usage`, `free`, which is the order of consequence rather
 * than the alphabet: what a module costs for merely existing is the fact worth
 * reading first, and the free list is the longest and least interesting.
 *
 * Unclassified types are their own group rather than being folded into `free`. The
 * table's own comment is explicit about why: a wrong "no cost" is the one error here
 * that actually misleads.
 */
export function costBuckets(entry: CatalogueEntry): CostBucket[] {
  // The AWS service is attached here and carried through the shared grouping untouched:
  // it is what this page sorts by and draws an icon from, and the grouping has no reason
  // to know that.
  const buckets = bucketResourceTypes(
    entry.resources.map((type) => {
      // Every catalogue resource is an `aws_*` type, and the provider name is only
      // consulted for the ones that are not.
      const service = serviceOfResource(type, "aws");
      return { type, extra: { service, icon: iconOfService(service) } };
    }),
  );

  return buckets.map((bucket) => ({
    costClass: bucket.key,
    label: bucket.label,
    hint: bucket.hint,
    dot: BUCKET_DOT[bucket.key],
    resources: bucket.resources
      .map((resource) => ({
        type: resource.type,
        driver: resource.driver,
        service: resource.extra.service,
        icon: resource.extra.icon,
      }))
      .sort(
        (a, b) =>
          a.service.localeCompare(b.service) || a.type.localeCompare(b.type),
      ),
  }));
}

export interface ServiceGroup {
  service: string;
  icon: string | undefined;
  types: string[];
}

/**
 * A module's resource types, gathered under the AWS service each belongs to.
 *
 * The Costs tab groups the same list by what it bills for, which answers "what will
 * this cost". This grouping answers a different question — "what is in here" — and a
 * flat list of thirty-two `aws_*` strings answers neither. Both read
 * `serviceOfResource`, so a type cannot be filed under one service on one tab and
 * another on the next.
 *
 * Largest group first: the service a module is mostly made of is the one a reader is
 * looking for, and for the VPC module that is thirty-odd networking types ahead of a
 * single log group.
 */
export function serviceGroups(entry: CatalogueEntry): ServiceGroup[] {
  const grouped = new Map<string, string[]>();
  for (const type of entry.resources) {
    // Second argument is the fallback for a non-`aws_` type; the catalogue only
    // holds AWS resources, and `costBuckets` passes the same thing.
    const service = serviceOfResource(type, "aws");
    const list = grouped.get(service) ?? [];
    list.push(type);
    grouped.set(service, list);
  }

  return [...grouped.entries()]
    .map(([service, types]) => ({
      service,
      icon: iconOfService(service),
      types: [...types].sort((a, b) => a.localeCompare(b)),
    }))
    .sort(
      (a, b) =>
        b.types.length - a.types.length || a.service.localeCompare(b.service),
    );
}

/**
 * The catalogue narrowed to what a grid tile draws.
 *
 * Here rather than inline at each call site because the narrowing is the point: the
 * grid is a client component, so anything handed to it is serialised into the page.
 * Passing entries would put the ports, resource types and laid-out diagrams of fifty
 * modules — around 660 KB — into the HTML in order to render fifty names.
 */
export function moduleTiles(): Array<{
  slug: string;
  name: string;
  icon: string | null;
}> {
  return CATALOGUE_ENTRIES.map((entry) => ({
    slug: entry.slug,
    name: entry.name,
    icon: entry.icon,
  }));
}
