"use client";

import { Check } from "lucide-react";

export interface WizardStepDefinition<T extends string> {
  id: T;
  /** Kept to a word or two: the strip has to fit five of them on one line. */
  label: string;
  done?: boolean;
  /**
   * Whether the step can be jumped to. Defaults to "it is finished, or it is
   * the one being shown" — a wizard whose later steps depend on earlier ones
   * cannot let them be opened out of order.
   */
  enabled?: boolean;
}

/**
 * The numbered strip across the top of a wizard.
 *
 * Horizontal rather than a stack of cards, because the point of a wizard is that
 * one step is the whole screen: a column of collapsed steps shows how much is
 * left but gives the current one no more room than the rest.
 */
export function WizardSteps<T extends string>({
  steps,
  current,
  onSelect,
  label,
}: {
  steps: WizardStepDefinition<T>[];
  current: T;
  /** Omitted where steps cannot be revisited. */
  onSelect?: (id: T) => void;
  label: string;
}) {
  return (
    <ol aria-label={label} className="flex w-full items-center gap-2">
      {steps.map((step, index) => {
        const active = step.id === current;
        const done = step.done ?? false;
        const enabled = step.enabled ?? (done || active);

        const circle = (
          <span
            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border font-medium text-xs ${
              done
                ? "border-emerald-600/40 bg-emerald-600/10 text-emerald-700"
                : active
                  ? "border-primary bg-primary text-primary-foreground"
                  : "text-muted-foreground"
            }`}
          >
            {done ? <Check className="h-3.5 w-3.5" /> : index + 1}
          </span>
        );

        const text = (
          <span
            className={`hidden truncate text-xs sm:inline ${
              active ? "font-medium text-foreground" : "text-muted-foreground"
            }`}
          >
            {step.label}
          </span>
        );

        return (
          <li className="flex min-w-0 flex-1 items-center gap-2" key={step.id}>
            {onSelect && enabled ? (
              <button
                aria-current={active ? "step" : undefined}
                className="flex min-w-0 items-center gap-2 rounded-md hover:opacity-80"
                onClick={() => onSelect(step.id)}
                type="button"
              >
                {circle}
                {text}
              </button>
            ) : (
              <span
                aria-current={active ? "step" : undefined}
                className="flex min-w-0 items-center gap-2"
              >
                {circle}
                {text}
              </span>
            )}

            {/* Fills whatever is left of the row, so the steps space themselves
                evenly however many there are. */}
            {index < steps.length - 1 ? (
              <span aria-hidden className="h-px min-w-2 flex-1 bg-border" />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
