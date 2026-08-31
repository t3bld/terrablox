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

import { CopilotPlanSummary, type CopilotStatus } from "./copilot-plan-summary";

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

        {status?.plan ? <CopilotPlanSummary plan={status.plan} /> : null}
      </CardContent>
    </Card>
  );
}
