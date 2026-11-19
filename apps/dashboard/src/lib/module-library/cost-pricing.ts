import "server-only";

import { resolveCostDriver } from "@terrablox/terraform/aws-cost-drivers";
import { buildUnpricedDriverModel } from "@/lib/module-library/cost-driver-controls";
import type {
  ModuleCostControl,
  ModuleCostModel,
  ModuleCostPricingResponse,
} from "@/lib/module-library/cost-pricing-types";
import type {
  ModuleResourceDto,
  ModuleVariableDto,
} from "@/lib/module-library/types";

const HOURS_PER_MONTH = 730;
const AWS_PRICE_ROOT =
  "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws";
const ECB_DAILY =
  "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
const MAX_OFFER_BYTES = 5_000_000;

interface OfferProduct {
  productFamily?: string;
  attributes?: Record<string, string>;
}

interface PriceDimension {
  unit?: string;
  beginRange?: string;
  endRange?: string;
  pricePerUnit?: { USD?: string };
}

interface OfferTerm {
  priceDimensions?: Record<string, PriceDimension>;
}

interface AwsOffer {
  publicationDate?: string;
  products?: Record<string, OfferProduct>;
  terms?: { OnDemand?: Record<string, Record<string, OfferTerm>> };
}

interface FxRate {
  date: string;
  usdPerEur: number;
}

interface PricedDimension {
  product: OfferProduct;
  dimension: PriceDimension;
  usd: number;
}

function quantity(
  id: string,
  label: string,
  unit: string,
  defaultValue: number,
  max = 50,
  step = 1,
): ModuleCostControl {
  return {
    id,
    label,
    unit,
    min: 0,
    max: Math.max(max, defaultValue),
    step,
    defaultValue,
    growsWithWorkload: false,
  };
}

function usage(
  id: string,
  label: string,
  unit: string,
  defaultValue: number,
  max: number,
  step: number,
): ModuleCostControl {
  return {
    id,
    label,
    unit,
    min: 0,
    max,
    step,
    defaultValue,
    growsWithWorkload: true,
  };
}

async function loadOffer(
  service: string,
  region: string | null,
): Promise<AwsOffer> {
  const scope = region ? `${region}/` : "";
  const url = `${AWS_PRICE_ROOT}/${service}/current/${scope}index.json`;
  const response = await fetch(url, { next: { revalidate: 21_600 } });
  if (!response.ok) {
    throw new Error(`AWS price list ${service} returned ${response.status}`);
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_OFFER_BYTES) {
    throw new Error(`AWS price list ${service} is too large for live lookup`);
  }

  return JSON.parse(new TextDecoder().decode(buffer)) as AwsOffer;
}

async function loadFx(): Promise<FxRate> {
  const response = await fetch(ECB_DAILY, { next: { revalidate: 86_400 } });
  if (!response.ok) {
    throw new Error(`ECB exchange-rate feed returned ${response.status}`);
  }

  const xml = await response.text();
  const date = xml.match(/time=['"](\d{4}-\d{2}-\d{2})['"]/)?.[1];
  const usd = xml.match(/currency=['"]USD['"]\s+rate=['"]([0-9.]+)['"]/)?.[1];
  const usdPerEur = Number(usd);
  if (!date || !Number.isFinite(usdPerEur) || usdPerEur <= 0) {
    throw new Error("ECB exchange-rate feed has no valid USD rate");
  }

  return { date, usdPerEur };
}

function dimensions(
  offer: AwsOffer,
  productMatches: (product: OfferProduct) => boolean,
  dimensionMatches: (dimension: PriceDimension) => boolean = () => true,
): PricedDimension[] {
  const out: PricedDimension[] = [];

  for (const [sku, product] of Object.entries(offer.products ?? {})) {
    if (!productMatches(product)) continue;

    for (const term of Object.values(offer.terms?.OnDemand?.[sku] ?? {})) {
      for (const dimension of Object.values(term.priceDimensions ?? {})) {
        if (!dimensionMatches(dimension)) continue;
        const usd = Number(dimension.pricePerUnit?.USD);
        if (Number.isFinite(usd)) out.push({ product, dimension, usd });
      }
    }
  }

  return out;
}

function oneRate(
  offer: AwsOffer,
  productMatches: (product: OfferProduct) => boolean,
  dimensionMatches?: (dimension: PriceDimension) => boolean,
): number {
  const found = dimensions(offer, productMatches, dimensionMatches);
  if (found.length !== 1) {
    throw new Error(
      found.length === 0
        ? "Required AWS price dimension was not found"
        : "AWS price lookup returned more than one matching dimension",
    );
  }
  return found[0]?.usd ?? 0;
}

function eur(usd: number, fx: FxRate): number {
  return usd / fx.usdPerEur;
}

function countTypes(
  resources: Array<Pick<ModuleResourceDto, "kind" | "resourceType">>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const resource of resources) {
    if (resource.kind === "data") continue;
    counts.set(
      resource.resourceType,
      (counts.get(resource.resourceType) ?? 0) + 1,
    );
  }
  return counts;
}

function total(counts: Map<string, number>, types: string[]): number {
  return types.reduce((sum, type) => sum + (counts.get(type) ?? 0), 0);
}

/**
 * Builds current quantitative models for the resource types whose AWS SKU mapping is
 * unambiguous from imported module metadata. Everything else remains in the qualitative
 * cost-driver view rather than receiving a guessed price.
 */
export async function priceModuleResources(
  resources: Array<Pick<ModuleResourceDto, "kind" | "resourceType">>,
  variables: ModuleVariableDto[],
  region: string,
): Promise<ModuleCostPricingResponse> {
  const counts = countTypes(resources);
  const present = new Set(counts.keys());
  const models: ModuleCostModel[] = [];
  const priced = new Set<string>();
  const warnings: string[] = [];
  const publicationDates = new Set<string>();
  const loadBalancerType = variables.find(
    (variable) => variable.name === "load_balancer_type",
  )?.default;
  const awsLbIsApplication =
    present.has("aws_lb") && loadBalancerType === "application";
  const potentiallyPriced =
    [
      "aws_alb",
      "aws_elb",
      "aws_eks_cluster",
      "aws_kms_key",
      "aws_kms_external_key",
      "aws_secretsmanager_secret",
      "aws_route53_zone",
    ].some((type) => present.has(type)) || awsLbIsApplication;
  const unpriced = () =>
    [...present]
      .filter((type) => resolveCostDriver(type)?.costClass !== "free")
      .filter((type) => !priced.has(type))
      .sort();
  const driverModels = () =>
    unpriced().map((resourceType) =>
      buildUnpricedDriverModel({
        resourceType,
        count: counts.get(resourceType) ?? 0,
        entry: resolveCostDriver(resourceType),
        variables,
      }),
    );

  if (!potentiallyPriced) {
    return {
      region,
      currency: "EUR",
      hoursPerMonth: HOURS_PER_MONTH,
      pricedAt: new Date().toISOString(),
      models,
      driverModels: driverModels(),
      unpricedResourceTypes: unpriced(),
      warnings,
      source: {
        aws: "AWS Price List Bulk API",
        awsPublicationDates: [],
        fx: "European Central Bank",
        fxDate: null,
        usdPerEur: null,
      },
    };
  }

  let fx: FxRate;
  try {
    fx = await loadFx();
  } catch (error) {
    warnings.push(
      error instanceof Error
        ? error.message
        : "Could not load ECB exchange rate",
    );
    return {
      region,
      currency: "EUR",
      hoursPerMonth: HOURS_PER_MONTH,
      pricedAt: new Date().toISOString(),
      models,
      driverModels: driverModels(),
      unpricedResourceTypes: unpriced(),
      warnings,
      source: {
        aws: "AWS Price List Bulk API",
        awsPublicationDates: [],
        fx: "European Central Bank",
        fxDate: null,
        usdPerEur: null,
      },
    };
  }

  const offer = async (service: string, scope: string | null) => {
    try {
      const value = await loadOffer(service, scope);
      if (value.publicationDate) publicationDates.add(value.publicationDate);
      return value;
    } catch (error) {
      warnings.push(
        error instanceof Error
          ? error.message
          : `Could not load ${service} prices`,
      );
      return null;
    }
  };

  const needsElb =
    awsLbIsApplication ||
    ["aws_alb", "aws_elb"].some((type) => present.has(type));
  const [elb, eks, kms, secrets, route53] = await Promise.all([
    needsElb ? offer("AWSELB", region) : null,
    present.has("aws_eks_cluster") ? offer("AmazonEKS", region) : null,
    present.has("aws_kms_key") || present.has("aws_kms_external_key")
      ? offer("awskms", region)
      : null,
    present.has("aws_secretsmanager_secret")
      ? offer("AWSSecretsManager", region)
      : null,
    present.has("aws_route53_zone") ? offer("AmazonRoute53", null) : null,
  ]);

  try {
    const types = ["aws_alb", ...(awsLbIsApplication ? ["aws_lb"] : [])];
    const amount = total(counts, types);
    if (amount > 0 && elb) {
      const base = oneRate(
        elb,
        (product) => {
          const a = product.attributes ?? {};
          return (
            a.operation === "LoadBalancing:Application" &&
            a.locationType === "AWS Region" &&
            a.groupDescription ===
              "LoadBalancer hourly usage by Application Load Balancer"
          );
        },
        (dimension) => dimension.unit === "Hrs",
      );
      const lcu = oneRate(
        elb,
        (product) => {
          const a = product.attributes ?? {};
          return (
            a.operation === "LoadBalancing:Application" &&
            a.locationType === "AWS Region" &&
            a.groupDescription ===
              "Used Application Load Balancer capacity units-hr"
          );
        },
        (dimension) => dimension.unit === "LCU-Hrs",
      );
      models.push({
        id: "application-load-balancer",
        kind: "application-load-balancer",
        service: "Application Load Balancer",
        resourceTypes: types.filter((type) => present.has(type)),
        controls: [
          quantity(
            "loadBalancers",
            "Load balancers",
            "load balancers",
            amount,
            20,
          ),
          usage(
            "averageLcus",
            "Expected average capacity",
            "LCUs",
            0,
            100,
            0.5,
          ),
        ],
        rates: { baseHourly: eur(base, fx), lcuHourly: eur(lcu, fx) },
        assumptions: [
          ...(awsLbIsApplication
            ? [
                'aws_lb is priced as an Application Load Balancer because this module defaults load_balancer_type to "application".',
              ]
            : []),
          `${HOURS_PER_MONTH} running hours per month.`,
          "Capacity starts at zero until an expected average LCU value is entered.",
        ],
      });
      for (const type of types) {
        if (present.has(type)) priced.add(type);
      }
    }
  } catch (error) {
    warnings.push(
      `Application Load Balancer: ${error instanceof Error ? error.message : "price unavailable"}`,
    );
  }

  try {
    const amount = counts.get("aws_elb") ?? 0;
    if (amount > 0 && elb) {
      const base = oneRate(
        elb,
        (product) => {
          const a = product.attributes ?? {};
          return (
            a.operation === "LoadBalancing" &&
            a.usagetype?.endsWith("LoadBalancerUsage") === true
          );
        },
        (dimension) => dimension.unit === "Hrs",
      );
      const data = oneRate(
        elb,
        (product) => {
          const a = product.attributes ?? {};
          return (
            a.operation === "LoadBalancing" &&
            a.usagetype?.includes("DataProcessing-Bytes") === true
          );
        },
        (dimension) => dimension.unit === "GB",
      );
      models.push({
        id: "classic-load-balancer",
        kind: "classic-load-balancer",
        service: "Classic Load Balancer",
        resourceTypes: ["aws_elb"],
        controls: [
          quantity(
            "loadBalancers",
            "Load balancers",
            "load balancers",
            amount,
            20,
          ),
          usage(
            "dataGb",
            "Total data processed",
            "GB / month",
            100,
            10_000,
            10,
          ),
        ],
        rates: { baseHourly: eur(base, fx), dataGb: eur(data, fx) },
        assumptions: [`${HOURS_PER_MONTH} running hours per month.`],
      });
      priced.add("aws_elb");
    }
  } catch (error) {
    warnings.push(
      `Classic Load Balancer: ${error instanceof Error ? error.message : "price unavailable"}`,
    );
  }

  try {
    const amount = counts.get("aws_eks_cluster") ?? 0;
    if (amount > 0 && eks) {
      const hourly = oneRate(
        eks,
        (product) =>
          product.attributes?.usagetype?.endsWith(
            "AmazonEKS-Hours:perCluster",
          ) === true,
        (dimension) => dimension.unit === "Hours",
      );
      models.push({
        id: "eks-cluster",
        kind: "eks-cluster",
        service: "Amazon EKS control plane",
        resourceTypes: ["aws_eks_cluster"],
        controls: [quantity("clusters", "Clusters", "clusters", amount, 10)],
        rates: { hourly: eur(hourly, fx) },
        assumptions: [
          "Standard support tier; worker nodes and Fargate workloads are not included.",
          `${HOURS_PER_MONTH} running hours per month.`,
        ],
      });
      priced.add("aws_eks_cluster");
    }
  } catch (error) {
    warnings.push(
      `Amazon EKS: ${error instanceof Error ? error.message : "price unavailable"}`,
    );
  }

  try {
    const types = ["aws_kms_key", "aws_kms_external_key"];
    const amount = total(counts, types);
    if (amount > 0 && kms) {
      const keyMonth = oneRate(
        kms,
        (product) =>
          product.attributes?.usagetype?.endsWith("KMS-Keys") === true,
        (dimension) => dimension.unit === "Keys",
      );
      const request = oneRate(
        kms,
        (product) => product.attributes?.group === "awskms-APIRequest-All",
        (dimension) => dimension.unit === "Requests",
      );
      models.push({
        id: "kms-key",
        kind: "kms-key",
        service: "AWS Key Management Service",
        resourceTypes: types.filter((type) => present.has(type)),
        controls: [
          quantity("keys", "Billable key versions", "key versions", amount, 50),
          usage(
            "requests",
            "Module KMS requests",
            "requests / month",
            20_000,
            2_000_000,
            10_000,
          ),
          quantity(
            "existingRequests",
            "Other account KMS requests",
            "requests / month",
            0,
            2_000_000,
            10_000,
          ),
        ],
        rates: { keyMonth: eur(keyMonth, fx), request: eur(request, fx) },
        assumptions: [
          "The 20,000-request KMS allowance is account-wide; enter other account usage so only the remaining allowance is applied here.",
          "One billable key-material version is assumed per Terraform key resource.",
          "Asymmetric and data-key-pair request premiums are not included.",
        ],
      });
      for (const type of types) {
        if (present.has(type)) priced.add(type);
      }
    }
  } catch (error) {
    warnings.push(
      `AWS KMS: ${error instanceof Error ? error.message : "price unavailable"}`,
    );
  }

  try {
    const amount = counts.get("aws_secretsmanager_secret") ?? 0;
    if (amount > 0 && secrets) {
      const secretMonth = oneRate(
        secrets,
        (product) => product.attributes?.group === "AWSSecretsManager-Secret",
        (dimension) => dimension.unit === "Secrets",
      );
      const request = oneRate(
        secrets,
        (product) =>
          product.attributes?.group === "AWSSecretsManager-APIRequest",
        (dimension) => dimension.unit === "API Requests",
      );
      models.push({
        id: "secrets-manager",
        kind: "secrets-manager",
        service: "AWS Secrets Manager",
        resourceTypes: ["aws_secretsmanager_secret"],
        controls: [
          quantity("secrets", "Secrets", "secrets", amount, 100),
          usage(
            "requests",
            "API requests",
            "requests / month",
            10_000,
            2_000_000,
            10_000,
          ),
        ],
        rates: { secretMonth: eur(secretMonth, fx), request: eur(request, fx) },
        assumptions: [
          "Rotation Lambda and its execution costs are not included.",
        ],
      });
      priced.add("aws_secretsmanager_secret");
    }
  } catch (error) {
    warnings.push(
      `AWS Secrets Manager: ${error instanceof Error ? error.message : "price unavailable"}`,
    );
  }

  try {
    const amount = counts.get("aws_route53_zone") ?? 0;
    if (amount > 0 && route53) {
      const tiers = dimensions(
        route53,
        (product) => product.attributes?.usagetype === "HostedZone",
        (dimension) => dimension.unit === "HostedZone",
      );
      const first = tiers.find((entry) => entry.dimension.beginRange === "0");
      const additional = tiers.find(
        (entry) => entry.dimension.beginRange === "25",
      );
      if (!first || !additional)
        throw new Error("Hosted-zone price tiers were not found");

      models.push({
        id: "route53-zone",
        kind: "route53-zone",
        service: "Amazon Route 53",
        resourceTypes: ["aws_route53_zone"],
        controls: [
          quantity("zones", "Module hosted zones", "zones", amount, 100),
          quantity(
            "existingZones",
            "Other hosted zones in the account",
            "zones",
            0,
            100,
          ),
        ],
        rates: {
          first25Month: eur(first.usd, fx),
          additionalMonth: eur(additional.usd, fx),
        },
        assumptions: [
          "The 25-zone price tier is account-wide; enter existing zones to calculate this module's incremental charge.",
          "Hosted-zone charge only; authoritative DNS queries, health checks and Resolver endpoints are not included.",
        ],
      });
      priced.add("aws_route53_zone");
    }
  } catch (error) {
    warnings.push(
      `Amazon Route 53: ${error instanceof Error ? error.message : "price unavailable"}`,
    );
  }

  const unpricedResourceTypes = unpriced();

  return {
    region,
    currency: "EUR",
    hoursPerMonth: HOURS_PER_MONTH,
    pricedAt: new Date().toISOString(),
    models,
    driverModels: driverModels(),
    unpricedResourceTypes,
    warnings,
    source: {
      aws: "AWS Price List Bulk API",
      awsPublicationDates: [...publicationDates].sort(),
      fx: "European Central Bank",
      fxDate: fx.date,
      usdPerEur: fx.usdPerEur,
    },
  };
}
