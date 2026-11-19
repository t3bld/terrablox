"use client";

import { Badge } from "@terrablox/ui/badge";
import { Button } from "@terrablox/ui/button";
import { Input } from "@terrablox/ui/input";
import { Skeleton } from "@terrablox/ui/skeleton";
import { Slider } from "@terrablox/ui/slider";
import {
  AlertCircle,
  Box,
  Calculator,
  ChevronRight,
  RefreshCw,
  Search,
} from "lucide-react";
import {
  Children,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  ProjectCostSnapshotDto,
  ProjectCostsDto,
  ProjectCostUsageResourceDto,
} from "@/lib/projects/types";

import { WIZARD_COLUMN } from "./deploy-wizard";

/** The box every cost section uses, matching the module Costs tab. */
function Panel({
  title,
  badge,
  actions,
  children,
}: {
  title: React.ReactNode;
  badge?: React.ReactNode;
  actions?: React.ReactNode;
  /** Omitted or empty: the panel is just its header, without an empty body. */
  children?: React.ReactNode;
}) {
  const hasBody = Children.toArray(children).length > 0;

  return (
    <section className="rounded-lg border bg-card">
      <div
        className={`flex flex-wrap items-center justify-between gap-3 p-4 ${hasBody ? "border-b" : ""}`}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h2 className="font-semibold text-sm">{title}</h2>
          {badge}
        </div>
        {actions}
      </div>
      {hasBody ? <div className="space-y-4 p-4">{children}</div> : null}
    </section>
  );
}

function Tile({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border bg-muted/20 p-4">
      <p className="text-muted-foreground text-xs">{label}</p>
      {children}
    </div>
  );
}

function money(value: string | null, currency: string): string {
  const amount = value === null ? null : Number(value);
  if (amount === null || !Number.isFinite(amount)) return "Not fully priced";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function ServiceIcon({
  icon,
  className = "h-7 w-7",
}: {
  icon: string | null;
  className?: string;
}) {
  return icon ? (
    // biome-ignore lint/performance/noImgElement: vendored SVGs are passed through unchanged by next/image
    <img alt="" className={className} src={`/aws-icons/${icon}.svg`} />
  ) : (
    <span
      className={`${className} flex items-center justify-center rounded bg-muted`}
    >
      <Box className="h-3.5 w-3.5 text-muted-foreground" />
    </span>
  );
}

type UsageValues = Record<string, Record<string, number>>;
type UsageProfile = "low" | "expected" | "high";

function valuesFromUsage(
  resources: ProjectCostUsageResourceDto[],
): UsageValues {
  return Object.fromEntries(
    resources.map((resource) => [
      resource.address,
      Object.fromEntries(
        resource.fields.map((field) => [field.key, field.value]),
      ),
    ]),
  );
}

function usageNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(
    value,
  );
}

export function ProjectCostsPanel({ projectId }: { projectId: string }) {
  const [costs, setCosts] = useState<ProjectCostsDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [estimating, setEstimating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [usageValues, setUsageValues] = useState<UsageValues>({});
  const [usageDirty, setUsageDirty] = useState(false);

  const usageRef = useRef(usageValues);
  usageRef.current = usageValues;
  // The assumptions whose last automatic estimate failed, so the effect below
  // does not retry the same values forever.
  const failedUsageRef = useRef<UsageValues | null>(null);

  const load = useCallback(
    async (options?: { keepUsage?: boolean }) => {
      setError(null);
      try {
        const response = await fetch(`/api/projects/${projectId}/costs`, {
          cache: "no-store",
        });
        const body = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(body?.error ?? "Could not load project costs.");
        }
        const next = body.costs as ProjectCostsDto;
        setCosts(next);
        // After an automatic estimate the user's own values stay on screen:
        // replacing them with the server copy would undo edits made while the
        // request was running.
        if (!options?.keepUsage) {
          setUsageValues(valuesFromUsage(next.usage ?? []));
          setUsageDirty(false);
        }
      } catch (loadError) {
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Could not load project costs.",
        );
      } finally {
        setLoading(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const estimate = useCallback(
    async (usageAssumptions?: UsageValues) => {
      if (estimating || !costs?.configured || !costs.binaryAvailable) return;
      setEstimating(true);
      setError(null);
      try {
        const response = await fetch(`/api/projects/${projectId}/costs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            refresh: costs.latest !== null,
            ...(usageAssumptions ? { usageAssumptions } : {}),
          }),
        });
        const body = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(body?.error ?? "The cost estimate failed.");
        }
        failedUsageRef.current = null;
        await load({ keepUsage: Boolean(usageAssumptions) });
        // Clean only when nothing was edited while the request ran; otherwise
        // the effect below sends the newer values next.
        if (usageAssumptions && usageRef.current === usageAssumptions) {
          setUsageDirty(false);
        }
      } catch (estimateError) {
        if (usageAssumptions) failedUsageRef.current = usageAssumptions;
        setError(
          estimateError instanceof Error
            ? estimateError.message
            : "The cost estimate failed.",
        );
      } finally {
        setEstimating(false);
      }
    },
    [costs, estimating, load, projectId],
  );

  // Without saved assumptions the estimate has been priced with no usage at all,
  // while the controls show the Expected profile. Apply it once so the number
  // and the controls agree.
  const seededUsageRef = useRef(false);
  useEffect(() => {
    if (seededUsageRef.current || !costs?.latest) return;
    if (!costs.configured || !costs.binaryAvailable) return;
    if (costs.hasSavedUsageAssumptions || costs.usage.length === 0) return;
    seededUsageRef.current = true;
    setUsageValues(
      Object.fromEntries(
        costs.usage.map((resource) => [
          resource.address,
          Object.fromEntries(
            resource.fields.map((field) => [field.key, field.expected]),
          ),
        ]),
      ),
    );
    setUsageDirty(true);
  }, [costs]);

  // Usage assumptions recalculate the estimate on their own once the edits
  // pause, so there is no separate button to press.
  useEffect(() => {
    if (!usageDirty || estimating || !costs?.configured) return;
    if (!costs.binaryAvailable || failedUsageRef.current === usageValues) {
      return;
    }
    const timer = setTimeout(() => void estimate(usageValues), 800);
    return () => clearTimeout(timer);
  }, [usageDirty, usageValues, estimating, costs, estimate]);

  if (loading) {
    return (
      <div className={WIZARD_COLUMN}>
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const snapshot = costs?.latest ?? null;
  const sourceStale = Boolean(
    snapshot && costs && snapshot.sourceSha !== costs.currentSourceSha,
  );
  const currencyStale = Boolean(
    snapshot && costs && snapshot.currency !== costs.estimateCurrency,
  );
  const stale = sourceStale || currencyStale;

  return (
    <div className={WIZARD_COLUMN}>
      {error ? (
        <p className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          {error}
        </p>
      ) : null}

      <Panel
        actions={
          <Button
            disabled={
              estimating || !costs?.configured || !costs.binaryAvailable
            }
            onClick={() => void estimate()}
            size="sm"
            variant={snapshot ? "outline" : "default"}
          >
            {estimating ? (
              <RefreshCw className="mr-2 h-3.5 w-3.5 animate-spin" />
            ) : snapshot ? (
              <RefreshCw className="mr-2 h-3.5 w-3.5" />
            ) : (
              <Calculator className="mr-2 h-3.5 w-3.5" />
            )}
            {estimating
              ? "Calculating…"
              : snapshot
                ? "Refresh prices"
                : "Calculate estimate"}
          </Button>
        }
        badge={
          snapshot ? (
            <Badge variant={stale ? "secondary" : "outline"}>
              {sourceStale
                ? "Code changed"
                : currencyStale
                  ? `Recalculate in ${costs?.estimateCurrency}`
                  : "Current revision"}
            </Badge>
          ) : null
        }
        title="Estimated monthly cost"
      >
        {costs?.configurationProblem ? (
          <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <div>
              <p className="font-medium">
                Monetary estimates are not configured
              </p>
              <p className="mt-0.5 text-muted-foreground text-xs">
                {costs.configurationProblem}
              </p>
            </div>
          </div>
        ) : null}

        {snapshot ? (
          <div className="grid grid-cols-2 gap-3">
            <Tile label="Monthly">
              {estimating ? (
                <Skeleton className="mt-2 h-8 w-28" />
              ) : (
                <p className="mt-1 font-semibold text-2xl tabular-nums">
                  {money(snapshot.totalMonthlyCost, snapshot.currency)}
                </p>
              )}
            </Tile>
            <Tile label="12 months">
              {estimating ? (
                <Skeleton className="mt-2 h-8 w-28" />
              ) : (
                <p className="mt-1 font-semibold text-2xl tabular-nums">
                  {money(
                    snapshot.totalMonthlyCost === null
                      ? null
                      : String(Number(snapshot.totalMonthlyCost) * 12),
                    snapshot.currency,
                  )}
                </p>
              )}
            </Tile>
          </div>
        ) : null}
      </Panel>

      {snapshot ? (
        <EstimateOverview recalculating={estimating} snapshot={snapshot} />
      ) : null}

      {snapshot && (costs?.usage.length ?? 0) > 0 ? (
        <UsageAssumptions
          dirty={usageDirty || estimating}
          hasSaved={costs?.hasSavedUsageAssumptions ?? false}
          onChange={(address, key, value) => {
            setUsageValues((current) => ({
              ...current,
              [address]: { ...current[address], [key]: value },
            }));
            setUsageDirty(true);
          }}
          onProfile={(profile) => {
            setUsageValues(
              Object.fromEntries(
                (costs?.usage ?? []).map((resource) => [
                  resource.address,
                  Object.fromEntries(
                    resource.fields.map((field) => [field.key, field[profile]]),
                  ),
                ]),
              ),
            );
            setUsageDirty(true);
          }}
          resources={costs?.usage ?? []}
          values={usageValues}
        />
      ) : null}

      {snapshot ? (
        <ResourceBreakdown
          currency={snapshot.currency}
          query={query}
          resources={snapshot.resources}
          setQuery={setQuery}
        />
      ) : null}
    </div>
  );
}

function UsageAssumptions({
  resources,
  values,
  dirty,
  hasSaved,
  onChange,
  onProfile,
}: {
  resources: ProjectCostUsageResourceDto[];
  values: UsageValues;
  dirty: boolean;
  hasSaved: boolean;
  onChange: (address: string, key: string, value: number) => void;
  onProfile: (profile: UsageProfile) => void;
}) {
  // The profile whose values every field currently matches, if any. Edited
  // values leave none highlighted.
  const activeProfile =
    (["expected", "low", "high"] as const).find((profile) =>
      resources.every((resource) =>
        resource.fields.every(
          (field) =>
            (values[resource.address]?.[field.key] ?? field.value) ===
            field[profile],
        ),
      ),
    ) ?? null;

  return (
    <Panel
      actions={
        <div className="flex flex-wrap gap-2">
          {(["low", "expected", "high"] as const).map((profile) => (
            <Button
              aria-pressed={activeProfile === profile}
              className="disabled:opacity-100"
              disabled={activeProfile === profile}
              key={profile}
              onClick={() => onProfile(profile)}
              size="sm"
              type="button"
              variant={activeProfile === profile ? "default" : "outline"}
            >
              <span className="capitalize">{profile}</span>
            </Button>
          ))}
        </div>
      }
      badge={
        <Badge variant={dirty ? "secondary" : "outline"}>
          {dirty ? "Updating" : hasSaved ? "Saved" : "Suggested"}
        </Badge>
      }
      title="Usage assumptions"
    >
      <div className="grid gap-4 lg:grid-cols-2">
        {resources.map((resource) => (
          <section className="rounded-md border p-4" key={resource.address}>
            <div className="flex items-start gap-3">
              <ServiceIcon className="h-7 w-7" icon={resource.icon} />
              <div className="min-w-0">
                <h4 className="font-medium text-sm">{resource.service}</h4>
                <code
                  className="block truncate font-mono text-[11px] text-muted-foreground"
                  title={resource.address}
                >
                  {resource.address}
                </code>
              </div>
            </div>

            <div className="mt-4 space-y-4">
              {resource.fields.map((field) => {
                const value =
                  values[resource.address]?.[field.key] ?? field.value;
                const nearest = field.steps.reduce(
                  (best, candidate, index) =>
                    Math.abs(candidate - value) <
                    Math.abs((field.steps[best] ?? 0) - value)
                      ? index
                      : best,
                  0,
                );

                return (
                  <div className="space-y-2" key={field.key}>
                    <div className="flex items-baseline justify-between gap-3">
                      <label
                        className="text-xs"
                        htmlFor={`usage-${resource.address}-${field.key}`}
                      >
                        {field.label}
                      </label>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {field.unit}
                      </span>
                    </div>
                    <div className="grid grid-cols-[1fr_8rem] items-center gap-3">
                      <Slider
                        aria-label={`${field.label} slider`}
                        max={field.steps.length - 1}
                        min={0}
                        onChange={(event) => {
                          const next =
                            field.steps[Number(event.target.value)] ?? 0;
                          onChange(resource.address, field.key, next);
                        }}
                        step={1}
                        value={nearest}
                      />
                      <Input
                        className="h-8 text-right font-mono text-xs"
                        id={`usage-${resource.address}-${field.key}`}
                        min={0}
                        onChange={(event) => {
                          const next = Number(event.target.value);
                          if (Number.isFinite(next) && next >= 0) {
                            onChange(resource.address, field.key, next);
                          }
                        }}
                        type="number"
                        value={value}
                      />
                    </div>
                    <div className="flex justify-between text-[10px] text-muted-foreground">
                      <span>{usageNumber(field.steps[0] ?? 0)}</span>
                      <span>
                        {usageNumber(field.steps[field.steps.length - 1] ?? 0)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </Panel>
  );
}

function EstimateOverview({
  snapshot,
  recalculating,
}: {
  snapshot: ProjectCostSnapshotDto;
  recalculating: boolean;
}) {
  const services = new Map<
    string,
    { icon: string | null; cost: number; resources: number }
  >();
  for (const resource of snapshot.resources) {
    const current = services.get(resource.service) ?? {
      icon: resource.icon,
      cost: 0,
      resources: 0,
    };
    current.cost += Number(resource.monthlyCost ?? 0);
    current.resources += 1;
    services.set(resource.service, current);
  }
  const ranked = [...services.entries()]
    .filter((entry) => entry[1].cost > 0)
    .sort((a, b) => b[1].cost - a[1].cost)
    .slice(0, 8);
  const max = Math.max(...ranked.map((entry) => entry[1].cost), 1);

  return (
    <>
      <Panel title="Cost by service">
        {recalculating ? (
          <div className="space-y-3">
            {[0, 1, 2].map((row) => (
              <Skeleton className="h-6 w-full" key={row} />
            ))}
          </div>
        ) : ranked.length ? (
          <ol className="space-y-3">
            {ranked.map(([service, entry]) => (
              <li
                className="grid grid-cols-[minmax(9rem,13rem)_1fr_auto] items-center gap-3"
                key={service}
              >
                <span className="flex min-w-0 items-center gap-2 text-sm">
                  <ServiceIcon className="h-5 w-5" icon={entry.icon} />
                  <span className="truncate">{service}</span>
                </span>
                <span className="h-2 overflow-hidden rounded-full bg-muted">
                  <span
                    className="block h-full rounded-full bg-primary"
                    style={{
                      width: `${Math.max(2, (entry.cost / max) * 100)}%`,
                    }}
                  />
                </span>
                <span className="w-28 text-right font-medium text-sm tabular-nums">
                  {money(String(entry.cost), snapshot.currency)}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-muted-foreground text-sm">
            No resource has a priced monthly component yet.
          </p>
        )}
      </Panel>

      {snapshot.diagnostics.length ? (
        <Panel
          title={
            <span className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-amber-600" />
              Estimation notes
            </span>
          }
        >
          <ul className="divide-y text-sm">
            {snapshot.diagnostics.map((diagnostic, index) => (
              <li className="py-2" key={`${diagnostic.message}-${index}`}>
                <span className="font-medium capitalize">
                  {diagnostic.severity}
                </span>
                <span className="text-muted-foreground">
                  {" "}
                  · {diagnostic.message}
                </span>
                {diagnostic.location ? (
                  <code className="ml-2 font-mono text-xs">
                    {diagnostic.location}
                  </code>
                ) : null}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </>
  );
}

type ResourceFilter = "costing" | "usage" | "free" | "unsupported" | "all";

const RESOURCE_FILTER_LABELS: Record<ResourceFilter, string> = {
  costing: "Costs",
  usage: "Usage",
  free: "Free",
  unsupported: "Not supported",
  all: "All",
};

function matchesResourceFilter(
  resource: ProjectCostSnapshotDto["resources"][number],
  filter: ResourceFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "free") return resource.free;
  if (filter === "unsupported") return !resource.supported;
  if (filter === "usage") {
    return resource.components.some(
      (component) => component.usageBased || component.usageUnknown,
    );
  }
  return !resource.free && Number(resource.monthlyCost ?? 0) > 0;
}

function ResourceBreakdown({
  resources,
  currency,
  query,
  setQuery,
}: {
  resources: ProjectCostSnapshotDto["resources"];
  currency: string;
  query: string;
  setQuery: (value: string) => void;
}) {
  const [filter, setFilter] = useState<ResourceFilter>("costing");
  const categoryCounts = useMemo(
    () => ({
      costing: resources.filter((resource) =>
        matchesResourceFilter(resource, "costing"),
      ).length,
      usage: resources.filter((resource) =>
        matchesResourceFilter(resource, "usage"),
      ).length,
      free: resources.filter((resource) =>
        matchesResourceFilter(resource, "free"),
      ).length,
      unsupported: resources.filter((resource) =>
        matchesResourceFilter(resource, "unsupported"),
      ).length,
      all: resources.length,
    }),
    [resources],
  );
  const filtered = useMemo(() => {
    const inCategory = resources.filter((resource) =>
      matchesResourceFilter(resource, filter),
    );
    const needle = query.trim().toLowerCase();
    if (!needle) return inCategory;
    return inCategory.filter((resource) =>
      [resource.address, resource.type, resource.service, resource.modulePath]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [resources, query, filter]);
  const sorted = [...filtered].sort(
    (a, b) =>
      Number(b.monthlyCost ?? -1) - Number(a.monthlyCost ?? -1) ||
      a.address.localeCompare(b.address),
  );

  return (
    <Panel title="Resources">
      <fieldset className="flex flex-wrap gap-2">
        <legend className="sr-only">Resource category</legend>
        {(
          [
            ["costing", "Costs"],
            ["usage", "Usage"],
            ["free", "Free"],
            ["unsupported", "Not supported"],
            ["all", "All"],
          ] as const
        ).map(([value, label]) => (
          <Button
            key={value}
            onClick={() => setFilter(value)}
            size="sm"
            type="button"
            variant={filter === value ? "secondary" : "outline"}
          >
            {label}
            <span className="ml-1.5 text-muted-foreground tabular-nums">
              {categoryCounts[value]}
            </span>
          </Button>
        ))}
      </fieldset>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="pl-9"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter by resource, module or service"
          value={query}
        />
      </div>

      <div className="divide-y rounded-md border">
        {sorted.map((resource) => (
          <details className="group" key={resource.address}>
            <summary className="grid cursor-pointer list-none grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2.5 hover:bg-muted/40">
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
              <span className="flex min-w-0 items-center gap-3">
                <ServiceIcon className="h-6 w-6" icon={resource.icon} />
                <span className="min-w-0">
                  <span
                    className="block truncate font-mono text-xs"
                    title={resource.address}
                  >
                    {resource.address}
                  </span>
                  <span className="block text-[11px] text-muted-foreground">
                    {resource.service} · {resource.type}
                  </span>
                </span>
              </span>
              <span className="text-right">
                <span className="block font-medium text-sm tabular-nums">
                  {resource.free
                    ? "Free"
                    : money(resource.monthlyCost, currency)}
                </span>
                <span className="block text-[10px] text-muted-foreground">
                  {resource.supported ? "supported" : "not priced"}
                </span>
              </span>
            </summary>

            <div className="border-t bg-muted/15 px-4 py-3">
              {resource.components.length ? (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-left text-xs">
                    <thead className="text-muted-foreground">
                      <tr>
                        <th className="pb-2 font-medium">Component</th>
                        <th className="pb-2 font-medium">Price</th>
                        <th className="pb-2 font-medium">Quantity</th>
                        <th className="pb-2 font-medium">Unit</th>
                        <th className="pb-2 text-right font-medium">Monthly</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {resource.components.map((component, index) => (
                        <tr key={`${component.name}-${index}`}>
                          <td className="py-2 pr-4">
                            {component.name}
                            {component.usageUnknown ? (
                              <Badge className="ml-2" variant="secondary">
                                usage needed
                              </Badge>
                            ) : null}
                          </td>
                          <td className="py-2 pr-4 font-mono">
                            {component.price ?? "—"}
                          </td>
                          <td className="py-2 pr-4 font-mono">
                            {component.quantity ?? "—"}
                          </td>
                          <td className="py-2 pr-4">{component.unit ?? "—"}</td>
                          <td className="py-2 text-right font-medium tabular-nums">
                            {money(component.monthlyCost, currency)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-muted-foreground text-xs">
                  {resource.free
                    ? "This resource carries no direct charge."
                    : "No price components were returned for this resource."}
                </p>
              )}
            </div>
          </details>
        ))}
      </div>

      {sorted.length === 0 ? (
        <p className="py-8 text-center text-muted-foreground text-sm">
          {query.trim()
            ? `Nothing matches “${query}”.`
            : `No resources in ${RESOURCE_FILTER_LABELS[filter].toLowerCase()}.`}
        </p>
      ) : null}
    </Panel>
  );
}
