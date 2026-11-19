import "server-only";

import { serviceOfResource } from "@terrablox/terraform/aws-services";
import {
  costInputControl,
  identityPlaceholders,
} from "@/lib/module-library/cost-input-policy";
import type {
  Ec2ModuleCostScenario,
  GenericModuleCostScenario,
  ModuleCostBreakdownItem,
  ModuleInfracostEstimate,
  ModuleScenarioValue,
} from "@/lib/module-library/infracost-scenario-types";
import type { ModuleVariableDto } from "@/lib/module-library/types";

const REGION = "eu-west-1" as const;
const CURRENCY = "EUR" as const;
const INFRACOST_VERSION = "2.18.3";
const TIMEOUT_MS = 150_000;

function infracostConfig(): string {
  return `${JSON.stringify(
    {
      version: "0.3",
      currency: CURRENCY,
      projects: [
        {
          name: "module",
          type: "terraform",
          path: ".",
          terraform: { var_files: ["terraform.auto.tfvars.json"] },
        },
      ],
    },
    null,
    2,
  )}\n`;
}

export class ModuleCostEstimateError extends Error {
  constructor(
    message: string,
    readonly status = 500,
  ) {
    super(message);
    this.name = "ModuleCostEstimateError";
  }
}

function serviceConfiguration(): { url: string; token: string } {
  const url = process.env.COST_SERVICE_URL?.trim().replace(/\/+$/, "");
  const token = process.env.COST_SERVICE_TOKEN?.trim();
  if (!url || !token) {
    throw new ModuleCostEstimateError(
      "The Infracost cost service is not configured.",
      503,
    );
  }
  return { url, token };
}

function sourceAddress(input: {
  sourceUrl: string;
  versionTag: string;
  terraformRootFolder: string | null;
}): string {
  const base = input.sourceUrl.replace(/^git::/, "").replace(/\?.*$/, "");
  const folder = input.terraformRootFolder
    ?.trim()
    .replace(/^\.?\/+/, "")
    .replace(/\/+$/, "");
  const subdirectory = folder && folder !== "." ? `//${folder}` : "";
  return `git::${base}${subdirectory}?ref=${encodeURIComponent(input.versionTag)}`;
}

function renderScenario(input: {
  source: string;
  scenario: Ec2ModuleCostScenario;
}): string {
  const { scenario } = input;
  const attributes = [
    `  source = ${JSON.stringify(input.source)}`,
    `  count = ${scenario.instanceCount}`,
    `  instance_type = ${JSON.stringify(scenario.instanceType)}`,
    "  create_spot_instance = false",
    `  monitoring = ${scenario.monitoring}`,
    `  create_eip = ${scenario.createEip}`,
    `  tenancy = ${JSON.stringify(scenario.tenancy)}`,
    `  region = ${JSON.stringify(REGION)}`,
    ...(scenario.rootVolume.enabled
      ? [
          "  root_block_device = {",
          `    type = ${JSON.stringify(scenario.rootVolume.type)}`,
          `    size = ${scenario.rootVolume.size}`,
          ...(["gp3", "io1", "io2"].includes(scenario.rootVolume.type)
            ? [`    iops = ${scenario.rootVolume.iops}`]
            : []),
          ...(scenario.rootVolume.type === "gp3"
            ? [`    throughput = ${scenario.rootVolume.throughput}`]
            : []),
          "  }",
        ]
      : []),
  ];

  return [
    "terraform {",
    "  required_providers {",
    "    aws = {",
    '      source = "hashicorp/aws"',
    "    }",
    "  }",
    "}",
    `provider "aws" {`,
    `  region = ${JSON.stringify(REGION)}`,
    "}",
    'module "scenario" {',
    ...attributes,
    "}",
    "",
  ].join("\n");
}

function renderScenarioValue(value: ModuleScenarioValue): string {
  if (typeof value === "string") {
    return JSON.stringify(value)
      .replaceAll("${", "$${")
      .replaceAll("%{", "%%{");
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(renderScenarioValue).join(", ")}]`;
  }
  return `{ ${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([key, item]) => `${JSON.stringify(key)} = ${renderScenarioValue(item)}`,
    )
    .join(", ")} }`;
}

function renderGenericScenario(input: {
  source: string;
  scenario: GenericModuleCostScenario;
}): string {
  const attributes = Object.entries(input.scenario.inputs)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) {
        throw new ModuleCostEstimateError(
          `Input ${name} cannot be rendered as a Terraform argument.`,
          422,
        );
      }
      return `  ${name} = ${renderScenarioValue(value)}`;
    });

  return [
    "terraform {",
    "  required_providers {",
    "    aws = {",
    '      source = "hashicorp/aws"',
    "    }",
    "  }",
    "}",
    'provider "aws" {',
    `  region = ${JSON.stringify(REGION)}`,
    "}",
    'module "scenario" {',
    `  source = ${renderScenarioValue(input.source)}`,
    ...attributes,
    "}",
    "",
  ].join("\n");
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finite(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function add(grouped: Map<string, number>, name: string, amount: number) {
  grouped.set(name, (grouped.get(name) ?? 0) + amount);
}

function sortedBreakdown(
  grouped: Map<string, number>,
): ModuleCostBreakdownItem[] {
  return [...grouped.entries()]
    .filter(([, monthlyCost]) => monthlyCost > 0)
    .map(([name, monthlyCost]) => ({ name, monthlyCost }))
    .sort(
      (a, b) => b.monthlyCost - a.monthlyCost || a.name.localeCompare(b.name),
    );
}

function parseEstimate(
  raw: string,
): Omit<
  ModuleInfracostEstimate,
  "region" | "estimatedAt" | "estimatorVersion" | "totalAnnualCost"
> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ModuleCostEstimateError("Infracost returned invalid JSON.", 502);
  }

  const root = record(parsed);
  if (!root)
    throw new ModuleCostEstimateError("Infracost returned no estimate.", 502);
  if (root.currency !== CURRENCY) {
    throw new ModuleCostEstimateError(
      `Infracost returned ${String(root.currency ?? "no currency")} instead of ${CURRENCY}.`,
      502,
    );
  }
  const summary = record(root.summary) ?? {};
  const totalMonthlyCost = finite(summary.total_monthly_cost);
  const reportedCostedResources = finite(summary.costed_resources) ?? 0;
  if (totalMonthlyCost === null) {
    throw new ModuleCostEstimateError(
      "Infracost did not return a monetary monthly total.",
      422,
    );
  }

  const services = new Map<string, number>();
  const components = new Map<string, number>();
  let resourceCount = 0;
  let costedResources = 0;
  let freeResources = 0;

  const visit = (value: unknown) => {
    const resource = record(value);
    if (!resource) return;
    resourceCount += 1;
    const type =
      typeof resource.type === "string" && resource.type.trim()
        ? resource.type
        : "unknown";
    const componentNames: string[] = [];
    let resourceCost = 0;

    for (const value of Array.isArray(resource.cost_components)
      ? resource.cost_components
      : []) {
      const component = record(value);
      if (!component || typeof component.name !== "string") continue;
      const monthly = finite(component.total_monthly_cost);
      if (monthly === null) continue;
      componentNames.push(component.name);
      resourceCost += monthly;
      add(components, component.name, monthly);
    }

    const service =
      type !== "unknown"
        ? serviceOfResource(type, type.split("_")[0] ?? "aws")
        : componentNames.some((name) => /storage|iops|throughput/i.test(name))
          ? "EBS"
          : componentNames.some((name) =>
                /instance|monitoring|elastic ip/i.test(name),
              )
            ? "EC2"
            : "Other";

    if (resourceCost > 0) {
      costedResources += 1;
      add(services, service, resourceCost);
    } else if (resource.is_free === true) {
      freeResources += 1;
    }

    for (const child of Array.isArray(resource.subresources)
      ? resource.subresources
      : []) {
      visit(child);
    }
  };

  const projects = Array.isArray(root.projects) ? root.projects : [];
  for (const project of projects) {
    const resources = record(project)?.resources;
    for (const resource of Array.isArray(resources) ? resources : [])
      visit(resource);
  }

  const componentTotal = [...components.values()].reduce(
    (sum, amount) => sum + amount,
    0,
  );
  const remainder = totalMonthlyCost - componentTotal;
  if (remainder < -0.01) {
    throw new ModuleCostEstimateError(
      "Infracost components exceed the reported monthly total.",
      502,
    );
  }
  if (remainder > 0.01) {
    add(services, "Unattributed", remainder);
    add(components, "Unattributed by Infracost", remainder);
  }

  const diagnostics = projects.flatMap((project) => {
    const values = record(project)?.diagnostics;
    if (!Array.isArray(values)) return [];
    return values.flatMap((value) => {
      const diagnostic = record(value);
      if (!diagnostic || typeof diagnostic.message !== "string") return [];
      return [
        {
          severity:
            typeof diagnostic.severity === "string"
              ? diagnostic.severity
              : "warning",
          message: diagnostic.message,
        },
      ];
    });
  });

  if (resourceCount === 0) {
    throw new ModuleCostEstimateError(
      "Infracost found no resources in this module scenario.",
      422,
    );
  }

  return {
    currency: CURRENCY,
    totalMonthlyCost,
    resourceCount,
    costedResources,
    freeResources,
    byService: sortedBreakdown(services),
    byComponent: sortedBreakdown(components),
    diagnostics,
    partial: reportedCostedResources > costedResources,
  };
}

export async function estimateEc2ModuleScenario(input: {
  sourceUrl: string;
  versionTag: string;
  terraformRootFolder: string | null;
  scenario: Ec2ModuleCostScenario;
  githubToken: string;
  signal: AbortSignal;
}): Promise<ModuleInfracostEstimate> {
  const service = serviceConfiguration();
  const source = sourceAddress(input);
  const content = renderScenario({
    source,
    scenario: input.scenario,
  });

  const response = await fetch(`${service.url}/scan`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${service.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      files: [
        { path: "infracost.yml", content: infracostConfig() },
        { path: "terraform.auto.tfvars.json", content: "{}\n" },
        { path: "main.tf", content },
      ],
      githubToken: input.githubToken,
      currency: CURRENCY,
    }),
    signal: AbortSignal.any([input.signal, AbortSignal.timeout(TIMEOUT_MS)]),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ModuleCostEstimateError(
      body?.error ?? `The cost service returned ${response.status}.`,
      response.status,
    );
  }
  if (
    typeof body?.stdout !== "string" ||
    typeof body?.stderr !== "string" ||
    typeof body?.code !== "number"
  ) {
    throw new ModuleCostEstimateError(
      "The cost service returned an invalid response.",
      502,
    );
  }

  if (body.code !== 0) {
    throw new ModuleCostEstimateError(
      body.stderr || "Infracost could not analyze this scenario.",
      422,
    );
  }
  const estimate = parseEstimate(body.stdout);

  return {
    ...estimate,
    region: REGION,
    totalAnnualCost: estimate.totalMonthlyCost * 12,
    estimatedAt: new Date().toISOString(),
    estimatorVersion: INFRACOST_VERSION,
    partial: estimate.partial,
  };
}

function scenarioValue(
  value: unknown,
  state: { fields: number },
  depth = 0,
): ModuleScenarioValue {
  if (depth > 6 || state.fields > 1_000) {
    throw new ModuleCostEstimateError(
      "The scenario input is too complex.",
      400,
    );
  }
  state.fields += 1;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ModuleCostEstimateError(
        "Scenario numbers must be finite.",
        400,
      );
    }
    return value;
  }
  if (typeof value === "string") {
    if (value.length > 5_000) {
      throw new ModuleCostEstimateError("A scenario string is too long.", 400);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) {
      throw new ModuleCostEstimateError("A scenario list is too long.", 400);
    }
    return value.map((item) => scenarioValue(item, state, depth + 1));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length > 100) {
      throw new ModuleCostEstimateError(
        "A scenario object has too many fields.",
        400,
      );
    }
    return Object.fromEntries(
      entries.map(([key, item]) => [
        key,
        scenarioValue(item, state, depth + 1),
      ]),
    );
  }
  throw new ModuleCostEstimateError("A scenario value is invalid.", 400);
}

export function validateGenericScenarioInputs(
  variables: ModuleVariableDto[],
  raw: Record<string, unknown>,
): Record<string, ModuleScenarioValue> {
  if (Object.keys(raw).length > 100) {
    throw new ModuleCostEstimateError(
      "Too many module inputs in the scenario.",
      400,
    );
  }
  const declared = new Map(
    variables.map((variable) => [variable.name, variable]),
  );
  const inputs: Record<string, ModuleScenarioValue> = {};
  const state = { fields: 0 };

  for (const [name, value] of Object.entries(raw)) {
    const variable = declared.get(name);
    if (!variable) {
      throw new ModuleCostEstimateError(
        `The module declares no input called ${name}.`,
        400,
      );
    }
    if (variable.sensitive) {
      throw new ModuleCostEstimateError(
        `Sensitive input ${name} cannot be used in a cost scenario.`,
        400,
      );
    }
    const control = costInputControl(variable);
    if (!control) {
      throw new ModuleCostEstimateError(
        `Input ${name} cannot be adjusted in a cost scenario.`,
        400,
      );
    }
    const parsed = scenarioValue(value, state);
    const valid =
      control.kind === "boolean"
        ? typeof parsed === "boolean"
        : control.kind === "choice"
          ? control.options.some((option) => option.value === parsed)
          : typeof parsed === "number" && parsed >= control.min;
    if (!valid) {
      throw new ModuleCostEstimateError(
        `Input ${name} is not one of the offered values.`,
        400,
      );
    }
    inputs[name] = parsed;
  }

  Object.assign(inputs, identityPlaceholders(variables));
  if (declared.has("region")) inputs.region = REGION;

  for (const variable of variables) {
    if (variable.required && variable.sensitive) {
      throw new ModuleCostEstimateError(
        `Required sensitive input ${variable.name} cannot be used in a cost scenario.`,
        422,
      );
    }
    if (variable.required && !(variable.name in inputs)) {
      throw new ModuleCostEstimateError(
        `Required input ${variable.name} has no value the calculator can choose.`,
        422,
      );
    }
  }
  return inputs;
}

function scaleEstimate(
  estimate: ReturnType<typeof parseEstimate>,
  count: number,
) {
  const scale = (items: ModuleCostBreakdownItem[]) =>
    items.map((item) => ({
      ...item,
      monthlyCost: item.monthlyCost * count,
    }));
  return {
    ...estimate,
    totalMonthlyCost: estimate.totalMonthlyCost * count,
    resourceCount: estimate.resourceCount * count,
    costedResources: estimate.costedResources * count,
    freeResources: estimate.freeResources * count,
    byService: scale(estimate.byService),
    byComponent: scale(estimate.byComponent),
  };
}

export async function estimateGenericModuleScenario(input: {
  sourceUrl: string;
  versionTag: string;
  terraformRootFolder: string | null;
  scenario: GenericModuleCostScenario;
  githubToken: string;
  signal: AbortSignal;
}): Promise<ModuleInfracostEstimate> {
  const service = serviceConfiguration();
  const source = sourceAddress(input);
  const content = renderGenericScenario({ source, scenario: input.scenario });
  const response = await fetch(`${service.url}/scan`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${service.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      files: [
        { path: "infracost.yml", content: infracostConfig() },
        { path: "terraform.auto.tfvars.json", content: "{}\n" },
        { path: "main.tf", content },
      ],
      githubToken: input.githubToken,
      currency: CURRENCY,
    }),
    signal: AbortSignal.any([input.signal, AbortSignal.timeout(TIMEOUT_MS)]),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ModuleCostEstimateError(
      body?.error ?? `The cost service returned ${response.status}.`,
      response.status,
    );
  }
  if (
    typeof body?.stdout !== "string" ||
    typeof body?.stderr !== "string" ||
    typeof body?.code !== "number"
  ) {
    throw new ModuleCostEstimateError(
      "The cost service returned an invalid response.",
      502,
    );
  }

  let estimate: ReturnType<typeof parseEstimate>;
  try {
    estimate = parseEstimate(body.stdout);
  } catch (error) {
    if (body.code !== 0) {
      throw new ModuleCostEstimateError(
        body.stderr || "Infracost could not analyze this scenario.",
        422,
      );
    }
    throw error;
  }
  const scaled = scaleEstimate(estimate, input.scenario.moduleCount);

  return {
    ...scaled,
    diagnostics:
      body.code !== 0 && body.stderr
        ? [
            ...scaled.diagnostics,
            { severity: "warning", message: body.stderr.trim() },
          ]
        : scaled.diagnostics,
    region: REGION,
    totalAnnualCost: scaled.totalMonthlyCost * 12,
    estimatedAt: new Date().toISOString(),
    estimatorVersion: INFRACOST_VERSION,
    partial: body.code !== 0 || scaled.partial,
  };
}
