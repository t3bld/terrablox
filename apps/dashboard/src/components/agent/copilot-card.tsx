"use client";

import { Badge } from "@terrablox/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@terrablox/ui/card";
import { useEffect, useState } from "react";

import type { CopilotPlan } from "@/lib/agent/copilot-plan";

interface CopilotStatus {
  githubLinked: boolean;
  plan: CopilotPlan | null;
}

export function CopilotCard() {
  const [status, setStatus] = useState<CopilotStatus | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/copilot/status")
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!cancelled && body) setStatus(body as CopilotStatus);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle>GitHub Copilot</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {status ? (
          <ul className="space-y-2 text-sm">
            <StatusLine
              ok={status.githubLinked}
              label="GitHub account linked"
              hint="Link GitHub above so the agent can run as you."
            />
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">Checking...</p>
        )}

        {status?.plan ? <PlanSummary plan={status.plan} /> : null}

        {status?.plan?.organizations.length ? (
          <p className="text-sm">
            Organisation settings:{" "}
            {status.plan.organizations.map((org, index) => (
              <span key={org}>
                {index > 0 ? ", " : null}
                <a
                  className="text-primary underline underline-offset-4 hover:text-primary/80"
                  href={`https://github.com/orgs/${encodeURIComponent(org)}/settings/copilot`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {org}
                </a>
              </span>
            ))}
          </p>
        ) : null}

        <a
          className="block text-sm text-primary underline underline-offset-4 hover:text-primary/80"
          href="https://github.com/settings/copilot/features"
          target="_blank"
          rel="noreferrer"
        >
          Open your Copilot settings on GitHub
        </a>
      </CardContent>
    </Card>
  );
}

function PlanSummary({ plan }: { plan: CopilotPlan }) {
  const premium = plan.premium;
  const used = premium ? Math.min(100, 100 - premium.percentRemaining) : 0;

  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-sm">Your licence</span>
        <Badge variant={plan.plan ? "default" : "secondary"}>
          {plan.plan ? planLabel(plan.plan) : "No Copilot plan"}
        </Badge>
        {plan.organizations.map((org) => (
          <Badge key={org} variant="outline">
            {org}
          </Badge>
        ))}
      </div>

      {premium ? (
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between text-sm">
            <span>Premium requests</span>
            <span className="text-muted-foreground">
              {premium.unlimited
                ? "Unlimited"
                : `${formatCount(premium.used)} of ${formatCount(premium.entitlement)} used (${formatPercent(used)})`}
            </span>
          </div>

          {premium.unlimited ? null : (
            <>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className={`h-full rounded-full ${used >= 90 ? "bg-destructive" : "bg-primary"}`}
                  style={{ width: `${used}%` }}
                />
              </div>
              <p className="text-muted-foreground text-xs">
                {formatCount(premium.remaining)} left (
                {formatPercent(premium.percentRemaining)} remaining)
                {plan.resetsOn
                  ? `, resets on ${formatDate(plan.resetsOn)}`
                  : ""}
                {premium.remaining === 0 && premium.overagePermitted
                  ? " — further requests are billed as overage."
                  : "."}
              </p>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function planLabel(plan: string): string {
  const name = plan.replace(/[_-]+/g, " ");
  return `Copilot ${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

function formatCount(value: number): string {
  return value.toLocaleString();
}

function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString(undefined, {
        day: "numeric",
        month: "long",
        year: "numeric",
      });
}

function StatusLine({
  ok,
  label,
  hint,
}: {
  ok: boolean;
  label: string;
  hint: string;
}) {
  return (
    <li>
      <span className={ok ? "text-emerald-600" : "text-amber-600"}>
        {ok ? "Connected: " : "Not connected: "}
        {label}
        {ok ? null : (
          <span className="block text-muted-foreground text-xs">{hint}</span>
        )}
      </span>
    </li>
  );
}
