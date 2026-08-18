/**
 * Reading the cost estimate the pipeline publishes.
 *
 * The estimate is priced against a real `terraform plan`, so unlike the module
 * view it knows how many instances there are and how big they are. What it
 * still cannot know is traffic: requests, data transfer and anything else
 * driven by use come back without a figure. Those components are carried
 * through as `null` rather than as zero, because a total that silently omits
 * them while looking complete is the failure mode worth avoiding here.
 */

import { modulePathOf } from "./state";

export interface CostComponent {
  name: string;
  unit: string | null;
  /** Null when the quantity depends on usage nobody has measured. */
  monthlyQuantity: string | null;
  monthlyCost: string | null;
}

export interface CostResource {
  /** Full Terraform address, e.g. `module.vpc.aws_nat_gateway.this[0]`. */
  name: string;
  monthlyCost: string | null;
  components: CostComponent[];
}

export interface CostSnapshot {
  version: number;
  generatedAt: string;
  currency: string;
  totalMonthlyCost: string | null;
  detectedResources: number | null;
  supportedResources: number | null;
  /** Resource types Infracost has no price model for. */
  unsupportedResources: number | null;
  /** Resources that are free, or whose cost is entirely usage-driven. */
  noPriceResources: number | null;
  resources: CostResource[];
}

/** What the cost tab receives, including the reasons it may be empty. */
export interface ProjectCostDto {
  snapshot: CostSnapshot | null;
  /** Where the estimate lives, so the user can inspect it in Git. */
  fileUrl: string;
  /** False when the pipeline that writes the estimate has not been generated. */
  hasWorkflow: boolean;
  /** False when the user has not connected their own Infracost key. */
  hasApiKey: boolean;
  problem: string | null;
}

export interface CostModuleGroup {
  path: string;
  label: string;
  resources: CostResource[];
  /** Null when nothing in the group carries a priced component. */
  monthlyCost: number | null;
}

function toNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Infracost writes money as strings to avoid float drift; keep them strings. */
function toMoneyOrNull(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

export function parseCostSnapshot(raw: string): CostSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;

  const resources = Array.isArray(record.resources)
    ? record.resources.flatMap((entry) => {
        const resource = toCostResource(entry);
        return resource ? [resource] : [];
      })
    : [];

  return {
    version: typeof record.version === "number" ? record.version : 1,
    generatedAt:
      typeof record.generatedAt === "string" ? record.generatedAt : "",
    currency: typeof record.currency === "string" ? record.currency : "USD",
    totalMonthlyCost: toMoneyOrNull(record.totalMonthlyCost),
    detectedResources: toNumberOrNull(record.detectedResources),
    supportedResources: toNumberOrNull(record.supportedResources),
    unsupportedResources: toNumberOrNull(record.unsupportedResources),
    noPriceResources: toNumberOrNull(record.noPriceResources),
    resources,
  };
}

function toCostResource(entry: unknown): CostResource | null {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  if (typeof record.name !== "string") return null;

  const components = Array.isArray(record.components)
    ? record.components.flatMap((item) => {
        const component = toCostComponent(item);
        return component ? [component] : [];
      })
    : [];

  return {
    name: record.name,
    monthlyCost: toMoneyOrNull(record.monthlyCost),
    components,
  };
}

function toCostComponent(entry: unknown): CostComponent | null {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  if (typeof record.name !== "string") return null;

  return {
    name: record.name,
    unit: typeof record.unit === "string" ? record.unit : null,
    monthlyQuantity: toMoneyOrNull(record.monthlyQuantity),
    monthlyCost: toMoneyOrNull(record.monthlyCost),
  };
}

/** A component priced at nothing is free; one priced at `null` is unknown. */
export function isUsageDriven(component: CostComponent): boolean {
  return component.monthlyCost === null || component.monthlyQuantity === null;
}

export function countUsageDriven(resources: CostResource[]): number {
  return resources.reduce(
    (sum, resource) => sum + resource.components.filter(isUsageDriven).length,
    0,
  );
}

export function monthlyCostOf(resource: CostResource): number | null {
  if (resource.monthlyCost === null) return null;
  const value = Number(resource.monthlyCost);
  return Number.isFinite(value) ? value : null;
}

export function groupByModule(resources: CostResource[]): CostModuleGroup[] {
  const groups = new Map<string, CostResource[]>();

  for (const resource of resources) {
    const path = modulePathOf(resource.name);
    const existing = groups.get(path);
    if (existing) existing.push(resource);
    else groups.set(path, [resource]);
  }

  return [...groups.entries()]
    .map(([path, entries]) => {
      const priced = entries
        .map(monthlyCostOf)
        .filter((value): value is number => value !== null);

      return {
        path,
        label: path === "" ? "Root module" : path.replace(/module\./g, ""),
        resources: [...entries].sort((a, b) => {
          const costA = monthlyCostOf(a) ?? -1;
          const costB = monthlyCostOf(b) ?? -1;
          return costB - costA || a.name.localeCompare(b.name);
        }),
        monthlyCost:
          priced.length > 0 ? priced.reduce((sum, v) => sum + v, 0) : null,
      };
    })
    .sort((a, b) => (b.monthlyCost ?? -1) - (a.monthlyCost ?? -1));
}

export function formatMoney(
  value: number | string | null,
  currency: string,
): string {
  const amount = typeof value === "string" ? Number(value) : value;
  if (amount === null || amount === undefined || !Number.isFinite(amount)) {
    return "—";
  }

  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      // One precision everywhere: a total rounded to whole units beside line
      // items showing cents reads as two different kinds of number.
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    // An unknown currency code must not take the tab down with it.
    return `${amount.toFixed(2)} ${currency}`;
  }
}
