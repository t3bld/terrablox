import "server-only";

import { createHash } from "node:crypto";

import type {
  ProjectCostResourceDto,
  ProjectCostUsageResourceDto,
} from "@/lib/projects/types";

export type CostUsageAssumptions = Record<string, Record<string, number>>;

type UsageDefinition = {
  key: string;
  label: string;
  unit: string;
  steps: number[];
  low: number;
  expected: number;
  high: number;
};

/**
 * Infracost usage-file keys are provider-plugin API, not discoverable from scan
 * JSON. Keep the supported set explicit and versioned rather than guessing from
 * display labels such as "Requests" or "Data processed".
 */
const USAGE_BY_RESOURCE: Record<string, UsageDefinition[]> = {
  aws_nat_gateway: [
    {
      key: "monthly_data_processed_gb",
      label: "Data processed",
      unit: "GB / month",
      steps: [0, 10, 50, 100, 500, 1_000, 5_000, 10_000],
      low: 100,
      expected: 1_000,
      high: 5_000,
    },
  ],
  aws_lambda_function: [
    {
      key: "monthly_requests",
      label: "Invocations",
      unit: "requests / month",
      steps: [0, 10_000, 100_000, 1_000_000, 10_000_000, 100_000_000],
      low: 100_000,
      expected: 1_000_000,
      high: 10_000_000,
    },
    {
      key: "request_duration_ms",
      label: "Average duration",
      unit: "ms / request",
      steps: [50, 100, 250, 500, 1_000, 3_000, 10_000],
      low: 100,
      expected: 500,
      high: 1_000,
    },
  ],
  aws_route53_record: [
    {
      key: "monthly_standard_queries",
      label: "Standard DNS queries",
      unit: "queries / month",
      steps: [
        0, 1_000_000, 10_000_000, 100_000_000, 1_000_000_000, 2_000_000_000,
        5_000_000_000,
      ],
      low: 10_000_000,
      expected: 100_000_000,
      high: 1_000_000_000,
    },
    {
      key: "monthly_latency_based_queries",
      label: "Latency-routing queries",
      unit: "queries / month",
      steps: [
        0, 1_000_000, 10_000_000, 100_000_000, 1_000_000_000, 2_000_000_000,
        5_000_000_000,
      ],
      low: 0,
      expected: 0,
      high: 100_000_000,
    },
    {
      key: "monthly_geo_queries",
      label: "Geo-routing queries",
      unit: "queries / month",
      steps: [
        0, 1_000_000, 10_000_000, 100_000_000, 1_000_000_000, 2_000_000_000,
        5_000_000_000,
      ],
      low: 0,
      expected: 0,
      high: 100_000_000,
    },
  ],
  aws_s3_bucket: [
    {
      key: "standard.storage_gb",
      label: "Standard storage",
      unit: "GB / month",
      steps: [0, 10, 100, 500, 1_000, 5_000, 10_000, 50_000],
      low: 100,
      expected: 1_000,
      high: 10_000,
    },
    {
      key: "standard.monthly_tier_1_requests",
      label: "PUT, COPY, POST and LIST",
      unit: "requests / month",
      steps: [0, 1_000, 10_000, 100_000, 1_000_000, 10_000_000, 100_000_000],
      low: 10_000,
      expected: 1_000_000,
      high: 10_000_000,
    },
    {
      key: "standard.monthly_tier_2_requests",
      label: "GET, SELECT and other requests",
      unit: "requests / month",
      steps: [
        0, 10_000, 100_000, 1_000_000, 10_000_000, 100_000_000, 1_000_000_000,
      ],
      low: 100_000,
      expected: 10_000_000,
      high: 100_000_000,
    },
  ],
};

export function readCostUsageAssumptions(value: unknown): CostUsageAssumptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: CostUsageAssumptions = {};

  for (const [address, fields] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (!fields || typeof fields !== "object" || Array.isArray(fields))
      continue;
    const valid: Record<string, number> = {};
    for (const [key, candidate] of Object.entries(
      fields as Record<string, unknown>,
    )) {
      if (
        typeof candidate === "number" &&
        Number.isFinite(candidate) &&
        candidate >= 0 &&
        candidate <= 1_000_000_000_000_000
      ) {
        valid[key] = candidate;
      }
    }
    if (Object.keys(valid).length) result[address] = valid;
  }
  return result;
}

export function usageControls(
  resources: ProjectCostResourceDto[],
  raw: unknown,
): ProjectCostUsageResourceDto[] {
  const assumptions = readCostUsageAssumptions(raw);
  const seen = new Set<string>();

  return resources.flatMap((resource) => {
    if (seen.has(resource.address)) return [];
    seen.add(resource.address);
    const definitions = USAGE_BY_RESOURCE[resource.type];
    if (!definitions) return [];

    return [
      {
        address: resource.address,
        resourceType: resource.type,
        service: resource.service,
        icon: resource.icon,
        fields: definitions.map((definition) => ({
          ...definition,
          value:
            assumptions[resource.address]?.[definition.key] ??
            definition.expected,
        })),
      },
    ];
  });
}

function stableAssumptions(value: CostUsageAssumptions) {
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((address) => [
        address,
        Object.fromEntries(
          Object.entries(value[address] ?? {}).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        ),
      ]),
  );
}

export function costUsageHash(value: CostUsageAssumptions): string {
  return createHash("sha256")
    .update(JSON.stringify(stableAssumptions(value)))
    .digest("hex")
    .slice(0, 24);
}

function nestedUsage(fields: Record<string, number>): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(fields)) {
    const parts = path.split(".");
    let target = root;
    for (const [index, part] of parts.entries()) {
      if (index === parts.length - 1) {
        target[part] = value;
      } else {
        const next = target[part];
        if (!next || typeof next !== "object" || Array.isArray(next)) {
          target[part] = {};
        }
        target = target[part] as Record<string, unknown>;
      }
    }
  }
  return root;
}

/** Extra ephemeral files consumed automatically by `infracost scan`. */
export function costUsageFiles(value: CostUsageAssumptions): Array<{
  path: string;
  content: string;
}> {
  const addresses = Object.keys(value);
  if (addresses.length === 0) return [];

  const usage = {
    version: 0.1,
    resource_usage: Object.fromEntries(
      addresses.map((address) => [address, nestedUsage(value[address] ?? {})]),
    ),
  };
  const config = {
    version: "0.3",
    usage_file: "terrablox-infracost-usage.yml",
    projects: [{ name: "terrablox", path: "." }],
  };

  // JSON is valid YAML. Generating it this way keeps resource addresses and
  // filenames escaped without introducing another serialization dependency.
  return [
    {
      path: "infracost.yml",
      content: `${JSON.stringify(config, null, 2)}\n`,
    },
    {
      path: "terrablox-infracost-usage.yml",
      content: `${JSON.stringify(usage, null, 2)}\n`,
    },
  ];
}
