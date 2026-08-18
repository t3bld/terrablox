"use client";

import { Badge } from "@terrablox/ui/badge";
import { cn } from "@terrablox/ui/lib/utils";
import { Box, ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";

import {
  COST_CLASS_HINTS,
  COST_CLASS_LABELS,
  type CostClass,
  type CostDriverEntry,
  resolveCostDriver,
} from "@/lib/terraform/aws-cost-drivers";
import { iconOfService, serviceOfResource } from "@/lib/terraform/aws-services";
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
}

/** An input that sizes at least one billable resource. */
interface SizingInput {
  name: string;
  value: string | null;
  required: boolean;
  /** Resource types it was matched against, shown as the card's subtitle. */
  drives: string[];
}

function isUsefulResourceName(name: string): boolean {
  return name.toLowerCase() !== "main";
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
        if (
          resource.resourceName &&
          isUsefulResourceName(resource.resourceName)
        ) {
          existing.names.push(resource.resourceName);
        }
        continue;
      }

      const entry = resolveCostDriver(resource.resourceType);
      const service = serviceOfResource(
        resource.resourceType,
        resource.providerName,
      );

      byType.set(resource.resourceType, {
        key: resource.resourceType,
        bucket: bucketOf(entry),
        resourceType: resource.resourceType,
        service,
        icon: iconOfService(service),
        names:
          resource.resourceName && isUsefulResourceName(resource.resourceName)
            ? [resource.resourceName]
            : [],
        count: 1,
        entry,
      });
    }

    return [...byType.values()].sort((a, b) =>
      a.service.localeCompare(b.service, "en", { numeric: true }),
    );
  }, [managed]);

  /**
   * The inputs that decide the amount, gathered once instead of repeated under
   * every card. This is the part a reader can act on: the resources are fixed
   * by the module, these are not.
   */
  const sizingInputs = useMemo<SizingInput[]>(() => {
    const found = new Map<string, SizingInput>();

    for (const card of cards) {
      // A free resource has no amount to size, so its inputs are not drivers.
      if (card.bucket === "free" || !card.entry?.sizedBy) continue;

      for (const variable of variables) {
        const name = variable.name.toLowerCase();
        if (!card.entry.sizedBy.some((fragment) => name.includes(fragment))) {
          continue;
        }

        const existing = found.get(variable.name);
        if (existing) {
          existing.drives.push(card.resourceType);
          continue;
        }

        found.set(variable.name, {
          name: variable.name,
          value: scalarDefault(variable.default),
          required: variable.required ?? false,
          drives: [card.resourceType],
        });
      }
    }

    return [...found.values()].sort(
      (a, b) => b.drives.length - a.drives.length,
    );
  }, [cards, variables]);

  if (managed.length === 0) {
    return (
      <p className="rounded-lg border border-dashed py-12 text-center text-sm text-muted-foreground">
        This module creates no resources, so it adds nothing to a bill.
      </p>
    );
  }

  const freeCards = cards.filter((card) => card.bucket === "free");

  const verdict =
    totals.recurring > 0
      ? `${totals.recurring} of ${managed.length} resources bill from the moment they exist.`
      : totals.usage > 0
        ? "Nothing here bills continuously — the charges start with traffic."
        : "Nothing this module creates carries a charge of its own.";

  return (
    <div className="space-y-6">
      <section className="rounded-lg border bg-card p-4">
        <h3 className="text-sm font-medium">{verdict}</h3>

        {/* Resource counts, not money: the share of a bill cannot be known
            here, and a bar implying one would be the worse kind of wrong. */}
        <div className="mt-4 flex h-2 gap-0.5 overflow-hidden rounded-full">
          {BUCKET_ORDER.map((bucket) =>
            totals[bucket] > 0 ? (
              <div
                className={BUCKET_STYLE[bucket].bar}
                key={bucket}
                style={{ width: `${(totals[bucket] / managed.length) * 100}%` }}
              />
            ) : null,
          )}
        </div>

        <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
          {BUCKET_ORDER.map((bucket) => (
            <div className="flex items-center gap-2" key={bucket}>
              <BucketDot bucket={bucket} />
              <dt className="text-xs text-muted-foreground">
                {BUCKET_LABELS[bucket]}
              </dt>
              <dd className="text-xs font-medium tabular-nums">
                {totals[bucket]}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      {sizingInputs.length > 0 ? (
        <section>
          <h3 className="text-sm font-semibold">What decides the amount</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Inputs of this module that size something billable. The resources
            are fixed by the module; these are the numbers still open to you.
          </p>

          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {sizingInputs.map((input) => (
              <div
                className="rounded-lg border bg-card px-3 py-2.5"
                key={input.name}
              >
                <div className="flex flex-wrap items-baseline gap-2">
                  <code className="font-mono text-sm font-medium">
                    {input.name}
                  </code>
                  {input.value === null ? (
                    <Badge variant="outline">
                      {input.required ? "required" : "no default"}
                    </Badge>
                  ) : (
                    <code className="font-mono text-xs text-muted-foreground">
                      = {input.value}
                    </code>
                  )}
                </div>
                <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                  {input.drives.join(", ")}
                </p>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {BUCKET_ORDER.filter((bucket) => bucket !== "free").map((bucket) => {
        const group = cards.filter((card) => card.bucket === bucket);
        if (group.length === 0) return null;

        return (
          <section key={bucket}>
            <div className="flex items-center gap-2">
              <BucketDot bucket={bucket} />
              <h3 className="text-sm font-semibold">{BUCKET_LABELS[bucket]}</h3>
              <span className="text-xs tabular-nums text-muted-foreground">
                {totals[bucket]}
              </span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {BUCKET_HINTS[bucket]}
            </p>

            <div className="mt-3 grid gap-3 lg:grid-cols-3">
              {group.map((card) => (
                <div className="rounded-lg border bg-card p-3.5" key={card.key}>
                  <div className="flex items-start gap-3">
                    <ServiceIcon icon={card.icon} />

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">
                          {card.service}
                        </span>
                        {card.count > 1 ? (
                          <Badge variant="secondary">{card.count}</Badge>
                        ) : null}
                      </div>
                      <code className="mt-0.5 block break-all font-mono text-xs text-muted-foreground">
                        {card.resourceType}
                      </code>
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

                  {card.names.length > 0 ? (
                    <p className="mt-2 break-all font-mono text-xs text-muted-foreground">
                      {card.names.join(", ")}
                    </p>
                  ) : null}
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
          <button
            className="flex w-full items-center gap-2 text-left"
            onClick={() => setShowFree((value) => !value)}
            type="button"
          >
            <BucketDot bucket="free" />
            <h3 className="text-sm font-semibold">{BUCKET_LABELS.free}</h3>
            <ChevronDown
              className={cn(
                "h-4 w-4 text-muted-foreground transition-transform",
                showFree && "rotate-180",
              )}
            />
            <span className="text-xs tabular-nums text-muted-foreground">
              {totals.free}
            </span>
          </button>

          {showFree ? (
            <>
              <p className="mt-1 text-sm text-muted-foreground">
                {BUCKET_HINTS.free}
              </p>
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
            </>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
