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
  Boxes,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  RefreshCw,
  Search,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  countByKind,
  groupByModule,
  type ProjectStateDto,
  type StateResourceView,
  toResourceView,
} from "@/lib/projects/state";

interface StatePanelProps {
  projectId: string;
}

/**
 * What is actually running in AWS, as opposed to what the code declares.
 *
 * The two differ more often than anyone would like — a failed apply, a change
 * made in the console — so this reads the Terraform state out of its encrypted
 * bucket rather than inferring anything from the sources.
 */
export function StatePanel({ projectId }: StatePanelProps) {
  const [state, setState] = useState<ProjectStateDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    setError(null);

    try {
      const response = await fetch(`/api/projects/${projectId}/state`);
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error ?? "Failed to load state");

      setState(body.state as ProjectStateDto);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load state");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Re-reads the bucket.
   *
   * There is nothing to trigger any more: the state in S3 is already whatever
   * the last apply left there, so refreshing is just asking again.
   */
  async function refresh() {
    if (refreshing) return;

    setRefreshing(true);
    setNotice(null);
    await load();
    setRefreshing(false);
  }

  const resources = useMemo<StateResourceView[]>(() => {
    if (!state?.snapshot) return [];
    return state.snapshot.resources.map((resource) =>
      toResourceView(resource, state.region),
    );
  }, [state]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return resources;

    return resources.filter((resource) =>
      [resource.address, resource.type, resource.label, resource.id ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [resources, query]);

  const groups = useMemo(() => groupByModule(filtered), [filtered]);
  const kinds = useMemo(() => countByKind(resources), [resources]);

  if (loading) {
    return (
      <div className="mx-auto max-w-5xl space-y-4 p-6">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const snapshot = state?.snapshot ?? null;
  const managedCount = resources.filter((resource) => resource.managed).length;

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
                  ? `${managedCount} resource${managedCount === 1 ? "" : "s"} deployed`
                  : state?.configured
                    ? "Nothing deployed yet"
                    : "No state backend yet"}
              </CardTitle>
              <CardDescription>
                {snapshot ? (
                  <>
                    Read from the Terraform state in{" "}
                    <code className="rounded bg-muted px-1">
                      {state?.bucket}
                    </code>
                    , last written <RelativeTime iso={snapshot.generatedAt} />
                    {snapshot.terraformVersion
                      ? ` with Terraform ${snapshot.terraformVersion}`
                      : null}
                    .
                  </>
                ) : (
                  "This reads the encrypted state bucket directly, so it is current as of now rather than as of the last workflow run."
                )}
              </CardDescription>
            </div>

            <Button
              disabled={refreshing || !state?.configured}
              onClick={() => void refresh()}
              size="sm"
              variant="outline"
            >
              <RefreshCw
                className={`mr-2 h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`}
              />
              Re-read
            </Button>
          </div>
        </CardHeader>

        {snapshot ? (
          <CardContent className="space-y-3">
            {kinds.length > 0 ? (
              <ul className="flex flex-wrap gap-2">
                {kinds.map((kind) => (
                  <li
                    key={kind.kind}
                    className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs"
                  >
                    <ServiceIcon icon={kind.icon} className="h-4 w-4" />
                    <span className="font-medium">{kind.kind}</span>
                    <span className="text-muted-foreground">{kind.count}</span>
                  </li>
                ))}
              </ul>
            ) : null}

            {/* Only identifiers ever leave the server, which is worth saying
                here rather than only in the code that enforces it. */}
            <p className="text-muted-foreground text-xs">
              Terraform state can contain generated passwords. TerraBlox reads
              only resource identifiers and non-sensitive outputs from it —
              attribute values are never sent to the browser.
            </p>
          </CardContent>
        ) : null}
      </Card>

      {state?.problem ? (
        <p className="flex items-start gap-2 rounded-lg border px-3 py-2 text-sm text-muted-foreground">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          {state.problem}
        </p>
      ) : null}

      {snapshot && resources.length > 0 ? (
        <>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter by name, type or id"
              className="pl-9"
            />
          </div>

          {groups.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Nothing matches &ldquo;{query}&rdquo;.
            </p>
          ) : (
            groups.map((group) => (
              <ModuleGroup
                key={group.path}
                label={group.label}
                resources={group.resources}
              />
            ))
          )}
        </>
      ) : null}

      {snapshot && snapshot.outputs.length > 0 ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Outputs</CardTitle>
            <CardDescription>
              Values the root module exposes. Outputs marked sensitive are never
              exported by the pipeline.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              {snapshot.outputs.map((output) => (
                <li
                  key={output.name}
                  className="flex items-center gap-3 py-2 text-sm"
                >
                  <span className="w-56 shrink-0 truncate font-mono text-xs">
                    {output.name}
                  </span>
                  {output.sensitive ? (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                      sensitive
                    </span>
                  ) : (
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                      {output.value}
                    </span>
                  )}
                  {output.value ? (
                    <CopyButton value={output.value} label={output.name} />
                  ) : null}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function ModuleGroup({
  label,
  resources,
}: {
  label: string;
  resources: StateResourceView[];
}) {
  const [open, setOpen] = useState(true);

  return (
    <Card>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <Boxes className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="truncate text-sm font-medium">{label}</span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          {resources.length}
        </span>
      </button>

      {open ? (
        <CardContent className="p-0">
          <ul className="divide-y border-t">
            {resources.map((resource) => (
              <ResourceRow key={resource.address} resource={resource} />
            ))}
          </ul>
        </CardContent>
      ) : null}
    </Card>
  );
}

function ResourceRow({ resource }: { resource: StateResourceView }) {
  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <ServiceIcon icon={resource.icon} className="h-6 w-6 shrink-0" />

      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-sm">
          <span className="truncate font-medium">{resource.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {resource.label}
          </span>
          {resource.managed ? null : (
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
              data source
            </span>
          )}
        </p>
        <p className="truncate font-mono text-xs text-muted-foreground">
          {resource.id ?? resource.address}
        </p>
      </div>

      {resource.arn ? (
        <CopyButton value={resource.arn} label={`ARN of ${resource.name}`} />
      ) : null}

      {resource.consoleUrl ? (
        <a
          href={resource.consoleUrl}
          target="_blank"
          rel="noreferrer"
          className="flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground"
        >
          Console
          <ExternalLink className="h-3 w-3" />
        </a>
      ) : null}
    </li>
  );
}

/**
 * Falls back to a neutral square: the icon set is vendored per service, so a
 * resource from an unmapped service would otherwise render a broken image.
 */
function ServiceIcon({
  icon,
  className,
}: {
  icon: string | undefined;
  className: string;
}) {
  if (!icon) {
    return (
      <span className={`${className} rounded bg-muted`} aria-hidden="true" />
    );
  }

  return (
    // biome-ignore lint/performance/noImgElement: the AWS icons are vendored SVGs, which next/image passes through unchanged
    <img
      src={`/aws-icons/${icon}.svg`}
      alt=""
      className={className}
      loading="lazy"
    />
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={`Copy ${label}`}
      className="h-7 w-7 shrink-0"
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-emerald-600" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </Button>
  );
}

/** Age matters more than the timestamp here: a stale snapshot is the problem. */
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
