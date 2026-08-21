"use client";

import { Badge } from "@terrablox/ui/badge";
import { Button } from "@terrablox/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@terrablox/ui/card";
import { ExternalLink } from "lucide-react";
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

  const linked = status?.githubLinked ?? false;

  /** Where a user's own Copilot features are configured on GitHub. */
  const settingsUrl = "https://github.com/settings/copilot/features";

  return (
    <Card>
      <CardHeader>
        {/* Laid out exactly like the account screen's integration cards: title
            with a link out beside it, state on the right. The link used to hang
            off the badge, which made one control mean two things — "you are
            connected" and "go to GitHub" — and neither was obvious. */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-1.5">
            <CardTitle>GitHub Copilot</CardTitle>
            <Button asChild className="h-7 w-7" size="icon" variant="ghost">
              <a
                aria-label="Open your Copilot settings on GitHub"
                href={settingsUrl}
                rel="noreferrer"
                target="_blank"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </Button>
          </div>

          <Badge
            className={
              linked
                ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950 dark:text-emerald-300 dark:hover:bg-emerald-950"
                : "text-muted-foreground"
            }
            variant={linked ? "secondary" : "outline"}
          >
            {linked ? "Connected" : "Unconnected"}
          </Badge>
        </div>
        {!linked ? (
          <CardDescription>
            Link GitHub in Account Settings so the agent can run on your own
            Copilot seat.
          </CardDescription>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {status ? null : (
          <p className="text-muted-foreground text-sm">Checking...</p>
        )}

        {status?.plan ? <PlanSummary plan={status.plan} /> : null}
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
        <span className="font-medium text-sm">Your Licence</span>
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
