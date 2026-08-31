/**
 * Loads modules together with the modules they call, so an architecture
 * diagram can draw a wrapper's real shape rather than a row of opaque boxes.
 *
 * The result is a flat map keyed by module id, not a nested tree. A module is
 * commonly called more than once — `ap-aws-standalone-vpc` calls the same
 * `endpoints` submodule twice — and a tree would ship its contents once per
 * call site.
 *
 * Shared by the module page (one root) and the project canvas (one root per
 * `module` block on the canvas), because the traversal is the same either way.
 */

import { database } from "@/lib/database";
import { visibleToUser } from "@/lib/modules/ownership";
import { resolveModuleLinks } from "./module-link";

/**
 * Deep enough for the real shapes (root -> wrapper -> service module), shallow
 * enough that one page view cannot walk an entire module estate.
 */
export const MAX_ARCHITECTURE_DEPTH = 4;

/**
 * One `output` block of a module, reduced to what placement needs.
 *
 * The expression is the point: `public_subnets = aws_subnet.public[*].id` is the
 * only thing that ties the name a caller writes to the resource it really names,
 * and naming conventions are no substitute — `database_subnets` and
 * `database_subnet_group` differ by one word and mean different objects.
 */
export interface ModuleOutputRecord {
  name: string;
  valueExpression: string | null;
}

/** A declared variable, reduced to what guard evaluation needs. */
export interface ModuleVariableRecord {
  name: string;
  /** Absent when the variable has no default; the raw parsed HCL value. */
  default?: unknown;
}

/** A `locals` entry, reduced to what guard evaluation needs. */
export interface ModuleLocalRecord {
  name: string;
  expression: string | null;
}

export interface ModuleArchitectureRecord {
  id: string;
  name: string;
  versionTag: string | null;
  resources: unknown[];
  references: unknown[];
  /**
   * Needed one level up rather than here: a caller wiring `subnet_id =
   * module.vpc.public_subnets[0]` can only be drawn inside the right subnet if
   * the callee's outputs are on hand to say which subnet that is.
   */
  outputs: ModuleOutputRecord[];
  /**
   * Defaults and locals, so `count = local.create_public_subnets ? … : 0` can be
   * settled against the arguments the caller actually passed. Without them every
   * optional block has to be drawn as though it existed.
   */
  variables: ModuleVariableRecord[];
  locals: ModuleLocalRecord[];
  moduleCalls: {
    name: string;
    source: string | null;
    /** Carried through so a registry address is not read as a Git URL. */
    sourceKind: string | null;
    linkedModule: {
      moduleId: string;
      exactVersion: boolean;
      requestedRef: string | null;
    } | null;
  }[];
}

/**
 * Narrows the stored `outputs` JSON to the two fields placement reads.
 *
 * Validated rather than cast because the column is JSON: modules imported before
 * the analyser recorded `valueExpression` have rows without it, and a missing
 * expression has to mean "cannot be resolved" rather than crash the diagram.
 */
function moduleOutputs(value: unknown): ModuleOutputRecord[] {
  if (!Array.isArray(value)) return [];

  const outputs: ModuleOutputRecord[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { name?: unknown; valueExpression?: unknown };
    if (typeof record.name !== "string") continue;

    outputs.push({
      name: record.name,
      valueExpression:
        typeof record.valueExpression === "string"
          ? record.valueExpression
          : null,
    });
  }

  return outputs;
}

/**
 * Narrows the stored `variables` JSON to the name and default.
 *
 * `default` is copied only when the key is present: a variable without one is
 * required, and "no default" has to stay distinguishable from "defaults to null"
 * or the evaluator would resolve guards it has no business resolving.
 */
function moduleVariables(value: unknown): ModuleVariableRecord[] {
  if (!Array.isArray(value)) return [];

  const variables: ModuleVariableRecord[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { name?: unknown; default?: unknown };
    if (typeof record.name !== "string") continue;

    variables.push(
      Object.hasOwn(record, "default")
        ? { name: record.name, default: record.default }
        : { name: record.name },
    );
  }

  return variables;
}

/** Narrows the stored `locals` JSON. Empty on modules imported before it existed. */
function moduleLocals(value: unknown): ModuleLocalRecord[] {
  if (!Array.isArray(value)) return [];

  const locals: ModuleLocalRecord[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { name?: unknown; expression?: unknown };
    if (typeof record.name !== "string") continue;

    locals.push({
      name: record.name,
      expression:
        typeof record.expression === "string" ? record.expression : null,
    });
  }

  return locals;
}

export function clampArchitectureDepth(requested: unknown): number {
  const value = Number(requested ?? MAX_ARCHITECTURE_DEPTH);
  return Number.isFinite(value)
    ? Math.min(Math.max(Math.trunc(value), 1), MAX_ARCHITECTURE_DEPTH)
    : MAX_ARCHITECTURE_DEPTH;
}

export async function loadModuleArchitectures(
  userId: string,
  rootIds: string[],
  depth: number,
): Promise<Record<string, ModuleArchitectureRecord>> {
  const modules: Record<string, ModuleArchitectureRecord> = {};
  if (rootIds.length === 0) return modules;

  // Loaded once and reused at every level: link resolution needs the full set
  // of modules the user can see regardless of which level is being expanded.
  const linkCandidates = (
    await database.terraformModule.findMany({
      where: visibleToUser(userId),
      select: {
        id: true,
        versionTag: true,
        terraformRootFolder: true,
        submoduleName: true,
        createdAt: true,
        source: { select: { name: true, url: true } },
      },
    })
  ).map((candidate) => ({
    id: candidate.id,
    versionTag: candidate.versionTag,
    terraformRootFolder: candidate.terraformRootFolder,
    submoduleName: candidate.submoduleName,
    createdAt: candidate.createdAt,
    sourceUrl: candidate.source?.url ?? null,
    sourceName: candidate.source?.name ?? null,
  }));

  const seen = new Set<string>();
  let frontier = [...new Set(rootIds)];

  for (let level = 0; level <= depth && frontier.length > 0; level++) {
    const batch = await database.terraformModule.findMany({
      // Scoped at every level, not just the roots: a module id reached by
      // traversal is still an id the caller must be allowed to read.
      where: { id: { in: frontier }, ...visibleToUser(userId) },
      include: {
        // `url` so a relative `module` source can be resolved against the
        // repository this module came from.
        source: { select: { name: true, url: true } },
        // `outputs`, `variables` and `locals` are JSON columns on the module row,
        // so they come along with the record rather than as further queries.
        resources: {
          // The extra columns exist so a box inside an expanded module opens
          // the same detail panel as one belonging to the module itself. They
          // are short (a file path and a docs URL) and the rows were already
          // being sent, so this widens the payload rather than lengthening it.
          select: {
            resourceType: true,
            resourceName: true,
            kind: true,
            providerName: true,
            providerUrl: true,
            sourceFile: true,
            // Decides whether a nested subnet is drawn as public or only
            // conditionally public, so it has to travel with the resource.
            conditionalOn: true,
            // Names each instance of a multi-instance subnet, so two frames read
            // as two zones rather than as `[0]` and `[1]`.
            availabilityZone: true,
            resourceUrl: true,
            resourceDescription: true,
          },
        },
        references: {
          select: { fromAddress: true, toAddress: true, attributes: true },
        },
        dependencies: {
          select: { id: true, name: true, source: true, sourceKind: true },
          orderBy: { name: "asc" },
        },
      },
    });

    const next: string[] = [];

    for (const mod of batch) {
      seen.add(mod.id);

      const links = resolveModuleLinks(
        mod.dependencies,
        linkCandidates.filter((candidate) => candidate.id !== mod.id),
        // Lets `source = "./modules/cluster"` find the submodule of this very
        // repository that the import already analysed.
        {
          sourceUrl: mod.source?.url ?? mod.url,
          versionTag: mod.versionTag,
          terraformRootFolder: mod.terraformRootFolder,
        },
      );

      modules[mod.id] = {
        id: mod.id,
        name: mod.submoduleName ?? mod.source?.name ?? "(unnamed)",
        versionTag: mod.versionTag,
        resources: mod.resources,
        references: mod.references,
        outputs: moduleOutputs(mod.outputs),
        variables: moduleVariables(mod.variables),
        locals: moduleLocals(mod.locals),
        moduleCalls: mod.dependencies.map((dependency) => ({
          name: dependency.name,
          source: dependency.source,
          sourceKind: dependency.sourceKind,
          linkedModule: links.get(dependency.id) ?? null,
        })),
      };

      // The frontier only grows with modules not yet seen, which is what stops
      // a cycle (A calls B calls A) from looping forever.
      for (const link of links.values()) {
        if (!seen.has(link.moduleId) && !next.includes(link.moduleId)) {
          next.push(link.moduleId);
        }
      }
    }

    frontier = next;
  }

  return modules;
}
