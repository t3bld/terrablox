import {
  type ModuleOutputDto,
  type ModuleVariableDto,
  parseOutputs,
  parseVariables,
} from "@/components/module-detail/types";
import {
  findBlock,
  listBlockAttributes,
  listBlocks,
} from "@/lib/terraform/hcl-edit";
import {
  type LinkCandidate,
  resolveModuleLink,
} from "@/lib/terraform/module-link";
import type { TerraformAnalysis } from "@/lib/terraform/types";

import type {
  ProjectGraph,
  ProjectGraphEdge,
  ProjectGraphGap,
  ProjectGraphNode,
  ProjectGraphPort,
} from "./types";
import { MIN_WIRING_SCORE, wiringScore } from "./wiring";

/** A module from the user's library, with everything needed to wire it up. */
export interface LibraryModule extends LinkCandidate {
  variables: unknown;
  outputs: unknown;
}

function toInputPorts(variables: ModuleVariableDto[]): ProjectGraphPort[] {
  return variables.map((v) => ({
    name: v.name,
    description: v.description,
    required: v.required ?? false,
    type: v.type,
  }));
}

function toOutputPorts(outputs: ModuleOutputDto[]): ProjectGraphPort[] {
  return outputs.map((o) => ({ name: o.name, description: o.description }));
}

/** `module.vpc` -> `vpc`; anything else is not a module call. */
function moduleLabel(address: string): string | null {
  const match = /^module\.([A-Za-z0-9_-]+)/.exec(address);
  return match?.[1] ?? null;
}

/**
 * The arguments a `module` block sets, with their expressions.
 *
 * The analysis only reports arguments that reference another block, but the
 * canvas has to distinguish "not wired" from "wired to a literal" — a required
 * input that already has a hard-coded value is not a gap the user must fill —
 * and the inspector needs the expression itself to show and edit it.
 */
function collectArguments(
  files: Map<string, string>,
  file: string | null,
  name: string,
): Record<string, string> {
  const content = file ? files.get(file) : undefined;
  if (!content) return {};

  const block = findBlock(content, "module", name);
  if (!block) return {};

  const values: Record<string, string> = {};
  for (const attribute of listBlockAttributes(content, block)) {
    if (attribute.name === "source" || attribute.name === "version") continue;
    values[attribute.name] = attribute.value.trim();
  }

  return values;
}

/**
 * Which output of `source` the target's argument reads.
 *
 * The analysis only records that one module depends on another, but the canvas
 * draws wires between individual ports, so the output name is recovered from
 * the expression itself. Returns null for anything that is not a plain
 * `module.x.y` lookup (a `for` expression, a function call, a splat), where
 * naming a single port would be a guess.
 */
function findReferencedOutput(
  files: Map<string, string>,
  target: ProjectGraphNode,
  attribute: string,
  source: string,
): string | null {
  const content = target.file ? files.get(target.file) : undefined;
  if (!content) return null;

  const block = findBlock(content, "module", target.id);
  if (!block) return null;

  const span = listBlockAttributes(content, block).find(
    (candidate) => candidate.name === attribute,
  );
  if (!span) return null;

  const pattern = new RegExp(
    `module\\.${escapeForRegExp(source)}\\.([A-Za-z_][A-Za-z0-9_-]*)`,
    "g",
  );
  const names = new Set(
    [...span.value.matchAll(pattern)].map((match) => match[1] as string),
  );

  return names.size === 1 ? ([...names][0] as string) : null;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface BuildProjectGraphInput {
  analysis: TerraformAnalysis;
  /** Root `.tf` files by repository-relative path. */
  files: Map<string, string>;
  library: LibraryModule[];
  positions: Record<string, { x: number; y: number }>;
  sha: string;
}

export function buildProjectGraph(input: BuildProjectGraphInput): ProjectGraph {
  const { analysis, files, library, positions } = input;

  const nodes: ProjectGraphNode[] = analysis.moduleCalls.map((call) => {
    const link = resolveModuleLink(call.source, call.sourceKind, library);
    const imported = link
      ? library.find((m) => m.id === link.moduleId)
      : undefined;

    const position = positions[call.name];
    const values = collectArguments(files, call.file, call.name);

    return {
      id: call.name,
      label: call.name,
      source: call.source,
      version: call.version,
      sourceKind: call.sourceKind,
      file: call.file,
      moduleId: link?.moduleId ?? null,
      moduleName: link?.name ?? null,
      exactVersion: link?.exactVersion ?? true,
      inputs: imported ? toInputPorts(parseVariables(imported.variables)) : [],
      outputs: imported ? toOutputPorts(parseOutputs(imported.outputs)) : [],
      setArguments: Object.keys(values).sort(),
      values,
      position: position ? { x: position.x, y: position.y } : null,
    } satisfies ProjectGraphNode;
  });

  const known = new Map(nodes.map((node) => [node.id, node]));
  const edges = new Map<string, ProjectGraphEdge>();

  for (const reference of analysis.references) {
    if (reference.fromKind !== "module" || reference.toKind !== "module") {
      continue;
    }

    // A reference records "the consumer depends on the producer"; the graph
    // draws the value's direction, so the producer becomes the edge source.
    const target = moduleLabel(reference.fromAddress);
    const source = moduleLabel(reference.toAddress);
    if (!source || !target || source === target) continue;

    const targetNode = known.get(target);
    if (!targetNode || !known.has(source)) continue;

    const id = `${source}->${target}`;
    const edge = edges.get(id) ?? { id, source, target, links: [] };

    for (const attribute of reference.attributes) {
      if (edge.links.some((link) => link.targetInput === attribute)) continue;
      edge.links.push({
        targetInput: attribute,
        sourceOutput: findReferencedOutput(
          files,
          targetNode,
          attribute,
          source,
        ),
      });
    }

    edges.set(id, edge);
  }

  return {
    nodes,
    edges: [...edges.values()],
    gaps: findGaps(nodes, library),
    resourceCount: analysis.resources.length,
    files: [...files.keys()].sort(),
    sha: input.sha,
    errors: analysis.errors,
  };
}

/** What a library module is called once it is on the canvas. */
export function libraryModuleName(module: LibraryModule): string {
  return module.submoduleName ?? module.sourceName ?? module.id;
}

/**
 * Required inputs that nothing fills yet, with the modules that could.
 *
 * This is what turns the canvas from a drawing into a checklist: a module is
 * only useful once its dependencies are satisfied, and the user should not have
 * to open the documentation to find out which module produces a `vpc_id`.
 */
export function findGaps(
  nodes: ProjectGraphNode[],
  library: LibraryModule[],
): ProjectGraphGap[] {
  const placedModuleIds = new Set(
    nodes.map((node) => node.moduleId).filter(Boolean),
  );

  const providers = library
    .filter((module) => !placedModuleIds.has(module.id))
    .map((module) => ({
      moduleId: module.id,
      name: libraryModuleName(module),
      outputs: parseOutputs(module.outputs).map((output) => output.name),
    }));

  const gaps: ProjectGraphGap[] = [];

  for (const node of nodes) {
    for (const input of node.inputs) {
      if (!input.required) continue;
      if (node.setArguments.includes(input.name)) continue;

      const wirable = nodes
        .filter((other) => other.id !== node.id)
        .flatMap((other) =>
          other.outputs
            .filter(
              (output) =>
                wiringScore(input.name, output.name, other.label) >=
                MIN_WIRING_SCORE,
            )
            .map((output) => ({ node: other.id, output: output.name })),
        );

      const candidates = providers.flatMap((provider) =>
        provider.outputs
          .filter(
            (output) =>
              wiringScore(input.name, output, provider.name) >=
              MIN_WIRING_SCORE,
          )
          .map((output) => ({
            moduleId: provider.moduleId,
            name: provider.name,
            output,
          })),
      );

      gaps.push({
        node: node.id,
        input: input.name,
        type: input.type ?? null,
        wirable,
        candidates,
      });
    }
  }

  return gaps;
}

/** Labels already taken in the configuration, so new blocks avoid them. */
export function usedModuleLabels(files: Map<string, string>): string[] {
  const labels: string[] = [];

  for (const content of files.values()) {
    for (const block of listBlocks(content)) {
      if (block.type === "module" && block.labels[0]) {
        labels.push(block.labels[0]);
      }
    }
  }

  return labels;
}
