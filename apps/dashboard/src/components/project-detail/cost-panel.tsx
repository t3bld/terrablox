"use client";

import { Button } from "@terrablox/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@terrablox/ui/card";
import { Input } from "@terrablox/ui/input";
import { Skeleton } from "@terrablox/ui/skeleton";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  RefreshCw,
  Search,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  type CostModuleGroup,
  type CostResource,
  countUsageDriven,
  formatMoney,
  groupByModule,
  isUsageDriven,
  monthlyCostOf,
  type ProjectCostDto,
} from "@/lib/projects/cost";

interface CostPanelProps {
  projectId: string;
}

/**
 * What the project would cost per month, priced against a real plan.
 *
 * The figure is an estimate and is labelled as one everywhere it appears: it
 * covers what can be priced from a plan — instance hours, provisioned storage,
 * anything charged for existing — and deliberately cannot cover traffic. The
 * usage-driven components are counted and shown rather than hidden, because the
 * gap between "this is the bill" and "this is the floor of the bill" is the
 * only thing a reader needs to take away from this tab.
 */
export function CostPanel({ projectId }: CostPanelProps) {
  const [cost, setCost] = useState<ProjectCostDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    setError(null);

    try {
      const response = await fetch(`/api/projects/${projectId}/cost`);
      const body = await response.json();
      if (!response.ok)
        throw new Error(body?.error ?? "Failed to load the estimate");

      setCost(body.cost as ProjectCostDto);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load the estimate",
      );
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function refresh() {
    if (refreshing) return;

    setRefreshing(true);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch(`/api/projects/${projectId}/cost`, {
        method: "POST",
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error ?? "Failed to refresh");

      setNotice(
        "Estimate started. The result is committed when the workflow finishes.",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to refresh");
    } finally {
      setRefreshing(false);
    }
  }

  const snapshot = cost?.snapshot ?? null;

  const filtered = useMemo<CostResource[]>(() => {
    const resources = snapshot?.resources ?? [];
    const needle = query.trim().toLowerCase();
    if (!needle) return resources;

    return resources.filter((resource) =>
      resource.name.toLowerCase().includes(needle),
    );
  }, [snapshot, query]);

  const groups = useMemo(() => groupByModule(filtered), [filtered]);

  const usageDriven = useMemo(
    () => countUsageDriven(snapshot?.resources ?? []),
    [snapshot],
  );

  if (loading) {
    return (
      <div className="mx-auto max-w-5xl space-y-4 p-6">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const currency = snapshot?.currency ?? "USD";

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      {error ? (
        <p className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="flex items-start gap-2 rounded-lg border bg-muted/50 px-3 py-2 text-sm">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
          {notice}
        </p>
      ) : null}

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <CardTitle className="text-base">
                {snapshot
                  ? `${formatMoney(snapshot.totalMonthlyCost, currency)} per month, estimated`
                  : "No estimate yet"}
              </CardTitle>
              <CardDescription>
                {snapshot ? (
                  <>
                    Priced from a Terraform plan{" "}
                    <RelativeTime iso={snapshot.generatedAt} />. This is the
                    cost of what would be running, before any traffic.
                  </>
                ) : cost?.hasWorkflow ? (
                  "The cost workflow is in the repository but has not published an estimate yet. It runs after every apply, or start it now."
                ) : (
                  "Generate the pipeline in the Deploy tab first — the workflow it creates is what prices the plan."
                )}
              </CardDescription>
            </div>

            <Button
              disabled={refreshing || !cost?.hasWorkflow}
              onClick={() => void refresh()}
              size="sm"
              variant="outline"
            >
              <RefreshCw
                className={`mr-2 h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`}
              />
              Re-estimate
            </Button>
          </div>
        </CardHeader>

        {snapshot ? (
          <CardContent className="space-y-3">
            <ul className="flex flex-wrap gap-2 text-xs">
              {snapshot.supportedResources !== null ? (
                <Stat
                  label="priced"
                  value={String(snapshot.supportedResources)}
                />
              ) : null}
              {usageDriven > 0 ? (
                <Stat label="usage-driven" value={String(usageDriven)} />
              ) : null}
              {snapshot.noPriceResources ? (
                <Stat label="free" value={String(snapshot.noPriceResources)} />
              ) : null}
              {snapshot.unsupportedResources ? (
                <Stat
                  label="not priceable"
                  value={String(snapshot.unsupportedResources)}
                />
              ) : null}
            </ul>

            {usageDriven > 0 ? (
              // The single most important caveat, so it is stated where the
              // total is, not further down the page.
              <p className="text-xs text-muted-foreground">
                {usageDriven} component{usageDriven === 1 ? " is" : "s are"}{" "}
                charged by usage — requests, data transfer, invocations — and
                cannot be estimated from a plan. The real bill will be higher
                than the figure above.
              </p>
            ) : null}

            <a
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              href={cost?.fileUrl}
              rel="noreferrer"
              target="_blank"
            >
              View the estimate in the repository
              <ExternalLink className="h-3 w-3" />
            </a>
          </CardContent>
        ) : null}
      </Card>

      {cost?.problem ? (
        <p className="flex items-start gap-2 rounded-lg border px-3 py-2 text-sm text-muted-foreground">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          {cost.problem}
        </p>
      ) : null}

      {snapshot && snapshot.resources.length > 0 ? (
        <>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter by resource address"
              value={query}
            />
          </div>

          {groups.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Nothing matches &ldquo;{query}&rdquo;.
            </p>
          ) : (
            groups.map((group) => (
              <ModuleGroup currency={currency} group={group} key={group.path} />
            ))
          )}
        </>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <li className="flex items-center gap-1.5 rounded-full border px-2.5 py-1">
      <span className="font-medium">{value}</span>
      <span className="text-muted-foreground">{label}</span>
    </li>
  );
}

function ModuleGroup({
  group,
  currency,
}: {
  group: CostModuleGroup;
  currency: string;
}) {
  const [open, setOpen] = useState(true);

  return (
    <section className="rounded-lg border bg-card">
      <button
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-t-lg border-b bg-muted/30 px-4 py-2.5 text-left transition-colors hover:bg-muted/50"
        onClick={() => setOpen((previous) => !previous)}
        type="button"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <h3 className="font-semibold text-sm">{group.label}</h3>
        <span className="text-xs text-muted-foreground">
          {group.resources.length}
        </span>
        <span className="ml-auto font-medium text-sm">
          {formatMoney(group.monthlyCost, currency)}
        </span>
      </button>

      {open ? (
        <ul>
          {group.resources.map((resource) => (
            <ResourceRow
              currency={currency}
              key={resource.name}
              resource={resource}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function ResourceRow({
  resource,
  currency,
}: {
  resource: CostResource;
  currency: string;
}) {
  const [open, setOpen] = useState(false);
  const monthly = monthlyCostOf(resource);
  const usage = resource.components.filter(isUsageDriven).length;

  return (
    <li className="border-b last:border-b-0">
      <button
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-muted/40"
        onClick={() => setOpen((previous) => !previous)}
        type="button"
      >
        <span className="min-w-0 flex-1 truncate font-mono text-xs">
          {resource.name}
        </span>

        {usage > 0 ? (
          <span className="shrink-0 text-xs text-muted-foreground">
            +{usage} by usage
          </span>
        ) : null}

        <span className="shrink-0 text-sm">
          {monthly === null ? (
            <span className="text-muted-foreground">usage only</span>
          ) : (
            formatMoney(monthly, currency)
          )}
        </span>
      </button>

      {open && resource.components.length > 0 ? (
        <ul className="border-t bg-muted/20 px-4 py-2">
          {resource.components.map((component) => (
            <li
              className="flex items-center gap-3 py-1 text-xs"
              key={component.name}
            >
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {component.name}
                {component.unit ? ` · ${component.unit}` : ""}
              </span>
              <span
                className={
                  isUsageDriven(component) ? "text-muted-foreground" : ""
                }
              >
                {isUsageDriven(component)
                  ? "depends on usage"
                  : formatMoney(component.monthlyCost, currency)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** Age matters more than the timestamp: prices and plans both drift. */
function RelativeTime({ iso }: { iso: string }) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return <span>at an unknown time</span>;

  const minutes = Math.round((Date.now() - date.getTime()) / 60000);
  const text =
    minutes < 1
      ? "just now"
      : minutes < 60
        ? `${minutes} minutes ago`
        : minutes < 60 * 24
          ? `${Math.round(minutes / 60)} hours ago`
          : `${Math.round(minutes / (60 * 24))} days ago`;

  return <span title={date.toLocaleString()}>{text}</span>;
}
