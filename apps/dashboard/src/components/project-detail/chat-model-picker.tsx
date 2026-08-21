"use client";

import { Button } from "@terrablox/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@terrablox/ui/dropdown-menu";
import { ChevronDown, Cpu, Gauge } from "lucide-react";
import { useEffect, useState } from "react";

import { REASONING_EFFORTS } from "@/lib/agent/runtime-options";

interface ModelOption {
  id: string;
  name: string;
  reasoningEfforts: string[];
  multiplier: number | null;
}

export interface ModelSelection {
  model: string;
  reasoningEffort: string;
}

interface ChatModelPickerProps {
  disabled?: boolean;
  onChange: (selection: ModelSelection) => void;
  value: ModelSelection;
}

/**
 * Model and thinking effort for the next turn, in the composer.
 *
 * It belongs next to the message rather than in settings because the choice is
 * per question: a rename does not need what a refactor needs. The list comes
 * from the runtime, since entitlements differ per user and change without us.
 */
export function ChatModelPicker({
  disabled,
  onChange,
  value,
}: ChatModelPickerProps) {
  const [models, setModels] = useState<ModelOption[]>([]);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/agent/models")
      .then((res) => res.json())
      .then((body) => {
        if (!cancelled) setModels(body?.models ?? []);
      })
      .catch(() => {
        // A missing catalogue must not block sending; the defaults still apply.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const selected = models.find((entry) => entry.id === value.model);
  // An empty list from the runtime means "unknown", not "supports nothing".
  const efforts: readonly string[] = selected?.reasoningEfforts.length
    ? selected.reasoningEfforts
    : REASONING_EFFORTS;

  // The configured default can be outside the entitlement list, so it is
  // offered explicitly instead of silently resetting the user's choice.
  const options = selected
    ? models
    : [{ id: value.model, name: value.model, multiplier: null }, ...models];

  const selectedModel = options.find((entry) => entry.id === value.model);
  // Empty means the project's settings have not arrived yet. Saying so beats an
  // empty button, and the control is disabled until they do.
  const modelLabel = value.model
    ? (selectedModel?.name ?? value.model)
    : "Loading…";

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={`Model: ${modelLabel}`}
            className="h-8 max-w-[15rem] justify-start gap-1.5 px-2 text-xs"
            disabled={disabled}
            variant="outline"
          >
            <Cpu className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{modelLabel}</span>
            <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuLabel>Model</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup
            onValueChange={(model) => onChange({ ...value, model })}
            value={value.model}
          >
            <div className="max-h-64 overflow-y-auto">
              {options.map((entry) => (
                <DropdownMenuRadioItem key={entry.id} value={entry.id}>
                  <span className="min-w-0 truncate">{entry.name}</span>
                  {entry.multiplier ? (
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                      {entry.multiplier}x
                    </span>
                  ) : null}
                </DropdownMenuRadioItem>
              ))}
            </div>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={`Thinking effort: ${value.reasoningEffort}`}
            className="h-8 gap-1.5 px-2 text-xs"
            disabled={disabled}
            variant="outline"
          >
            <Gauge className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="capitalize">{value.reasoningEffort}</span>
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-48">
          <DropdownMenuLabel>Thinking effort</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup
            onValueChange={(reasoningEffort) =>
              onChange({ ...value, reasoningEffort })
            }
            value={value.reasoningEffort}
          >
            {efforts.map((effort) => (
              <DropdownMenuRadioItem key={effort} value={effort}>
                <span className="capitalize">{effort}</span>
                {effort === "high" ? (
                  <span className="ml-auto text-xs text-muted-foreground">
                    default
                  </span>
                ) : null}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
