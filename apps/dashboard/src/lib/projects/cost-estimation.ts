import "server-only";

import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import type { Prisma, Project } from "@terrablox/database";
import { listRepoTree, readRepoFile } from "@terrablox/git/files";
import { resolveCostDriver } from "@terrablox/terraform/aws-cost-drivers";
import {
  iconOfService,
  serviceOfResource,
} from "@terrablox/terraform/aws-services";

import { database } from "@/lib/database";
import {
  type CostUsageAssumptions,
  costUsageFiles,
  costUsageHash,
  readCostUsageAssumptions,
  usageControls,
} from "@/lib/projects/cost-usage";
import { loadProjectGraph, normalizeFolder } from "@/lib/projects/service";
import { modulePathOf } from "@/lib/projects/state";
import type {
  ProjectCostResourceDto,
  ProjectCostSnapshotDto,
  ProjectCostsDto,
} from "@/lib/projects/types";

export const INFRACOST_VERSION = "2.18.3";
const PROCESS_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_OUTPUT_BYTES = 25 * 1024 * 1024;
const MAX_COST_SOURCE_FILES = 300;
const pendingEstimates = new Map<string, Promise<ProjectCostSnapshotDto>>();

export class CostEstimationError extends Error {
  constructor(
    message: string,
    readonly status = 500,
  ) {
    super(message);
    this.name = "CostEstimationError";
  }
}

function configuredCurrency(): string {
  const value = process.env.INFRACOST_CLI_CURRENCY?.trim().toUpperCase();
  return value && /^[A-Z]{3}$/.test(value) ? value : "USD";
}

function hostedToken(): string | null {
  return (
    process.env.INFRACOST_CLI_AUTHENTICATION_TOKEN?.trim() ||
    process.env.INFRACOST_API_KEY?.trim() ||
    null
  );
}

function selfHostedPricing(): { endpoint: string; key: string } | null {
  const endpoint = process.env.INFRACOST_CLI_PRICING_ENDPOINT?.trim();
  const key = process.env.INFRACOST_CLI_PRICING_API_KEY?.trim();
  return endpoint && key ? { endpoint, key } : null;
}

export function infracostConfiguration(): {
  configured: boolean;
  problem: string | null;
} {
  const selfHosted = selfHostedPricing();
  if (selfHosted || hostedToken()) return { configured: true, problem: null };

  return {
    configured: false,
    problem:
      "Add INFRACOST_CLI_AUTHENTICATION_TOKEN to the Terrablox server to calculate monetary estimates.",
  };
}

async function executable(): Promise<string | null> {
  const configured = process.env.INFRACOST_BINARY?.trim() || "infracost";
  const candidates = configured.includes("/")
    ? [resolve(configured)]
    : (process.env.PATH ?? "")
        .split(":")
        .filter(Boolean)
        .map((entry) => join(entry, configured));

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  return null;
}

export async function infracostBinaryAvailable(): Promise<boolean> {
  return (await executable()) !== null;
}

function costServiceConfiguration(): { url: string; token: string } | null {
  const url = process.env.COST_SERVICE_URL?.trim().replace(/\/+$/, "");
  const token = process.env.COST_SERVICE_TOKEN?.trim();
  return url && token ? { url, token } : null;
}

type CostEngine =
  | { kind: "service"; url: string; token: string; currency: string }
  | { kind: "local"; binary: string; currency: string }
  | { kind: "unavailable"; problem: string; currency: string };

async function localEngine(): Promise<CostEngine> {
  const config = infracostConfiguration();
  const binary = await executable();
  if (config.configured && binary) {
    return { kind: "local", binary, currency: configuredCurrency() };
  }

  const problems = [
    config.problem,
    binary
      ? null
      : "The Infracost CLI is not installed on this Terrablox server.",
  ].filter((problem): problem is string => Boolean(problem));
  return {
    kind: "unavailable",
    problem: problems.join(" "),
    currency: configuredCurrency(),
  };
}

async function resolveCostEngine(): Promise<CostEngine> {
  const service = costServiceConfiguration();
  if (!service) return localEngine();

  try {
    const response = await fetch(`${service.url}/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(3_000),
    });
    const body = await response.json().catch(() => null);
    if (response.ok && body?.ok === true && body?.configured === true) {
      return {
        kind: "service",
        ...service,
        currency:
          typeof body.currency === "string"
            ? body.currency
            : configuredCurrency(),
      };
    }

    const local = await localEngine();
    if (local.kind !== "unavailable") return local;
    return {
      kind: "unavailable",
      problem:
        body?.configured === false
          ? "The cost service is running, but its Infracost credentials are not configured."
          : `The cost service returned ${response.status}.`,
      currency:
        typeof body?.currency === "string"
          ? body.currency
          : configuredCurrency(),
    };
  } catch {
    const local = await localEngine();
    if (local.kind !== "unavailable") return local;
    return {
      kind: "unavailable",
      problem: `The cost service at ${service.url} could not be reached. Start it with pnpm cost:up.`,
      currency: configuredCurrency(),
    };
  }
}

async function runRemoteInfracost(
  engine: Extract<CostEngine, { kind: "service" }>,
  files: Array<{ path: string; content: string }>,
  githubToken: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const response = await fetch(`${engine.url}/scan`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${engine.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      files,
      githubToken,
      currency: engine.currency,
    }),
    signal: AbortSignal.timeout(PROCESS_TIMEOUT_MS + 10_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new CostEstimationError(
      body?.error ?? `The cost service returned ${response.status}.`,
      response.status,
    );
  }
  if (
    typeof body?.stdout !== "string" ||
    typeof body?.stderr !== "string" ||
    typeof body?.code !== "number"
  ) {
    throw new CostEstimationError(
      "The cost service returned an invalid response.",
      502,
    );
  }
  return { stdout: body.stdout, stderr: body.stderr, code: body.code };
}

function numberText(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? String(value) : null;
}

function sumMoney(values: Array<string | null>): string | null {
  const numbers = values
    .filter((value): value is string => value !== null)
    .map(Number)
    .filter(Number.isFinite);
  return numbers.length
    ? String(numbers.reduce((sum, value) => sum + value, 0))
    : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseComponents(value: unknown): ProjectCostResourceDto["components"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const component = record(item);
    if (!component || typeof component.name !== "string") return [];
    return [
      {
        name: component.name,
        unit: typeof component.unit === "string" ? component.unit : null,
        price: numberText(component.price),
        quantity: numberText(component.quantity),
        monthlyCost: numberText(component.total_monthly_cost),
        usageBased: component.usage_based === true,
        usageUnknown: component.usage_unknown === true,
      },
    ];
  });
}

function parseResources(value: unknown): ProjectCostResourceDto[] {
  if (!Array.isArray(value)) return [];
  const result: ProjectCostResourceDto[] = [];

  const visit = (item: unknown) => {
    const resource = record(item);
    if (!resource || typeof resource.name !== "string") return;
    const type = typeof resource.type === "string" ? resource.type : "unknown";
    const components = parseComponents(resource.cost_components);
    const service = serviceOfResource(type, type.split("_")[0] ?? "");
    const knownFree = resolveCostDriver(type)?.costClass === "free";

    result.push({
      address: resource.name,
      type,
      service,
      icon: iconOfService(service) ?? null,
      modulePath: modulePathOf(resource.name),
      // Infracost emits some free networking primitives as unsupported and
      // gives priced subresources (for example root_block_device) no type at
      // all. A returned price component is proof that it was priced; our curated
      // free table supplies the other half without inventing an amount.
      supported:
        resource.is_supported === true || knownFree || components.length > 0,
      free: resource.is_free === true || knownFree,
      monthlyCost: sumMoney(
        components.map((component) => component.monthlyCost),
      ),
      components,
    });

    if (Array.isArray(resource.subresources)) {
      for (const child of resource.subresources) visit(child);
    }
  };

  for (const item of value) visit(item);
  return result;
}

function parseInfracostOutput(raw: string): {
  currency: string;
  totalMonthlyCost: string | null;
  resourceCount: number;
  costedResources: number;
  freeResources: number;
  resources: ProjectCostResourceDto[];
  diagnostics: ProjectCostSnapshotDto["diagnostics"];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CostEstimationError("Infracost returned invalid JSON.", 502);
  }

  const root = record(parsed);
  if (!root)
    throw new CostEstimationError("Infracost returned no estimate.", 502);
  const projects = Array.isArray(root.projects) ? root.projects : [];
  const resources = projects.flatMap((project) =>
    parseResources(record(project)?.resources),
  );
  const diagnostics = projects.flatMap((project) => {
    const values = record(project)?.diagnostics;
    if (!Array.isArray(values)) return [];
    return values.flatMap((item) => {
      const diagnostic = record(item);
      if (!diagnostic || typeof diagnostic.message !== "string") return [];
      return [
        {
          severity:
            typeof diagnostic.severity === "string"
              ? diagnostic.severity
              : "warning",
          message: diagnostic.message,
          location:
            typeof diagnostic.location === "string"
              ? diagnostic.location
              : null,
        },
      ];
    });
  });
  const summary = record(root.summary) ?? {};

  return {
    currency:
      typeof root.currency === "string" ? root.currency : configuredCurrency(),
    totalMonthlyCost: numberText(summary.total_monthly_cost),
    resourceCount: resources.length,
    costedResources: resources.filter(
      (resource) => !resource.free && resource.monthlyCost !== null,
    ).length,
    freeResources: resources.filter((resource) => resource.free).length,
    resources,
    diagnostics,
  };
}

async function collectCostSources(token: string, project: Project) {
  const tree = await listRepoTree(token, {
    repoFullName: project.repoFullName,
    ref: project.repoBranch,
  });
  const folder = normalizeFolder(project.terraformRootFolder);
  const prefix = folder === "." ? "" : `${folder}/`;
  const paths = tree.entries
    .filter((entry) => entry.type === "blob")
    .map((entry) => entry.path)
    .filter((path) => path.startsWith(prefix))
    .filter((path) =>
      /(?:\.tf|\.tfvars|\.tfvars\.json|\.terraform\.lock\.hcl)$/.test(path),
    )
    .slice(0, MAX_COST_SOURCE_FILES);

  if (paths.length === MAX_COST_SOURCE_FILES) {
    throw new CostEstimationError(
      `The Terraform source contains at least ${MAX_COST_SOURCE_FILES} files. Narrow the project's Terraform root before estimating costs.`,
      413,
    );
  }

  const files = await Promise.all(
    paths.map(async (path) => {
      const file = await readRepoFile(token, {
        repoFullName: project.repoFullName,
        path,
        ref: project.repoBranch,
      });
      return file
        ? { path: path.slice(prefix.length), content: file.content }
        : null;
    }),
  );

  return {
    sha: tree.sha,
    files: files.filter(
      (file): file is { path: string; content: string } => file !== null,
    ),
  };
}

function redactProcessText(value: string, githubToken: string): string {
  return [githubToken, encodeURIComponent(githubToken)].reduce(
    (text, secret) => (secret ? text.replaceAll(secret, "[redacted]") : text),
    value,
  );
}

async function runLocalInfracost(
  binary: string,
  root: string,
  githubToken: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const selfHosted = selfHostedPricing();
  const token = hostedToken();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NO_COLOR: "1",
    INFRACOST_CLI_CURRENCY: configuredCurrency(),
    INFRACOST_CLI_LOG_LEVEL: "error",
    INFRACOST_CLI_PLUGIN_AUTO_UPDATE: "false",
    // Gives Infracost's module downloader access to the same private GitHub
    // repositories the signed-in user selected, without putting the token in an
    // argument or writing a credential file.
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.https://x-access-token:${encodeURIComponent(githubToken)}@github.com/.insteadOf`,
    GIT_CONFIG_VALUE_0: "https://github.com/",
  };
  // The classic API-key name is accepted by Terrablox as an input alias only.
  // Do not also hand it to v2, where legacy pricing variables have different
  // self-hosted semantics and can conflict with the explicit v2 mode below.
  delete env.INFRACOST_API_KEY;
  delete env.INFRACOST_PRICING_API_ENDPOINT;

  if (selfHosted) {
    env.INFRACOST_CLI_PRICING_ENDPOINT = selfHosted.endpoint;
    env.INFRACOST_CLI_PRICING_API_KEY = selfHosted.key;
    delete env.INFRACOST_CLI_AUTHENTICATION_TOKEN;
  } else if (token) {
    env.INFRACOST_CLI_AUTHENTICATION_TOKEN = token;
  }

  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(binary, ["scan", "--json", root], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, PROCESS_TIMEOUT_MS);

    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        return;
      }
      target.push(chunk);
    };

    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        rejectRun(new CostEstimationError("The cost estimate timed out.", 504));
        return;
      }
      if (bytes > MAX_OUTPUT_BYTES) {
        rejectRun(
          new CostEstimationError(
            "The cost estimate output was too large.",
            502,
          ),
        );
        return;
      }
      resolveRun({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code: code ?? 1,
      });
    });
  });
}

async function runLocalSourceFiles(
  binary: string,
  files: Array<{ path: string; content: string }>,
  githubToken: string,
) {
  const directory = await mkdtemp(join(tmpdir(), "terrablox-infracost-"));
  try {
    for (const file of files) {
      const path = resolve(directory, file.path);
      if (relative(directory, path).startsWith("..")) continue;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.content, "utf8");
    }
    return await runLocalInfracost(binary, directory, githubToken);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

function snapshotDto(row: {
  id: string;
  sourceSha: string;
  region: string;
  currency: string;
  totalMonthlyCost: string | null;
  resourceCount: number;
  costedResources: number;
  freeResources: number;
  estimatorVersion: string;
  breakdown: unknown;
  diagnostics: unknown;
  createdAt: Date;
}): ProjectCostSnapshotDto {
  const resources = parseResourcesFromStored(row.breakdown);
  return {
    id: row.id,
    sourceSha: row.sourceSha,
    region: row.region,
    currency: row.currency,
    totalMonthlyCost: row.totalMonthlyCost,
    resourceCount: resources.length || row.resourceCount,
    costedResources: resources.filter(
      (resource) => !resource.free && resource.monthlyCost !== null,
    ).length,
    freeResources: resources.filter((resource) => resource.free).length,
    estimatorVersion: row.estimatorVersion,
    resources,
    diagnostics: parseDiagnosticsFromStored(row.diagnostics),
    createdAt: row.createdAt.toISOString(),
  };
}

function parseResourcesFromStored(value: unknown): ProjectCostResourceDto[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const row = record(item);
    if (
      !row ||
      typeof row.address !== "string" ||
      typeof row.type !== "string"
    ) {
      return [];
    }

    const resource = item as ProjectCostResourceDto;
    const components = Array.isArray(resource.components)
      ? resource.components
      : [];
    const knownFree = resolveCostDriver(resource.type)?.costClass === "free";
    return [
      {
        ...resource,
        components,
        supported: resource.supported || knownFree || components.length > 0,
        free: resource.free || knownFree,
      },
    ];
  });
}

function parseDiagnosticsFromStored(
  value: unknown,
): ProjectCostSnapshotDto["diagnostics"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const row = record(item);
    if (!row || typeof row.message !== "string") return [];
    return [
      {
        severity: typeof row.severity === "string" ? row.severity : "warning",
        message: row.message,
        location: typeof row.location === "string" ? row.location : null,
      },
    ];
  });
}

export async function readProjectCosts(
  token: string,
  project: Project,
): Promise<ProjectCostsDto> {
  const [engine, graph, snapshots] = await Promise.all([
    resolveCostEngine(),
    loadProjectGraph(token, project),
    database.projectCostSnapshot.findMany({
      where: { projectId: project.id },
      orderBy: { createdAt: "desc" },
      take: 30,
    }),
  ]);

  return {
    configured: engine.kind !== "unavailable",
    // Kept under the existing API field name for compatibility; a healthy
    // sidecar satisfies the same capability as a local binary.
    binaryAvailable: engine.kind !== "unavailable",
    configurationProblem: engine.kind === "unavailable" ? engine.problem : null,
    estimateCurrency: engine.currency,
    currentSourceSha: graph.sha,
    latest: snapshots[0] ? snapshotDto(snapshots[0]) : null,
    history: snapshots.map((snapshot) => ({
      id: snapshot.id,
      sourceSha: snapshot.sourceSha,
      totalMonthlyCost: snapshot.totalMonthlyCost,
      currency: snapshot.currency,
      createdAt: snapshot.createdAt.toISOString(),
    })),
    usage: usageControls(
      snapshots[0] ? snapshotDto(snapshots[0]).resources : [],
      project.costUsage,
    ),
    hasSavedUsageAssumptions:
      Object.keys(readCostUsageAssumptions(project.costUsage)).length > 0,
  };
}

export async function estimateProjectCosts(input: {
  token: string;
  project: Project;
  force: boolean;
  usageAssumptions?: CostUsageAssumptions;
}): Promise<ProjectCostSnapshotDto> {
  const engine = await resolveCostEngine();
  if (engine.kind === "unavailable") {
    throw new CostEstimationError(engine.problem, 503);
  }

  const source = await collectCostSources(input.token, input.project);
  const usageAssumptions = readCostUsageAssumptions(
    input.usageAssumptions ?? input.project.costUsage,
  );
  const assumptionsHash = costUsageHash(usageAssumptions);
  if (!input.force) {
    const cached = await database.projectCostSnapshot.findFirst({
      where: {
        projectId: input.project.id,
        sourceSha: source.sha,
        region: input.project.awsRegion,
        currency: engine.currency,
        estimatorVersion: INFRACOST_VERSION,
        assumptionsHash,
      },
      orderBy: { createdAt: "desc" },
    });
    if (cached) return snapshotDto(cached);
  }

  const key = `${input.project.id}:${source.sha}:${input.project.awsRegion}:${engine.currency}:${assumptionsHash}`;
  const pending = pendingEstimates.get(key);
  if (pending) return pending;

  const scanFiles = [...source.files, ...costUsageFiles(usageAssumptions)];
  const estimate = (async () => {
    const run =
      engine.kind === "service"
        ? await runRemoteInfracost(engine, scanFiles, input.token)
        : await runLocalSourceFiles(engine.binary, scanFiles, input.token);
    const stderr = redactProcessText(run.stderr.trim(), input.token);
    const parsedOutput = run.stdout.trim()
      ? parseInfracostOutput(run.stdout)
      : null;
    const parsed = parsedOutput
      ? {
          ...parsedOutput,
          diagnostics: parsedOutput.diagnostics.map((diagnostic) => ({
            ...diagnostic,
            message: redactProcessText(diagnostic.message, input.token),
            location: diagnostic.location
              ? redactProcessText(diagnostic.location, input.token)
              : null,
          })),
        }
      : null;
    if (!parsed) {
      throw new CostEstimationError(
        stderr || "Infracost did not return an estimate.",
        502,
      );
    }
    if (run.code !== 0 && parsed.resources.length === 0) {
      const critical = parsed.diagnostics
        .filter((diagnostic) => diagnostic.severity === "critical")
        .map((diagnostic) => diagnostic.message)
        .join(" ");
      throw new CostEstimationError(
        critical || stderr || "Infracost could not analyze the project.",
        422,
      );
    }

    const saved = await database.projectCostSnapshot.create({
      data: {
        projectId: input.project.id,
        sourceSha: source.sha,
        region: input.project.awsRegion,
        currency: parsed.currency,
        totalMonthlyCost: parsed.totalMonthlyCost,
        resourceCount: parsed.resourceCount,
        costedResources: parsed.costedResources,
        freeResources: parsed.freeResources,
        estimatorVersion: INFRACOST_VERSION,
        assumptionsHash,
        usageAssumptions: JSON.parse(
          JSON.stringify(usageAssumptions),
        ) as Prisma.InputJsonValue,
        breakdown: JSON.parse(
          JSON.stringify(parsed.resources),
        ) as Prisma.InputJsonValue,
        diagnostics: JSON.parse(
          JSON.stringify(parsed.diagnostics),
        ) as Prisma.InputJsonValue,
      },
    });
    return snapshotDto(saved);
  })().finally(() => pendingEstimates.delete(key));

  pendingEstimates.set(key, estimate);
  return estimate;
}
