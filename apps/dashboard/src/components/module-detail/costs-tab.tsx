"use client";

import { Badge } from "@terrablox/ui/badge";
import { cn } from "@terrablox/ui/lib/utils";
import { Box, ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";
import { InfoHint } from "@/components/info-hint";
import {
  COST_CLASS_HINTS,
  COST_CLASS_LABELS,
  type CostClass,
  type CostDriverEntry,
  resolveCostDriver,
} from "@/lib/terraform/aws-cost-drivers";
import { iconOfService, serviceOfResource } from "@/lib/terraform/aws-services";
import {
  isConventionalResourceName,
  sortResourceNames,
} from "@/lib/terraform/resource-label";
import { ResourceNames } from "./field-primitives";
import type { ModuleResourceDto, ModuleVariableDto } from "./types";

interface CostsTabProps {
  resources: ModuleResourceDto[];
  variables: ModuleVariableDto[];
}

/** `unclassified` is not a `CostClass`: it means the table has no answer yet. */
type Bucket = CostClass | "unclassified";

/**
 * One card per resource *type*, like the Resources tab.
 *
 * Two `aws_instance` blocks raise the same cost question once, so two cards
 * repeating the same sentence would only push the rest of the module off the
 * screen. How many there are still matters, so the count stays on the card.
 */
interface CostCard {
  key: string;
  bucket: Bucket;
  resourceType: string;
  service: string;
  icon: string | undefined;
  names: string[];
  count: number;
  entry: CostDriverEntry | null;
  /** Inputs of this module that decide how much of this resource is billed. */
  inputs: CardInput[];
}

/**
 * An input of this module that sizes the resource on the card it sits under.
 *
 * On the card rather than in a list of its own, which is where these used to
 * live. `subnet_ids` on a page by itself says nothing — the reader has to know
 * that an interface endpoint bills per subnet before the name means anything, and
 * the sentence that says so was on a different block. Beneath that sentence it
 * reads as what it is: the number that multiplies this charge.
 */
interface CardInput {
  name: string;
  /** The default as written, or null when the module demands a value. */
  value: string | null;
  required: boolean;
}

/**
 * Whether a variable name contains a driver fragment as whole segments.
 *
 * The fragments in the cost table are written loosely on purpose — module authors
 * name the same thing `instance_type` and `node_instance_type` — but matching them
 * with a plain substring test caught names that merely shared letters. Comparing
 * `_`-separated segments keeps `node_instance_type` and rejects a fragment landing
 * in the middle of a word.
 *
 * It does not solve the problem: `cpu` still matches `cpu_credits`, which is not a
 * cost driver, because both are the segment `cpu`. Telling those apart needs the
 * table to name inputs exactly, one entry at a time.
 */
function matchesDriverFragment(
  variableName: string,
  fragment: string,
): boolean {
  const segments = variableName
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const wanted = fragment
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  if (wanted.length === 0 || wanted.length > segments.length) return false;

  for (let start = 0; start + wanted.length <= segments.length; start += 1) {
    if (wanted.every((part, offset) => segments[start + offset] === part)) {
      return true;
    }
  }

  return false;
}

const BUCKET_ORDER: readonly Bucket[] = [
  "recurring",
  "usage",
  "unclassified",
  "free",
];

/**
 * Amber marks the resources that bill whether or not anyone uses them — not a
 * warning, but the one class a reader must look at before deploying.
 */
const BUCKET_STYLE: Record<Bucket, { dot: string; bar: string }> = {
  recurring: { dot: "bg-amber-500", bar: "bg-amber-500" },
  usage: { dot: "bg-sky-500", bar: "bg-sky-500" },
  unclassified: {
    dot: "border border-muted-foreground/60",
    bar: "bg-muted-foreground/20",
  },
  free: { dot: "bg-muted-foreground/40", bar: "bg-muted-foreground/40" },
};

const BUCKET_LABELS: Record<Bucket, string> = {
  ...COST_CLASS_LABELS,
  unclassified: "Not classified",
};

const BUCKET_HINTS: Record<Bucket, string> = {
  ...COST_CLASS_HINTS,
  unclassified:
    "Not in the cost table yet, so they are reported rather than assumed free.",
};

/** Scalars read as a value; objects and lists only add noise beside a name. */
function scalarDefault(value: unknown): string | null {
  if (typeof value === "string") return value === "" ? null : value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return null;
}

function bucketOf(entry: CostDriverEntry | null): Bucket {
  return entry?.costClass ?? "unclassified";
}

function ServiceIcon({ icon }: { icon: string | undefined }) {
  if (!icon) {
    return (
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
        <Box className="h-4 w-4 text-muted-foreground" />
      </div>
    );
  }

  return (
    // biome-ignore lint/performance/noImgElement: the AWS icons are vendored SVGs, which next/image passes through unchanged
    <img alt="" className="h-8 w-8 shrink-0" src={`/aws-icons/${icon}.svg`} />
  );
}

function BucketDot({ bucket }: { bucket: Bucket }) {
  return (
    <span
      className={cn("h-2 w-2 shrink-0 rounded-full", BUCKET_STYLE[bucket].dot)}
    />
  );
}

export function CostsTab({ resources, variables }: CostsTabProps) {
  const [showFree, setShowFree] = useState(false);

  // Data sources read what already exists, so they create nothing to bill for.
  const managed = useMemo(
    () => resources.filter((resource) => resource.kind !== "data"),
    [resources],
  );

  /** Resource counts per bucket — the composition the summary bar draws. */
  const totals = useMemo(() => {
    const counts: Record<Bucket, number> = {
      recurring: 0,
      usage: 0,
      free: 0,
      unclassified: 0,
    };

    for (const resource of managed) {
      counts[bucketOf(resolveCostDriver(resource.resourceType))] += 1;
    }

    return counts;
  }, [managed]);

  const cards = useMemo<CostCard[]>(() => {
    const byType = new Map<string, CostCard>();

    for (const resource of managed) {
      const existing = byType.get(resource.resourceType);
      if (existing) {
        existing.count += 1;
        // Conventions included; see the pass below for why the decision to hide
        // a label cannot be made before the block count is known.
        const name = resource.resourceName?.trim();
        if (name) existing.names.push(name);
        continue;
      }

      const entry = resolveCostDriver(resource.resourceType);
      const bucket = bucketOf(entry);
      const service = serviceOfResource(
        resource.resourceType,
        resource.providerName,
      );

      // Nothing free has an amount to size, and the free bucket is drawn as
      // chips rather than cards, so there is nowhere to put them anyway.
      const inputs: CardInput[] =
        bucket === "free" || !entry?.sizedBy
          ? []
          : variables
              .filter((variable) =>
                entry.sizedBy?.some((fragment) =>
                  matchesDriverFragment(variable.name, fragment),
                ),
              )
              .map((variable) => ({
                name: variable.name,
                value: scalarDefault(variable.default),
                required: variable.required ?? false,
              }));

      byType.set(resource.resourceType, {
        key: resource.resourceType,
        bucket,
        resourceType: resource.resourceType,
        service,
        icon: iconOfService(service),
        names: (() => {
          const name = resource.resourceName?.trim();
          return name ? [name] : [];
        })(),
        count: 1,
        entry,
        inputs,
      });
    }

    for (const card of byType.values()) {
      card.names = sortResourceNames(card.names);

      // `this` under a card that stands for one block says nothing the type has
      // not said. Under a card badged `2` it is one of the two blocks, and
      // leaving it out made the card contradict its own count.
      const only = card.count === 1 ? card.names[0] : undefined;
      if (only && isConventionalResourceName(only)) card.names = [];
    }

    return [...byType.values()].sort((a, b) =>
      a.service.localeCompare(b.service, "en", { numeric: true }),
    );
  }, [managed, variables]);

  if (managed.length === 0) {
    return (
      <p className="rounded-lg border border-dashed py-12 text-center text-sm text-muted-foreground">
        This module creates no resources, so it adds nothing to a bill.
      </p>
    );
  }

  const freeCards = cards.filter((card) => card.bucket === "free");

  return (
    <div className="space-y-6">
      {/* No summary panel. It restated the four bucket counts that each section
          already shows beside its own heading, plus a bar of resource counts that
          invites being read as a share of a bill — which is the one thing this
          tab cannot know. Four numbers repeated twice is not a summary. */}

      {/* No separate block of driving inputs. It listed variable names away from
          the sentence that explains what they multiply, which made a name like
          `subnet_ids` a riddle — the reader had to already know that an interface
          endpoint bills per subnet. Each input now sits under that sentence, on
          the card for the resource it sizes. */}

      {BUCKET_ORDER.filter((bucket) => bucket !== "free").map((bucket) => {
        const group = cards.filter((card) => card.bucket === bucket);
        if (group.length === 0) return null;

        return (
          <section key={bucket}>
            <div className="flex items-center gap-2">
              <BucketDot bucket={bucket} />
              <h3 className="text-sm font-semibold">{BUCKET_LABELS[bucket]}</h3>
              <InfoHint label={BUCKET_LABELS[bucket]}>
                {BUCKET_HINTS[bucket]}
              </InfoHint>
              <span className="text-xs tabular-nums text-muted-foreground">
                {totals[bucket]}
              </span>
            </div>

            <div className="mt-3 grid gap-3 lg:grid-cols-3">
              {group.map((card) => (
                <div className="rounded-lg border bg-card p-3.5" key={card.key}>
                  <div className="flex items-start gap-3">
                    <ServiceIcon icon={card.icon} />

                    {/* The type leads, the service follows. Both were here
                        before with the service as the headline, which read as a
                        card about EC2 rather than about `aws_eip` — and the type
                        is what the reader came to look up, what the cost note
                        below is about, and what they search the AWS pricing page
                        for. The service is context for it. */}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <code className="break-all font-mono text-sm font-medium">
                          {card.resourceType}
                        </code>
                        {card.count > 1 ? (
                          <Badge variant="secondary">{card.count}</Badge>
                        ) : null}
                      </div>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {card.service}
                      </span>
                    </div>
                  </div>

                  <p
                    className={cn(
                      "mt-3 text-sm",
                      card.entry?.driver ? null : "text-muted-foreground",
                    )}
                  >
                    {card.entry?.driver ??
                      "No entry in the cost table yet — check the AWS pricing page for this resource before assuming it is free."}
                  </p>

                  {/* What you pass in, directly under what it costs. "required"
                      says the module will not plan without a value — not that the
                      value is expensive, which is how the old wording read. */}
                  {card.inputs.length > 0 ? (
                    <dl className="mt-3 space-y-1 border-t pt-2.5">
                      {card.inputs.map((input) => (
                        <div
                          className="flex flex-wrap items-baseline gap-x-2"
                          key={input.name}
                        >
                          <dt className="font-mono text-xs font-medium">
                            {input.name}
                          </dt>
                          <dd className="text-xs text-muted-foreground">
                            {input.value !== null ? (
                              <code className="font-mono">= {input.value}</code>
                            ) : input.required ? (
                              "you must set this"
                            ) : (
                              "no default"
                            )}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}

                  <ResourceNames
                    className="mt-2 break-all"
                    names={card.names}
                    resourceType={card.resourceType}
                  />
                </div>
              ))}
            </div>
          </section>
        );
      })}

      {freeCards.length > 0 ? (
        <section>
          {/* Reference, not a finding: chips rather than cards, so the long
              tail of policies and attachments cannot crowd out the rest. */}
          {/* Same order as every other bucket heading — dot, title, hint, count —
              with the toggle in between. The hint used to be pushed to the far
              right because the whole row was one button and a button cannot
              contain another; so the toggle is now just the chevron. */}
          <div className="flex items-center gap-2">
            <BucketDot bucket="free" />
            <h3 className="text-sm font-semibold">{BUCKET_LABELS.free}</h3>

            <InfoHint label={BUCKET_LABELS.free}>{BUCKET_HINTS.free}</InfoHint>

            <button
              aria-expanded={showFree}
              aria-label={
                showFree
                  ? `Hide the ${BUCKET_LABELS.free} resources`
                  : `Show the ${BUCKET_LABELS.free} resources`
              }
              className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => setShowFree((value) => !value)}
              type="button"
            >
              <ChevronDown
                className={cn(
                  "h-4 w-4 transition-transform",
                  showFree && "rotate-180",
                )}
              />
            </button>

            <span className="text-xs tabular-nums text-muted-foreground">
              {totals.free}
            </span>
          </div>

          {showFree ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {freeCards.map((card) => (
                <code
                  className="rounded bg-muted px-2 py-1 font-mono text-xs text-muted-foreground"
                  key={card.key}
                >
                  {card.resourceType}
                  {card.count > 1 ? (
                    <span className="ml-1 opacity-70">×{card.count}</span>
                  ) : null}
                </code>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
