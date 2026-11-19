"use client";

import { Badge } from "@terrablox/ui/badge";
import { Button } from "@terrablox/ui/button";
import { Disclosure } from "@terrablox/ui/disclosure";
import { Label } from "@terrablox/ui/label";
import { OptionPicker } from "@terrablox/ui/option-picker";
import { Skeleton } from "@terrablox/ui/skeleton";
import { Slider } from "@terrablox/ui/slider";
import { AlertCircle, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  type CostInputControl,
  costInputControl,
  unpriceableRequiredInputs,
} from "@/lib/module-library/cost-input-policy";
import type {
  ModuleInfracostEstimate,
  ModuleScenarioValue,
} from "@/lib/module-library/infracost-scenario-types";
import type { ModuleVariableDto } from "@/lib/module-library/types";

const DEBOUNCE_MS = 900;
const MAX_CONTROLS = 24;
const PRIMARY_COST_INPUT =
  /(?:instance_type|instance_class|allocated_storage|storage_type|volume_size|volume_type|iops|throughput|desired_count|min_size|max_size|memory_size|cpu|billing_mode|read_capacity|write_capacity|retention_in_days|enable_nat_gateway)/i;

/** Choices first, then the inputs that most often size a bill, then switches. */
function controlScore(variable: ModuleVariableDto, control: CostInputControl) {
  if (control.kind === "choice") return 0;
  if (PRIMARY_COST_INPUT.test(variable.name)) return 1;
  if (control.kind === "number") return 2;
  return 3;
}

const money = new Intl.NumberFormat("de-DE", {
  style: "currency",
  currency: "EUR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

type Field = { variable: ModuleVariableDto; control: CostInputControl };
type Drafts = Record<string, string>;

function initialDraft(control: CostInputControl): string {
  return control.defaultValue === null ? "" : String(control.defaultValue);
}

function parseDraft(
  control: CostInputControl,
  draft: string,
): ModuleScenarioValue | undefined {
  if (draft === "") return undefined;
  if (control.kind === "boolean") return draft === "true";
  if (control.kind === "number") {
    const value = Number(draft);
    return Number.isFinite(value) ? value : undefined;
  }
  return draft;
}

function CostBars({ estimate }: { estimate: ModuleInfracostEstimate }) {
  const max = Math.max(
    ...estimate.byService.map((item) => item.monthlyCost),
    1,
  );
  return (
    <ul className="space-y-3">
      {estimate.byService.map((item) => (
        <li key={item.name}>
          <div className="mb-1 flex items-center justify-between gap-3 text-xs">
            <span className="min-w-0 truncate">{item.name}</span>
            <span className="shrink-0 font-medium tabular-nums">
              {money.format(item.monthlyCost)}
            </span>
          </div>
          <span className="block h-2 overflow-hidden rounded-full bg-muted">
            <span
              className="block h-full rounded-full bg-primary"
              style={{
                width: `${Math.max(2, (item.monthlyCost / max) * 100)}%`,
              }}
            />
          </span>
        </li>
      ))}
    </ul>
  );
}

function VariableField({
  draft,
  field,
  onChange,
}: {
  draft: string;
  field: Field;
  onChange: (value: string) => void;
}) {
  const { variable, control } = field;
  const id = `module-cost-${variable.name}`;

  if (control.kind === "number") {
    return (
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(5rem,1fr)_auto] items-center gap-3 sm:col-span-2">
        <Label className="truncate font-mono text-xs" htmlFor={id}>
          {variable.name}
        </Label>
        <Slider
          id={id}
          max={control.max}
          min={control.min}
          onChange={(event) => onChange(event.target.value)}
          step={control.step}
          value={Number(draft || control.defaultValue)}
        />
        <span className="w-16 text-right text-xs tabular-nums">
          {Number(draft || control.defaultValue).toLocaleString()}
        </span>
      </div>
    );
  }

  const options =
    control.kind === "boolean"
      ? [
          { value: "true", label: "Enabled" },
          { value: "false", label: "Disabled" },
        ]
      : control.options;
  return (
    <OptionPicker
      id={id}
      label={variable.name}
      onChange={onChange}
      options={
        control.defaultValue === null
          ? [
              {
                value: "",
                label: variable.required ? "Choose a value" : "Module default",
              },
              ...options,
            ]
          : options
      }
      value={draft}
    />
  );
}

export function GenericInfracostConfigurator({
  moduleId,
  variables,
}: {
  moduleId: string;
  variables: ModuleVariableDto[];
}) {
  const fields = useMemo<Field[]>(
    () =>
      variables
        .flatMap((variable) => {
          const control = costInputControl(variable);
          return control ? [{ variable, control }] : [];
        })
        .sort(
          (left, right) =>
            Number(right.variable.required) - Number(left.variable.required) ||
            controlScore(left.variable, left.control) -
              controlScore(right.variable, right.control) ||
            left.variable.name.localeCompare(right.variable.name),
        )
        .slice(0, MAX_CONTROLS),
    [variables],
  );
  const unpriceable = useMemo(
    () => unpriceableRequiredInputs(variables),
    [variables],
  );
  const [moduleCount, setModuleCount] = useState(1);
  const [drafts, setDrafts] = useState<Drafts>(() =>
    Object.fromEntries(
      fields.map(({ variable, control }) => [
        variable.name,
        initialDraft(control),
      ]),
    ),
  );
  const [estimate, setEstimate] = useState<ModuleInfracostEstimate | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  const scenario = useMemo(() => {
    if (unpriceable.length > 0) return null;
    const inputs: Record<string, ModuleScenarioValue> = {};
    for (const { variable, control } of fields) {
      const parsed = parseDraft(control, drafts[variable.name] ?? "");
      if (parsed === undefined) {
        if (variable.required) return null;
        continue;
      }
      // Unchanged defaults are left to the module, so a scan only ever
      // carries what the user actually moved.
      if (parsed === control.defaultValue) continue;
      inputs[variable.name] = parsed;
    }
    return { kind: "generic" as const, moduleCount, inputs };
  }, [fields, unpriceable, drafts, moduleCount]);

  useEffect(() => {
    if (!scenario) {
      setLoading(false);
      setEstimate(null);
      setError(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      setError(null);
      void fetch(
        `/api/modules/${encodeURIComponent(moduleId)}/pricing?retry=${retry}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(scenario),
          signal: controller.signal,
        },
      )
        .then(async (response) => {
          const body = await response.json().catch(() => null);
          if (!response.ok) {
            throw new Error(
              body?.error ?? `Cost estimate failed (${response.status})`,
            );
          }
          return body?.estimate as ModuleInfracostEstimate;
        })
        .then((next) => {
          if (!controller.signal.aborted) setEstimate(next);
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted) {
            setEstimate(null);
            setError(
              cause instanceof Error ? cause.message : "Cost estimate failed",
            );
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [moduleId, retry, scenario]);

  const selectedPreset =
    moduleCount === 1
      ? "low"
      : moduleCount === 2
        ? "medium"
        : moduleCount === 4
          ? "high"
          : null;
  const setDraft = (name: string, value: string) =>
    setDrafts((current) => ({ ...current, [name]: value }));

  return (
    <section aria-busy={loading} className="rounded-lg border bg-card">
      <div className="border-b p-4">
        <h2 className="font-semibold text-sm">Cost Calculation</h2>
      </div>
      <div className="grid items-start gap-5 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(24rem,0.9fr)]">
        <div className="space-y-3">
          <fieldset className="grid grid-cols-3 gap-2">
            <legend className="sr-only">Example scenarios</legend>
            {[
              { id: "low", label: "Low", count: 1 },
              { id: "medium", label: "Medium", count: 2 },
              { id: "high", label: "High", count: 4 },
            ].map((preset) => (
              <Button
                aria-pressed={selectedPreset === preset.id}
                className="h-auto flex-col items-start gap-0.5 px-3 py-2"
                key={preset.id}
                onClick={() => setModuleCount(preset.count)}
                variant={selectedPreset === preset.id ? "default" : "outline"}
              >
                <span>{preset.label}</span>
                <span
                  className={
                    selectedPreset === preset.id
                      ? "text-[10px] text-primary-foreground/70"
                      : "text-[10px] text-muted-foreground"
                  }
                >
                  {preset.count} module{" "}
                  {preset.count === 1 ? "instance" : "instances"}
                </span>
              </Button>
            ))}
          </fieldset>

          <Disclosure title="Configuration">
            <div className="grid grid-cols-[auto_minmax(5rem,1fr)_auto] items-center gap-3">
              <Label className="text-xs" htmlFor="module-cost-count">
                Module instances
              </Label>
              <Slider
                id="module-cost-count"
                max={20}
                min={1}
                onChange={(event) => setModuleCount(Number(event.target.value))}
                value={moduleCount}
              />
              <span className="w-16 text-right text-xs tabular-nums">
                {moduleCount}
              </span>
            </div>
          </Disclosure>

          {fields.length > 0 ? (
            <Disclosure title="Cost-related inputs">
              <div className="grid gap-4 sm:grid-cols-2">
                {fields.map((field) => (
                  <VariableField
                    draft={drafts[field.variable.name] ?? ""}
                    field={field}
                    key={field.variable.name}
                    onChange={(value) => setDraft(field.variable.name, value)}
                  />
                ))}
              </div>
            </Disclosure>
          ) : null}
        </div>

        <div className="min-w-0 space-y-4 lg:sticky lg:top-4">
          {!scenario ? (
            <div className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
              {unpriceable.length > 0
                ? `This module needs ${unpriceable.join(", ")}, which the calculator cannot choose for you.`
                : "Choose a value for each required input to calculate this module."}
            </div>
          ) : !estimate && loading ? (
            <div className="grid gap-3">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-48 w-full" />
            </div>
          ) : null}

          {error ? (
            <div
              className="flex items-start justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
              role="alert"
            >
              <span className="flex items-start gap-2">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                {error}
              </span>
              <Button
                onClick={() => setRetry((value) => value + 1)}
                size="sm"
                variant="outline"
              >
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                Retry
              </Button>
            </div>
          ) : null}

          {estimate ? (
            <div aria-live="polite" className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-md border bg-muted/20 p-4">
                  <p className="text-xs text-muted-foreground">
                    {estimate.partial ? "Monthly subtotal" : "Monthly"}
                  </p>
                  {loading ? (
                    <Skeleton className="mt-2 h-8 w-28" />
                  ) : (
                    <p className="mt-1 text-2xl font-semibold tabular-nums">
                      {money.format(estimate.totalMonthlyCost)}
                    </p>
                  )}
                </div>
                <div className="rounded-md border bg-muted/20 p-4">
                  <p className="text-xs text-muted-foreground">
                    {estimate.partial ? "12-month subtotal" : "12 months"}
                  </p>
                  {loading ? (
                    <Skeleton className="mt-2 h-8 w-28" />
                  ) : (
                    <p className="mt-1 text-2xl font-semibold tabular-nums">
                      {money.format(estimate.totalAnnualCost)}
                    </p>
                  )}
                </div>
              </div>
              <div className="rounded-md border p-4">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-medium text-sm">Cost by service</h3>
                  <Badge variant="secondary">{moduleCount} × module</Badge>
                </div>
                {loading ? (
                  <div className="space-y-3">
                    {[0, 1].map((row) => (
                      <Skeleton className="h-8 w-full" key={row} />
                    ))}
                  </div>
                ) : estimate.byService.length > 0 ? (
                  <CostBars estimate={estimate} />
                ) : (
                  <p className="text-xs text-muted-foreground">
                    No priced service components returned.
                  </p>
                )}
              </div>
              {!loading && estimate.diagnostics.length > 0 ? (
                <ul className="space-y-1 text-xs text-amber-700 dark:text-amber-400">
                  {estimate.diagnostics.map((diagnostic) => (
                    <li key={`${diagnostic.severity}:${diagnostic.message}`}>
                      {diagnostic.message}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
