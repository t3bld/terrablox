"use client";

import { Lock } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./card";

interface ComingLaterProps {
  /** The feature, named the way its tab is named. */
  feature: string;
  /** Why it is not here yet, in one sentence. */
  explanation: string;
  /** What it will do once it does, concretely enough to be worth waiting for. */
  planned: string[];
}

/**
 * What a tab shows while its feature is still ahead of it.
 *
 * The alternative was to hide the tab until the feature lands, and that is the
 * worse trade: someone who looked for costs and found nothing cannot tell whether
 * they missed it, whether it needs configuring, or whether it was never planned.
 * A locked tab with a date-free promise answers all three, and it does it in the
 * place the question is asked rather than in a changelog.
 *
 * Deliberately without a call to action. This replaced a panel that offered a
 * "connect it in Account settings" button, and a button here would now point at a
 * setting that no longer exists — the reason nothing happens is on our side, not
 * the user's, so there is nothing honest for them to click.
 */
export function ComingLater({
  feature,
  explanation,
  planned,
}: ComingLaterProps) {
  return (
    <div className="mx-auto max-w-2xl p-6">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted">
              <Lock className="h-4 w-4 text-muted-foreground" />
            </span>
            <div className="min-w-0">
              <CardTitle className="text-base">{feature} comes later</CardTitle>
              <CardDescription>{explanation}</CardDescription>
            </div>
          </div>
        </CardHeader>

        <CardContent>
          <p className="mb-2 text-sm text-muted-foreground">What it will do:</p>
          <ul className="space-y-1 text-sm text-muted-foreground">
            {planned.map((item) => (
              <li className="flex gap-2" key={item}>
                <span aria-hidden className="text-muted-foreground/60">
                  •
                </span>
                {item}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
