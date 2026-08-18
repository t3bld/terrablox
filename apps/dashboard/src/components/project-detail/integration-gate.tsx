"use client";

import { Button } from "@terrablox/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@terrablox/ui/card";
import { ExternalLink, Lock, RefreshCw } from "lucide-react";

interface IntegrationGateProps {
  /** What the user connects, named the way the account page names it. */
  provider: "AWS" | "Infracost";
  /** What this tab would do once the account is connected. */
  explanation: string;
  /** The concrete things that stay unavailable until then. */
  blocked: string[];
  onRecheck: () => void;
}

/**
 * The one screen a locked tab shows.
 *
 * A tab that is merely greyed out cannot say why, so the tab stays reachable
 * and explains itself here: what is missing, what it unlocks, and the single
 * link that fixes it. Rechecking is offered because the fix happens on another
 * page, often in a second window.
 */
export function IntegrationGate({
  provider,
  explanation,
  blocked,
  onRecheck,
}: IntegrationGateProps) {
  return (
    <div className="mx-auto max-w-2xl p-6">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted">
              <Lock className="h-4 w-4 text-muted-foreground" />
            </span>
            <div className="min-w-0">
              <CardTitle className="text-base">
                Connect {provider} to use this tab
              </CardTitle>
              <CardDescription>{explanation}</CardDescription>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          <ul className="space-y-1 text-sm text-muted-foreground">
            {blocked.map((item) => (
              <li className="flex gap-2" key={item}>
                <span aria-hidden className="text-muted-foreground/60">
                  •
                </span>
                {item}
              </li>
            ))}
          </ul>

          <div className="flex flex-wrap items-center gap-2">
            <Button asChild size="sm">
              <a href="/account">
                Connect in Account settings
                <ExternalLink className="ml-2 h-3.5 w-3.5" />
              </a>
            </Button>
            <Button onClick={onRecheck} size="sm" variant="outline">
              <RefreshCw className="mr-2 h-3.5 w-3.5" />
              I&rsquo;ve connected it
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
