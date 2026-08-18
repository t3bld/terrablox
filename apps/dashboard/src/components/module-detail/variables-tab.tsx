"use client";

import { Badge } from "@terrablox/ui/badge";
import { Button } from "@terrablox/ui/button";
import { cn } from "@terrablox/ui/lib/utils";
import { EyeOff } from "lucide-react";
import { useMemo, useState } from "react";

import {
  EmptyMessage,
  FieldList,
  formatDefault,
  SearchField,
  TypeBadge,
} from "./field-primitives";
import type { ModuleOutputDto, ModuleVariableDto } from "./types";

type RequirementFilter = "all" | "required" | "optional";

interface VariablesTabProps {
  variables: ModuleVariableDto[];
  outputs: ModuleOutputDto[];
}

function InputRow({ variable }: { variable: ModuleVariableDto }) {
  const hasDefault = Object.hasOwn(variable, "default");
  const defaultText = hasDefault ? formatDefault(variable.default) : null;
  const isMultilineDefault =
    (defaultText?.length ?? 0) > 60 || (defaultText?.includes("\n") ?? false);

  return (
    <div className="group border-b px-4 py-3 last:border-b-0 hover:bg-muted/40">
      <div className="flex flex-wrap items-center gap-2">
        <code className="font-medium font-mono text-sm">{variable.name}</code>

        {variable.required ? (
          <Badge variant="destructive">required</Badge>
        ) : (
          <Badge variant="secondary">optional</Badge>
        )}

        {variable.sensitive ? (
          <Badge variant="warning">
            <EyeOff className="h-3 w-3" />
            sensitive
          </Badge>
        ) : null}

        <span className="ml-auto min-w-0 max-w-full sm:max-w-[60%]">
          <TypeBadge type={variable.type} />
        </span>
      </div>

      {variable.description ? (
        <p className="mt-1.5 text-muted-foreground text-sm">
          {variable.description}
        </p>
      ) : null}

      {defaultText !== null ? (
        <div
          className={cn(
            "mt-2 text-xs",
            isMultilineDefault
              ? "flex flex-col gap-1"
              : "flex items-start gap-2",
          )}
        >
          <span className="shrink-0 pt-0.5 text-muted-foreground">Default</span>
          <code
            className={cn(
              "min-w-0 rounded bg-muted px-1.5 py-0.5 font-mono text-muted-foreground",
              isMultilineDefault &&
                "block max-h-40 w-full overflow-auto whitespace-pre",
            )}
          >
            {defaultText}
          </code>
        </div>
      ) : null}
    </div>
  );
}

function OutputRow({ output }: { output: ModuleOutputDto }) {
  return (
    <div className="group border-b px-4 py-3 last:border-b-0 hover:bg-muted/40">
      <div className="flex flex-wrap items-center gap-2">
        <code className="font-medium font-mono text-sm">{output.name}</code>
        {output.sensitive ? (
          <Badge variant="warning">
            <EyeOff className="h-3 w-3" />
            sensitive
          </Badge>
        ) : null}
      </div>

      {output.description ? (
        <p className="mt-1.5 text-muted-foreground text-sm">
          {output.description}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Tells the reader that a folded-away section holds matches, so a search can
 * never appear to come up empty while the answer sits inside a closed list.
 */
function HiddenMatches({ count }: { count: number }) {
  return (
    <span className="ml-auto text-muted-foreground text-xs">
      {count} match{count === 1 ? "" : "es"} hidden — click to show
    </span>
  );
}

/**
 * A module's interface in one place: what it takes and what it hands back.
 *
 * The two are folded into a single tab because they are read together — you
 * wire an output of one module into an input of the next — and each list can be
 * collapsed so a module with 47 inputs does not bury its 15 outputs.
 */
export function VariablesTab({ variables, outputs }: VariablesTabProps) {
  const [query, setQuery] = useState("");
  const [requirement, setRequirement] = useState<RequirementFilter>("all");
  const [showFilterSettings, setShowFilterSettings] = useState(false);
  const [showInputs, setShowInputs] = useState(true);
  const [showOutputs, setShowOutputs] = useState(true);

  const needle = query.trim().toLowerCase();

  const sortedVariables = useMemo(
    () =>
      [...variables].sort((a, b) => {
        // The DTO type allows `required` to be absent, and the filter below
        // treats a missing flag as optional — so compare the same coercion
        // rather than the raw values, where `undefined !== false` would split
        // two optional variables into different groups.
        const aRequired = a.required === true;
        const bRequired = b.required === true;
        if (aRequired !== bRequired) return aRequired ? -1 : 1;
        return a.name.localeCompare(b.name, "en", { numeric: true });
      }),
    [variables],
  );

  const sortedOutputs = useMemo(
    () =>
      [...outputs].sort((a, b) =>
        a.name.localeCompare(b.name, "en", { numeric: true }),
      ),
    [outputs],
  );

  const filteredInputs = useMemo(
    () =>
      sortedVariables.filter((v) => {
        if (requirement === "required" && !v.required) return false;
        if (requirement === "optional" && v.required) return false;
        if (!needle) return true;

        return (
          v.name.toLowerCase().includes(needle) ||
          (v.description?.toLowerCase().includes(needle) ?? false) ||
          (v.type?.toLowerCase().includes(needle) ?? false)
        );
      }),
    [sortedVariables, needle, requirement],
  );

  const filteredOutputs = useMemo(() => {
    if (!needle) return sortedOutputs;

    return sortedOutputs.filter(
      (o) =>
        o.name.toLowerCase().includes(needle) ||
        (o.description?.toLowerCase().includes(needle) ?? false),
    );
  }, [sortedOutputs, needle]);

  const requiredCount = variables.filter((v) => v.required).length;
  const isSearching = needle.length > 0;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <SearchField
          onChange={setQuery}
          placeholder="Filter inputs and outputs…"
          value={query}
        />

        <button
          aria-expanded={showFilterSettings}
          className="text-left text-muted-foreground text-sm hover:text-foreground"
          onClick={() => setShowFilterSettings((open) => !open)}
          type="button"
        >
          Filter settings
        </button>

        {showFilterSettings ? (
          <fieldset
            aria-label="Filter inputs by requirement"
            className="flex flex-wrap gap-1 rounded-md border p-1"
          >
            {(
              [
                ["all", `All ${variables.length}`],
                ["required", `Required ${requiredCount}`],
                ["optional", `Optional ${variables.length - requiredCount}`],
              ] as const
            ).map(([value, label]) => (
              <Button
                className="h-7 px-2.5 text-xs"
                key={value}
                onClick={() => setRequirement(value)}
                size="sm"
                type="button"
                variant={requirement === value ? "secondary" : "ghost"}
              >
                {label}
              </Button>
            ))}
          </fieldset>
        ) : null}
      </div>

      {isSearching &&
      filteredInputs.length === 0 &&
      filteredOutputs.length === 0 ? (
        <p className="rounded-lg border border-dashed py-8 text-center text-muted-foreground text-sm">
          Nothing matches “{query.trim()}”.
        </p>
      ) : null}

      <FieldList
        collapsible
        hint={
          !showInputs && isSearching && filteredInputs.length > 0 ? (
            <HiddenMatches count={filteredInputs.length} />
          ) : null
        }
        onToggle={() => setShowInputs((open) => !open)}
        open={variables.length > 0 && showInputs}
        shown={filteredInputs.length}
        title="Inputs"
        total={variables.length}
      >
        {filteredInputs.length === 0 ? (
          <EmptyMessage>
            {variables.length === 0
              ? "This module declares no input variables."
              : "No inputs match the current filter."}
          </EmptyMessage>
        ) : (
          filteredInputs.map((v) => (
            <InputRow key={`${v.file ?? ""}:${v.name}`} variable={v} />
          ))
        )}
      </FieldList>

      <FieldList
        collapsible
        hint={
          !showOutputs && isSearching && filteredOutputs.length > 0 ? (
            <HiddenMatches count={filteredOutputs.length} />
          ) : null
        }
        onToggle={() => setShowOutputs((open) => !open)}
        open={outputs.length > 0 && showOutputs}
        shown={filteredOutputs.length}
        title="Outputs"
        total={outputs.length}
      >
        {filteredOutputs.length === 0 ? (
          <EmptyMessage>
            {outputs.length === 0
              ? "This module declares no outputs."
              : "No outputs match the current filter."}
          </EmptyMessage>
        ) : (
          filteredOutputs.map((o) => (
            <OutputRow key={`${o.file ?? ""}:${o.name}`} output={o} />
          ))
        )}
      </FieldList>
    </div>
  );
}
