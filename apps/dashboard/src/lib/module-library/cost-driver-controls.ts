import type {
  CostClass,
  CostDriverEntry,
} from "@terrablox/terraform/aws-cost-drivers";
import type {
  ModuleCostDriverControl,
  ModuleCostDriverModel,
} from "@/lib/module-library/cost-pricing-types";
import type { ModuleVariableDto } from "@/lib/module-library/types";

/** Matches a loose cost-driver fragment only across complete variable-name segments. */
export function matchesCostDriverFragment(
  variableName: string,
  fragment: string,
): boolean {
  const segments = variableName
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const wanted = fragment
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  if (wanted.length === 0 || wanted.length > segments.length) return false;
  for (let start = 0; start + wanted.length <= segments.length; start += 1) {
    if (wanted.every((part, offset) => segments[start + offset] === part)) {
      return true;
    }
  }
  return false;
}

function numericBounds(name: string, value: number | null) {
  const lower = name.toLowerCase();
  const max = /request|invocation|transition/.test(lower)
    ? 10_000_000
    : /iops/.test(lower)
      ? 100_000
      : /storage|volume|memory|throughput|capacity|size/.test(lower)
        ? 10_000
        : Math.max(100, Math.ceil((value ?? 10) * 4));
  const step = max >= 1_000_000 ? 10_000 : max >= 10_000 ? 100 : 1;
  return { min: 0, max, step };
}

const CATEGORICAL_OPTIONS: Readonly<
  Record<string, Array<{ value: string; label: string }>>
> = {
  instance_type: [
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
  ].map((value) => ({ value, label: value })),
  instance_class: [
    "db.t3.micro",
    "db.t3.small",
    "db.t3.medium",
    "db.t3.large",
    "db.t4g.micro",
    "db.t4g.small",
    "db.t4g.medium",
    "db.m6g.large",
    "db.m6g.xlarge",
    "db.r6g.large",
  ].map((value) => ({ value, label: value })),
  engine: [
    "postgres",
    "mysql",
    "mariadb",
    "aurora-postgresql",
    "aurora-mysql",
  ].map((value) => ({ value, label: value })),
  storage_type: ["gp3", "gp2", "io1", "io2"].map((value) => ({
    value,
    label: value,
  })),
  volume_type: ["gp3", "gp2", "io1", "io2"].map((value) => ({
    value,
    label: value,
  })),
  load_balancer_type: ["application", "network", "gateway"].map((value) => ({
    value,
    label: value,
  })),
  billing_mode: ["PAY_PER_REQUEST", "PROVISIONED"].map((value) => ({
    value,
    label: value,
  })),
  launch_type: ["FARGATE", "EC2"].map((value) => ({ value, label: value })),
  stream_mode: ["ON_DEMAND", "PROVISIONED"].map((value) => ({
    value,
    label: value,
  })),
  engine_mode: ["provisioned", "serverless"].map((value) => ({
    value,
    label: value,
  })),
  throughput_mode: ["bursting", "provisioned", "elastic"].map((value) => ({
    value,
    label: value,
  })),
  tier: ["Standard", "Advanced", "Intelligent-Tiering"].map((value) => ({
    value,
    label: value,
  })),
};

export function categoricalCostOptions(
  variableName: string,
): ReadonlyArray<{ value: string; label: string }> | null {
  return CATEGORICAL_OPTIONS[variableName] ?? null;
}

function variableControl(
  variable: ModuleVariableDto,
  costClass: CostClass | "unclassified",
): ModuleCostDriverControl {
  const value = Object.hasOwn(variable, "default")
    ? variable.default
    : undefined;
  const growsWithWorkload =
    costClass === "usage" ||
    /request|invocation|transition|traffic|data|storage|throughput|capacity|count/i.test(
      variable.name,
    );

  if (typeof value === "boolean" || variable.type?.includes("bool")) {
    return {
      kind: "boolean",
      id: variable.name,
      label: variable.name,
      defaultValue: typeof value === "boolean" ? value : null,
      sourceVariable: variable.name,
    };
  }

  if (Array.isArray(value)) {
    const bounds = numericBounds(variable.name, value.length);
    return {
      kind: "number",
      id: variable.name,
      label: `${variable.name} items`,
      unit: "items",
      defaultValue: value.length,
      growsWithWorkload,
      sourceVariable: variable.name,
      ...bounds,
    };
  }

  if (typeof value === "number" || variable.type?.includes("number")) {
    const number = typeof value === "number" ? value : null;
    return {
      kind: "number",
      id: variable.name,
      label: variable.name,
      unit: "value",
      defaultValue: number,
      growsWithWorkload,
      sourceVariable: variable.name,
      ...numericBounds(variable.name, number),
    };
  }

  const options = CATEGORICAL_OPTIONS[variable.name];
  if (options) {
    const current = typeof value === "string" && value !== "" ? value : null;
    return {
      kind: "select",
      id: variable.name,
      label: variable.name,
      defaultValue: current,
      options:
        current && !options.some((option) => option.value === current)
          ? [{ value: current, label: current }, ...options]
          : options,
      sourceVariable: variable.name,
    };
  }

  return {
    kind: "text",
    id: variable.name,
    label: variable.name,
    defaultValue: typeof value === "string" && value !== "" ? value : null,
    sourceVariable: variable.name,
  };
}

export function buildUnpricedDriverModel(input: {
  resourceType: string;
  count: number;
  entry: CostDriverEntry | null;
  variables: ModuleVariableDto[];
}): ModuleCostDriverModel {
  const costClass = input.entry?.costClass ?? "unclassified";
  const matched = input.entry?.sizedBy
    ? input.variables.filter((variable) =>
        input.entry?.sizedBy?.some((fragment) =>
          matchesCostDriverFragment(variable.name, fragment),
        ),
      )
    : [];

  const controls: ModuleCostDriverControl[] = [
    {
      kind: "number",
      id: "declaredResources",
      label: "Potential resource blocks",
      unit: "blocks",
      min: 0,
      max: Math.max(20, input.count * 4),
      step: 1,
      defaultValue: input.count,
      growsWithWorkload: false,
      sourceVariable: null,
    },
    ...matched.map((variable) => variableControl(variable, costClass)),
  ];

  return {
    id: `driver:${input.resourceType}`,
    resourceType: input.resourceType,
    costClass,
    driver:
      input.entry?.driver ??
      "No quantitative model exists for this resource type yet.",
    controls,
    reason:
      "The imported module does not resolve enough AWS SKU dimensions for a reliable monetary price.",
  };
}
