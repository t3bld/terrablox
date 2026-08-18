"use client";

import * as React from "react";

import { cn } from "./lib/utils";

export interface ToggleRowProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onToggle"> {
  label: string;
  description?: React.ReactNode;
  on: boolean;
  onToggle: () => void;
  /** Shown on the right, e.g. where an inherited value came from. */
  hint?: React.ReactNode;
}

/**
 * A labelled on/off row.
 *
 * A button rather than a checkbox so the whole row is the target, with
 * `aria-pressed` carrying the state that the visual square only implies.
 */
const ToggleRow = React.forwardRef<HTMLButtonElement, ToggleRowProps>(
  (
    { className, description, disabled, hint, label, on, onToggle, ...props },
    ref,
  ) => (
    <button
      aria-pressed={on}
      className={cn(
        "flex w-full items-start gap-3 rounded-md border p-3 text-left transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-60",
        on ? "border-primary bg-accent/50" : "border-border",
        className,
      )}
      disabled={disabled}
      onClick={onToggle}
      ref={ref}
      type="button"
      {...props}
    >
      <span
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border",
          on
            ? "border-primary bg-primary text-primary-foreground"
            : "border-input",
        )}
      />
      <span className="grid flex-1 gap-0.5">
        <span className="text-sm font-medium">{label}</span>
        {description ? (
          <span className="text-xs text-muted-foreground">{description}</span>
        ) : null}
      </span>
      {hint ? (
        <span className="shrink-0 text-xs text-muted-foreground">{hint}</span>
      ) : null}
    </button>
  ),
);
ToggleRow.displayName = "ToggleRow";

export { ToggleRow };
