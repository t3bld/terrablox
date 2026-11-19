"use client";

import { Badge } from "@terrablox/ui/badge";
import { Button } from "@terrablox/ui/button";
import { Disclosure } from "@terrablox/ui/disclosure";
import { Input } from "@terrablox/ui/input";
import { Label } from "@terrablox/ui/label";
import { OptionPicker } from "@terrablox/ui/option-picker";
import { Skeleton } from "@terrablox/ui/skeleton";
import { Slider } from "@terrablox/ui/slider";
import { ToggleRow } from "@terrablox/ui/toggle-row";
import { AlertCircle, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import type {
  Ec2ModuleCostScenario,
  ModuleCostBreakdownItem,
  ModuleInfracostEstimate,
} from "@/lib/module-library/infracost-scenario-types";

const DEBOUNCE_MS = 900;
const INSTANCE_TYPES = [
  "t3.nano",
  "t3.micro",
  "t3.small",
  "t3.medium",
  "t3.large",
  "t3.xlarge",
  "t3a.micro",
  "t3a.small",
  "t3a.medium",
  "m6i.large",
  "m6i.xlarge",
  "c6i.large",
  "r6i.large",
];

const SCENARIO_PRESETS: Array<{
  id: "low" | "medium" | "high";
  label: string;
  description: string;
  scenario: Ec2ModuleCostScenario;
}> = [
  {
    id: "low",
    label: "Low",
    description: "1 × t3.micro · 8 GB gp3",
    scenario: {
      instanceCount: 1,
      instanceType: "t3.micro",
      monitoring: false,
      createEip: false,
      tenancy: "default",
      rootVolume: {
        enabled: true,
        type: "gp3",
        size: 8,
        iops: 3000,
        throughput: 125,
      },
    },
  },
  {
    id: "medium",
    label: "Medium",
    description: "2 × t3.small · 50 GB gp3 · monitoring",
    scenario: {
      instanceCount: 2,
      instanceType: "t3.small",
      monitoring: true,
      createEip: false,
      tenancy: "default",
      rootVolume: {
        enabled: true,
        type: "gp3",
        size: 50,
        iops: 3000,
        throughput: 125,
      },
    },
  },
  {
    id: "high",
    label: "High",
    description: "4 × m6i.large · 200 GB gp3 · monitoring",
    scenario: {
      instanceCount: 4,
      instanceType: "m6i.large",
      monitoring: true,
      createEip: true,
      tenancy: "default",
      rootVolume: {
        enabled: true,
        type: "gp3",
        size: 200,
        iops: 3000,
        throughput: 125,
      },
    },
  },
];

function copyScenario(scenario: Ec2ModuleCostScenario): Ec2ModuleCostScenario {
  return { ...scenario, rootVolume: { ...scenario.rootVolume } };
}

function sameScenario(
  left: Ec2ModuleCostScenario,
  right: Ec2ModuleCostScenario,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

const money = new Intl.NumberFormat("de-DE", {
  style: "currency",
  currency: "EUR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function RangeField({
  id,
  label,
  max,
  min,
  onChange,
  step = 1,
  unit,
  value,
}: {
  id: string;
  label: string;
  max: number;
  min: number;
  onChange: (value: number) => void;
  step?: number;
  unit: string;
  value: number;
}) {
  const update = (raw: string) => {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return;
    onChange(Math.min(max, Math.max(min, parsed)));
  };

  return (
    <div className="grid grid-cols-[auto_minmax(5rem,1fr)_auto] items-center gap-3">
      <Label className="text-xs" htmlFor={id}>
        {label}
      </Label>
      <Slider
        id={id}
        max={max}
        min={min}
        onChange={(event) => update(event.target.value)}
        step={step}
        value={value}
      />
      <div className="flex items-center gap-2">
        <Input
          aria-label={`${label} numeric value`}
          className="h-8 w-20 text-right tabular-nums"
          max={max}
          min={min}
          onChange={(event) => update(event.target.value)}
          step={step}
          type="number"
          value={value}
        />
        <span className="w-16 text-xs text-muted-foreground">{unit}</span>
      </div>
    </div>
  );
}

function CostBars({ items }: { items: ModuleCostBreakdownItem[] }) {
  const max = Math.max(...items.map((item) => item.monthlyCost), 1);

  return (
    <ul className="space-y-3">
      {items.map((item) => (
        <li key={item.name}>
          <div className="mb-1 flex items-center justify-between gap-3 text-xs">
            <span className="min-w-0 truncate">{item.name}</span>
            <span className="shrink-0 font-medium tabular-nums">
              {money.format(item.monthlyCost)}
            </span>
          </div>
          <span className="block h-2 overflow-hidden rounded-full bg-muted">
            <span
              className="block h-full rounded-full bg-primary transition-[width]"
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

export function Ec2InfracostConfigurator({
  defaultInstanceType,
  moduleId,
}: {
  defaultInstanceType: string;
  moduleId: string;
}) {
  const lowPreset = SCENARIO_PRESETS[0];
  const [scenario, setScenario] = useState<Ec2ModuleCostScenario>(() =>
    lowPreset
      ? copyScenario({
          ...lowPreset.scenario,
          instanceType: defaultInstanceType || lowPreset.scenario.instanceType,
        })
      : {
          instanceCount: 1,
          instanceType: defaultInstanceType || "t3.micro",
          monitoring: false,
          createEip: false,
          tenancy: "default",
          rootVolume: {
            enabled: true,
            type: "gp3",
            size: 8,
            iops: 3000,
            throughput: 125,
          },
        },
  );
  const [estimate, setEstimate] = useState<ModuleInfracostEstimate | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
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
  }, [moduleId, scenario, retry]);

  const selectedPreset = SCENARIO_PRESETS.find((preset) =>
    sameScenario(preset.scenario, scenario),
  )?.id;

  return (
    <section aria-busy={loading} className="rounded-lg border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b p-4">
        <div>
          <h2 className="font-semibold text-sm">Cost Calculation</h2>
        </div>
      </div>

      <div className="grid items-start gap-5 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(24rem,0.9fr)]">
        <div className="space-y-3">
          <fieldset className="grid grid-cols-3 gap-2">
            <legend className="sr-only">Example scenarios</legend>
            {SCENARIO_PRESETS.map((preset) => (
              <Button
                aria-pressed={selectedPreset === preset.id}
                className="h-auto min-w-0 flex-col items-start gap-0.5 px-3 py-2 text-left"
                key={preset.id}
                onClick={() => setScenario(copyScenario(preset.scenario))}
                variant={selectedPreset === preset.id ? "default" : "outline"}
              >
                <span className="font-medium">{preset.label}</span>
                <span
                  className={`w-full truncate text-[10px] ${
                    selectedPreset === preset.id
                      ? "text-primary-foreground/70"
                      : "text-muted-foreground"
                  }`}
                  title={preset.description}
                >
                  {preset.description}
                </span>
              </Button>
            ))}
          </fieldset>

          <Disclosure title="Compute">
            <RangeField
              id="ec2-instance-count"
              label="Instances"
              max={20}
              min={1}
              onChange={(instanceCount) =>
                setScenario((current) => ({ ...current, instanceCount }))
              }
              unit="instances"
              value={scenario.instanceCount}
            />
            <OptionPicker
              id="ec2-instance-type"
              label="Instance type"
              onChange={(instanceType) =>
                setScenario((current) => ({ ...current, instanceType }))
              }
              options={INSTANCE_TYPES.map((type) => ({
                value: type,
                label: type,
              }))}
              value={scenario.instanceType}
            />
            <OptionPicker
              id="ec2-tenancy"
              label="Tenancy"
              onChange={(tenancy) =>
                setScenario((current) => ({
                  ...current,
                  tenancy: tenancy as "default" | "dedicated",
                }))
              }
              options={[
                { value: "default", label: "Shared tenancy" },
                { value: "dedicated", label: "Dedicated instance" },
              ]}
              value={scenario.tenancy}
            />
          </Disclosure>

          <Disclosure title="Options">
            <div className="space-y-2">
              <ToggleRow
                className="p-2.5"
                description="Adds the EC2 detailed monitoring charge."
                label="Detailed monitoring"
                on={scenario.monitoring}
                onToggle={() =>
                  setScenario((current) => ({
                    ...current,
                    monitoring: !current.monitoring,
                  }))
                }
              />
              <ToggleRow
                className="p-2.5"
                description="Creates a public Elastic IP for each instance."
                label="Elastic IP"
                on={scenario.createEip}
                onToggle={() =>
                  setScenario((current) => ({
                    ...current,
                    createEip: !current.createEip,
                  }))
                }
              />
            </div>
          </Disclosure>

          <Disclosure title="Storage">
            <ToggleRow
              className="p-2.5"
              description="Includes an explicit EBS root volume in the estimate."
              label="Root volume"
              on={scenario.rootVolume.enabled}
              onToggle={() =>
                setScenario((current) => ({
                  ...current,
                  rootVolume: {
                    ...current.rootVolume,
                    enabled: !current.rootVolume.enabled,
                  },
                }))
              }
            />
            {scenario.rootVolume.enabled ? (
              <div className="space-y-4 border-t pt-4">
                <OptionPicker
                  id="ec2-volume-type"
                  label="Root volume type"
                  onChange={(type) =>
                    setScenario((current) => ({
                      ...current,
                      rootVolume: {
                        ...current.rootVolume,
                        type: type as Ec2ModuleCostScenario["rootVolume"]["type"],
                      },
                    }))
                  }
                  options={[
                    { value: "gp3", label: "gp3 · General Purpose SSD" },
                    { value: "gp2", label: "gp2 · General Purpose SSD" },
                    { value: "io1", label: "io1 · Provisioned IOPS SSD" },
                    { value: "io2", label: "io2 · Provisioned IOPS SSD" },
                  ]}
                  value={scenario.rootVolume.type}
                />
                <RangeField
                  id="ec2-volume-size"
                  label="Root volume size"
                  max={1000}
                  min={1}
                  onChange={(size) =>
                    setScenario((current) => ({
                      ...current,
                      rootVolume: { ...current.rootVolume, size },
                    }))
                  }
                  unit="GB"
                  value={scenario.rootVolume.size}
                />
                {scenario.rootVolume.type !== "gp2" ? (
                  <RangeField
                    id="ec2-volume-iops"
                    label="Provisioned IOPS"
                    max={64_000}
                    min={100}
                    onChange={(iops) =>
                      setScenario((current) => ({
                        ...current,
                        rootVolume: { ...current.rootVolume, iops },
                      }))
                    }
                    step={100}
                    unit="IOPS"
                    value={scenario.rootVolume.iops}
                  />
                ) : null}
                {scenario.rootVolume.type === "gp3" ? (
                  <RangeField
                    id="ec2-volume-throughput"
                    label="Throughput"
                    max={1000}
                    min={125}
                    onChange={(throughput) =>
                      setScenario((current) => ({
                        ...current,
                        rootVolume: { ...current.rootVolume, throughput },
                      }))
                    }
                    step={25}
                    unit="MiB/s"
                    value={scenario.rootVolume.throughput}
                  />
                ) : null}
              </div>
            ) : null}
          </Disclosure>
        </div>

        <div className="min-w-0 space-y-4 lg:sticky lg:top-4">
          {!estimate && loading ? (
            <div className="grid gap-3">
              <Skeleton className="h-28 w-full" />
              <Skeleton className="h-56 w-full" />
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
            <div>
              <div aria-live="polite" className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-md border bg-muted/20 p-4">
                    <p className="text-xs text-muted-foreground">Monthly</p>
                    {loading ? (
                      <Skeleton className="mt-2 h-8 w-28" />
                    ) : (
                      <p className="mt-1 text-2xl font-semibold tabular-nums">
                        {money.format(estimate.totalMonthlyCost)}
                      </p>
                    )}
                  </div>
                  <div className="rounded-md border bg-muted/20 p-4">
                    <p className="text-xs text-muted-foreground">12 months</p>
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
                  <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                    <h3 className="font-medium text-sm">Cost by service</h3>
                    <div className="flex flex-wrap gap-1.5">
                      <Badge variant="secondary">
                        {scenario.instanceCount} × {scenario.instanceType}
                      </Badge>
                      {scenario.rootVolume.enabled ? (
                        <Badge variant="secondary">
                          {scenario.rootVolume.size} GB{" "}
                          {scenario.rootVolume.type}
                        </Badge>
                      ) : null}
                      {scenario.monitoring ? (
                        <Badge variant="secondary">Monitoring</Badge>
                      ) : null}
                    </div>
                  </div>
                  {loading ? (
                    <div className="space-y-3">
                      {[0, 1].map((row) => (
                        <div className="space-y-1.5" key={row}>
                          <div className="flex justify-between gap-3">
                            <Skeleton className="h-3 w-20" />
                            <Skeleton className="h-3 w-16" />
                          </div>
                          <Skeleton className="h-2 w-full rounded-full" />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <CostBars items={estimate.byService} />
                  )}
                </div>
              </div>

              {!loading && estimate.diagnostics.length > 0 ? (
                <ul className="mt-4 space-y-1 text-xs text-amber-700 dark:text-amber-400">
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
