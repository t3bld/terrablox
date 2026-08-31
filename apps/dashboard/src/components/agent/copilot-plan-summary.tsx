"use client";

import { Badge } from "@terrablox/ui/badge";

import type { CopilotPlan } from "@/lib/agent/copilot-plan";

/** What `GET /api/copilot/status` answers. */
export interface CopilotStatus {
  githubLinked: boolean;
  plan: CopilotPlan | null;
}

/**
 * What the signed-in user's Copilot licence currently allows.
 *
 * Lives on its own because two places show it: the agent settings screen, and
 * the chat composer's quota popover. One component so the number next to the
 * send button and the number on the settings page can never disagree.
 */
export function CopilotPlanSummary({
  plan,
  framed = true,
}: {
  plan: CopilotPlan;
  /** False inside a popover, which brings its own border. */
  framed?: boolean;
}) {
  const premium = plan.premium;
  const used = premium ? Math.min(100, 100 - premium.percentRemaining) : 0;

  return (
    <div className={`space-y-3 ${framed ? "rounded-md border p-3" : ""}`}>
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
          <div className="flex items-baseline justify-between gap-2 text-sm">
            <span>Premium requests</span>
            <span className="text-right text-muted-foreground">
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
