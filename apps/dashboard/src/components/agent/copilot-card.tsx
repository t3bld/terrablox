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
import { AlertTriangle, Bot, Check, Loader2, PlayCircle } from "lucide-react";
import { useEffect, useState } from "react";

import type { CopilotPlan } from "@/lib/agent/copilot-plan";
import { readJson } from "@/lib/read-json";

/**
 * Copilot is the model behind the project agent, on the user's own licence.
 *
 * Per user rather than per company: the subscription belongs to the person, so
 * two colleagues on the same instance can genuinely differ here.
 */

interface CopilotStatus {
  githubLinked: boolean;
  plan: CopilotPlan | null;
}

interface TestResult {
  ok: boolean;
  reply?: string;
  error?: string;
}

export function CopilotCard() {
  const [status, setStatus] = useState<CopilotStatus | null>(null);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/copilot/status")
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!cancelled && body) setStatus(body as CopilotStatus);
      })
      .catch(() => {
        // Leave the card in its loading state; the test button still works.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const runTest = async () => {
    setTesting(true);
    setResult(null);

    try {
      const res = await fetch("/api/copilot/status", { method: "POST" });
      setResult(await readJson<TestResult>(res));
    } catch (e) {
      setResult({
        ok: false,
        error: e instanceof Error ? e.message : "The check failed",
      });
    } finally {
      setTesting(false);
    }
  };

  const ready = status?.githubLinked ?? false;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bot className="h-5 w-5" />
          GitHub Copilot
        </CardTitle>
        <CardDescription>
          The project agent runs on your own Copilot subscription. TerraBlox
          stores no model keys and pays for no tokens, so your organisation's
          Copilot policies apply unchanged.
        </CardDescription>
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
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            Checking…
          </div>
        )}

        {status?.plan ? <PlanSummary plan={status.plan} /> : null}

        <p className="text-muted-foreground text-xs">
          A seat can only be confirmed by using it — the check below sends one
          short prompt through your licence.
        </p>

        <Button
          variant="outline"
          size="sm"
          onClick={runTest}
          disabled={testing || !ready}
        >
          {testing ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <PlayCircle className="mr-2 h-4 w-4" />
          )}
          Test my Copilot access
        </Button>

        {result ? (
          <div
            className={`flex gap-2 rounded-md border p-3 text-sm ${
              result.ok
                ? "border-emerald-500/40 bg-emerald-500/5"
                : "border-destructive/40 bg-destructive/5 text-destructive"
            }`}
          >
            {result.ok ? (
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
            ) : (
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            )}
            <span>
              {result.ok
                ? "Copilot answered. The agent is ready to use."
                : result.error}
            </span>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Everything here is GitHub's own accounting, so it counts what you spend elsewhere too. */
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
                : `${formatCount(premium.used)} of ${formatCount(premium.entitlement)} used`}
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
                {formatCount(premium.remaining)} left
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
    <li className="flex items-start gap-2">
      {ok ? (
        <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
      ) : (
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
      )}
      <span>
        {label}
        {ok ? null : (
          <span className="block text-muted-foreground text-xs">{hint}</span>
        )}
      </span>
    </li>
  );
}
