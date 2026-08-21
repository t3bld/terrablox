/**
 * The project as it *will* be, once this turn's queued edits are committed.
 *
 * The agent does not change anything while it works: every tool call queues a
 * mutation, and the app applies the queue after the turn. That is the right design
 * — one code path, one commit, nothing half-applied — and it left the agent
 * working blind. The graph in its prompt describes the repository as it was when
 * the turn started, so after four `add_module` calls the agent had no way to ask
 * what it had built, which inputs it still had to fill, or whether the output it
 * was about to wire from existed.
 *
 * This is that missing answer. It starts from the graph the turn was given and
 * replays each queued mutation over it in memory, which buys three things:
 *
 *   validation   `connect` can check that `sourceOutput` is a real output of a
 *                module added ten calls ago, not just that the block exists
 *   review       `review_project` can report what is still unfinished, so a turn
 *                ends by completing the work rather than by running out of steps
 *   honesty      the agent's own summary of what it did is derived rather than
 *                remembered
 *
 * It mirrors the mutation code rather than sharing it, because the real path
 * rewrites HCL text through the GitHub API and this needs an answer in
 * microseconds with no network. Where the two could drift in a way that matters —
 * the label a collision resolves to, the auto-wiring a new module arrives with —
 * this calls the same functions the real path calls, so the projection names the
 * same block the commit will.
 *
 * It is a projection and not a promise. A mutation can still fail on commit; the
 * turn's step trail is what records that.
 */

import type { AgentLibraryModule, AgentPort } from "@/lib/agent/library-view";
import { computeGaps, type GapNode } from "@/lib/projects/graph";
import { localsReferencedIn } from "@/lib/projects/locals";
import type {
  ProjectGraph,
  ProjectGraphGap,
  ProjectGraphMutation,
  ProjectGraphNode,
} from "@/lib/projects/types";
import {
  coerceHclValue,
  MIN_WIRING_SCORE,
  unambiguousSource,
  wiringScore,
} from "@/lib/projects/wiring";
import { uniqueBlockLabel } from "@/lib/terraform/hcl-edit";
import { checkValueAgainstType } from "@/lib/terraform/type-check";

export interface ProjectedModule {
  /** Block label, which is how every tool names it. */
  name: string;
  /** Library module it resolves to, when the library knows it. */
  moduleId: string | null;
  moduleName: string | null;
  version: string | null;
  inputs: AgentPort[];
  outputs: AgentPort[];
  /** Arguments the block sets, as HCL, keyed by input name. */
  values: Record<string, string>;
  /**
   * Whether this block's ports are known at all.
   *
   * A `module` block whose source is not in the library — someone wrote it by
   * hand against a registry module we never imported — has no declared ports here.
   * Validation has to stand down for those rather than refuse every edit to them.
   */
  portsKnown: boolean;
  /** True when this turn added it, so a review can say what it changed. */
  pending: boolean;
}

export interface ProjectedLocal {
  name: string;
  /** The expression as it will be written, already coerced to HCL. */
  value: string;
  pending: boolean;
}

/**
 * Something wrong with the projected configuration.
 *
 * `blocking` separates "this will not plan" from "this looks unintended". Both
 * are worth reporting; only the first is worth a turn refusing to end.
 */
export interface ProjectionProblem {
  kind:
    | "missing-input"
    | "unknown-argument"
    | "unknown-output"
    | "dangling-module"
    | "dangling-local"
    | "type-mismatch"
    | "unused-local";
  blocking: boolean;
  /** One sentence, addressed to whoever has to fix it. */
  message: string;
}

export class GraphProjection {
  private readonly modules = new Map<string, ProjectedModule>();
  private readonly locals = new Map<string, ProjectedLocal>();
  private readonly library: readonly AgentLibraryModule[];
  private readonly libraryById: Map<string, AgentLibraryModule>;

  constructor(graph: ProjectGraph, library: readonly AgentLibraryModule[]) {
    this.library = library;
    this.libraryById = new Map(library.map((module) => [module.id, module]));

    for (const node of graph.nodes) {
      if (node.kind === "module") {
        this.modules.set(node.id, this.fromGraphNode(node));
      } else {
        this.locals.set(node.id, {
          name: node.id,
          value: node.expression ?? "",
          pending: false,
        });
      }
    }
  }

  /**
   * A placed block's ports, preferring the library's copy of them.
   *
   * The graph carries the ports it needs to draw a node — a name and a
   * description. The library carries the declared type, the default and the
   * inferred output type, which is what makes a type check possible. Same module,
   * more of it.
   */
  private fromGraphNode(node: ProjectGraphNode): ProjectedModule {
    const known = node.moduleId
      ? this.libraryById.get(node.moduleId)
      : undefined;

    const inputs = known?.inputs ?? node.inputs.map(toAgentPort);
    const outputs = known?.outputs ?? node.outputs.map(toAgentPort);

    return {
      name: node.id,
      moduleId: node.moduleId,
      moduleName: node.moduleName,
      version: node.version,
      inputs,
      outputs,
      values: { ...node.values },
      portsKnown: inputs.length > 0 || outputs.length > 0,
      pending: false,
    };
  }

  // ---- Reading -----------------------------------------------------------

  module(name: string): ProjectedModule | undefined {
    return this.modules.get(name);
  }

  local(name: string): ProjectedLocal | undefined {
    return this.locals.get(name);
  }

  moduleNames(): string[] {
    return [...this.modules.keys()];
  }

  localNames(): string[] {
    return [...this.locals.keys()];
  }

  allModules(): ProjectedModule[] {
    return [...this.modules.values()];
  }

  allLocals(): ProjectedLocal[] {
    return [...this.locals.values()];
  }

  /** Whether an input is currently fed by a `local.` reference. */
  readsLocal(target: string, targetInput: string): boolean {
    const value = this.modules.get(target)?.values[targetInput];
    return value !== undefined && localsReferencedIn(value).length > 0;
  }

  /** Whether an input has any value at all, from wherever. */
  isSet(target: string, targetInput: string): boolean {
    return this.modules.get(target)?.values[targetInput] !== undefined;
  }

  // ---- Applying ----------------------------------------------------------

  /**
   * The label `add_module` will actually produce.
   *
   * Resolved through the same helper the mutation uses, so a name the agent asked
   * for and did not get is a name it can be told about in the same call rather
   * than one it discovers by wiring to a block that is not there.
   */
  labelFor(moduleId: string, wanted: string | undefined): string {
    const module = this.libraryById.get(moduleId);
    return uniqueBlockLabel(
      this.modules.keys(),
      wanted?.trim() || module?.name || "module",
    );
  }

  apply(mutation: ProjectGraphMutation): void {
    switch (mutation.action) {
      case "add-module": {
        const module = this.libraryById.get(mutation.moduleId);
        const name = this.labelFor(mutation.moduleId, mutation.name);

        this.modules.set(name, {
          name,
          moduleId: mutation.moduleId,
          moduleName: module?.name ?? null,
          version: module?.versionTag ?? null,
          inputs: module?.inputs ?? [],
          outputs: module?.outputs ?? [],
          values: {},
          portsKnown: module !== undefined,
          pending: true,
        });

        // The real mutation wires what it unambiguously can, so a projection that
        // did not would report gaps the commit is about to fill — and the agent
        // would spend operations re-doing them.
        this.autoWire(name);
        break;
      }

      case "remove-module":
        this.modules.delete(mutation.name);
        this.stripReferences((value) => referencesModule(value, mutation.name));
        break;

      case "rename-module": {
        const module = this.modules.get(mutation.name);
        if (!module) break;
        this.modules.delete(mutation.name);
        this.modules.set(mutation.newName, {
          ...module,
          name: mutation.newName,
        });
        this.rewrite((value) =>
          value.replace(
            new RegExp(`\\bmodule\\.${escapeForRegExp(mutation.name)}\\b`, "g"),
            `module.${mutation.newName}`,
          ),
        );
        break;
      }

      case "connect":
        this.set(
          mutation.target,
          mutation.targetInput,
          `module.${mutation.source}.${mutation.sourceOutput}`,
        );
        break;

      case "connect-local":
        this.set(
          mutation.target,
          mutation.targetInput,
          `local.${mutation.local}`,
        );
        break;

      case "disconnect": {
        const module = this.modules.get(mutation.target);
        if (module) delete module.values[mutation.targetInput];
        break;
      }

      case "set-argument":
        this.set(mutation.name, mutation.input, coerceHclValue(mutation.value));
        break;

      case "auto-connect":
        this.autoWire(mutation.name);
        break;

      case "add-local": {
        this.locals.set(mutation.name, {
          name: mutation.name,
          value: coerceHclValue(mutation.value),
          pending: true,
        });
        if (mutation.connectTo) {
          this.set(
            mutation.connectTo.target,
            mutation.connectTo.targetInput,
            `local.${mutation.name}`,
          );
        }
        break;
      }

      case "set-local": {
        const local = this.locals.get(mutation.name);
        if (local) local.value = coerceHclValue(mutation.value);
        break;
      }

      case "rename-local": {
        const local = this.locals.get(mutation.name);
        if (!local) break;
        this.locals.delete(mutation.name);
        this.locals.set(mutation.newName, {
          ...local,
          name: mutation.newName,
        });
        this.rewrite((value) =>
          value.replace(
            new RegExp(`\\blocal\\.${escapeForRegExp(mutation.name)}\\b`, "g"),
            `local.${mutation.newName}`,
          ),
        );
        break;
      }

      case "remove-local":
        this.locals.delete(mutation.name);
        this.stripReferences((value) =>
          localsReferencedIn(value).includes(mutation.name),
        );
        break;
    }
  }

  private set(target: string, input: string, value: string): void {
    const module = this.modules.get(target);
    if (module) module.values[input] = value;
  }

  /** Drops every argument whose expression matches, as a delete cascade does. */
  private stripReferences(matches: (value: string) => boolean): void {
    for (const module of this.modules.values()) {
      for (const [input, value] of Object.entries(module.values)) {
        if (matches(value)) delete module.values[input];
      }
    }
    for (const local of this.locals.values()) {
      if (matches(local.value)) local.value = "";
    }
  }

  private rewrite(transform: (value: string) => string): void {
    for (const module of this.modules.values()) {
      for (const [input, value] of Object.entries(module.values)) {
        module.values[input] = transform(value);
      }
    }
    for (const local of this.locals.values()) {
      local.value = transform(local.value);
    }
  }

  /**
   * Fills a module's unset required inputs from unambiguous matches.
   *
   * The same rule as the canvas: one clear source or none at all. A wrong wire is
   * silent — it plans, it applies, and it builds the wrong thing.
   */
  private autoWire(name: string): void {
    const target = this.modules.get(name);
    if (!target) return;

    const producers = [...this.modules.values()].filter(
      (module) => module.name !== name,
    );
    if (producers.length === 0) return;

    for (const input of target.inputs) {
      if (!input.required) continue;
      if (target.values[input.name] !== undefined) continue;

      const candidates = producers.flatMap((producer) =>
        producer.outputs.map((output) => ({
          producer: producer.name,
          output: output.name,
          // A block is often named after what it is (`vpc`), but not always
          // (`this`), so the module's own name is a second chance at the prefix.
          score: Math.max(
            wiringScore(input.name, output.name, producer.name),
            producer.moduleName
              ? wiringScore(input.name, output.name, producer.moduleName)
              : 0,
          ),
        })),
      );

      const choice = unambiguousSource(candidates);
      if (!choice) continue;

      target.values[input.name] = `module.${choice.producer}.${choice.output}`;
    }
  }

  // ---- Checking ----------------------------------------------------------

  /**
   * Required inputs still unfilled, with what could fill them.
   *
   * Delegated to the canvas's own gap detection so the agent's checklist and the
   * user's are the same list. A projected module that the library does not know
   * declares no inputs, so it contributes no gaps — right answer: we have nothing
   * to claim about a module we never analysed.
   */
  gaps(): ProjectGraphGap[] {
    const placed = new Set(
      [...this.modules.values()]
        .map((module) => module.moduleId)
        .filter((id): id is string => id !== null),
    );

    return computeGaps(
      [...this.modules.values()].map(toGapNode),
      this.library
        .filter((module) => !placed.has(module.id))
        .map((module) => ({
          moduleId: module.id,
          name: module.name,
          outputs: module.outputs.map((output) => output.name),
        })),
    );
  }

  /**
   * Everything wrong with the projected configuration, worst first.
   *
   * Not a substitute for `terraform validate`, which needs the providers
   * downloaded and the whole configuration in hand. It is the subset that can be
   * decided from what we already know — and, as it happens, the subset an agent
   * gets wrong: a misremembered port name, an argument that module never
   * declared, a reference to something it removed two calls ago.
   */
  problems(): ProjectionProblem[] {
    const problems: ProjectionProblem[] = [];

    for (const gap of this.gaps()) {
      const from = [
        ...gap.wirable.map((w) => `${w.node}.${w.output}`),
        ...gap.candidates.map((c) => `${c.name} (add ${c.moduleId})`),
      ];

      problems.push({
        kind: "missing-input",
        blocking: true,
        message: `${gap.node}.${gap.input}${gap.type ? ` (${gap.type})` : ""} is required and unset${
          from.length ? `; could come from ${from.join(" or ")}` : ""
        }.`,
      });
    }

    for (const module of this.modules.values()) {
      for (const [input, value] of Object.entries(module.values)) {
        const declared = module.inputs.find((port) => port.name === input);

        if (!declared && module.portsKnown) {
          const suggestion = closestName(
            input,
            module.inputs.map((port) => port.name),
          );
          problems.push({
            kind: "unknown-argument",
            blocking: true,
            message: `${module.name} has no input called "${input}"${
              suggestion ? `; did you mean "${suggestion}"?` : ""
            } Terraform rejects an undeclared argument.`,
          });
          continue;
        }

        const mismatch = declared
          ? checkValueAgainstType(declared.type, value)
          : null;
        if (mismatch) {
          problems.push({
            kind: "type-mismatch",
            blocking: true,
            message: `${module.name}.${input} ${mismatch}`,
          });
        }

        problems.push(
          ...this.checkReferences(`${module.name}.${input}`, value),
        );
      }
    }

    for (const local of this.locals.values()) {
      problems.push(
        ...this.checkReferences(`local.${local.name}`, local.value),
      );
    }

    for (const name of this.unusedLocals()) {
      problems.push({
        kind: "unused-local",
        blocking: false,
        message: `local.${name} is not read anywhere. Wire it into an input or remove it.`,
      });
    }

    return problems.sort((a, b) => Number(b.blocking) - Number(a.blocking));
  }

  /** References in one expression that point at something that is not there. */
  private checkReferences(where: string, value: string): ProjectionProblem[] {
    const problems: ProjectionProblem[] = [];

    for (const [, name, output] of value.matchAll(
      /\bmodule\.([A-Za-z_][A-Za-z0-9_-]*)(?:\.([A-Za-z_][A-Za-z0-9_-]*))?/g,
    )) {
      if (!name) continue;
      const producer = this.modules.get(name);

      if (!producer) {
        const suggestion = closestName(name, this.moduleNames());
        problems.push({
          kind: "dangling-module",
          blocking: true,
          message: `${where} reads module.${name}, which does not exist${
            suggestion ? `; did you mean "${suggestion}"?` : ""
          }.`,
        });
        continue;
      }

      if (
        output &&
        producer.portsKnown &&
        !producer.outputs.some((port) => port.name === output)
      ) {
        const names = producer.outputs.map((port) => port.name);
        const suggestion = closestName(output, names);
        problems.push({
          kind: "unknown-output",
          blocking: true,
          // The real names, not only the nearest one. A suggestion is a guess that
          // often misses — `subnet_ids` is nowhere near `private_subnets` — and a
          // message that then says nothing leaves the only fix to another guess.
          message: `${where} reads module.${name}.${output}, but ${name} has no such output${
            suggestion ? `; did you mean "${suggestion}"?` : ""
          }. It exposes ${summariseNames(names)}.`,
        });
      }
    }

    for (const name of localsReferencedIn(value)) {
      if (this.locals.has(name)) continue;
      const suggestion = closestName(name, this.localNames());
      problems.push({
        kind: "dangling-local",
        blocking: true,
        message: `${where} reads local.${name}, which does not exist${
          suggestion ? `; did you mean "${suggestion}"?` : ""
        }.`,
      });
    }

    return problems;
  }

  /** Locals no module argument and no other local reads. */
  unusedLocals(): string[] {
    const read = new Set<string>();

    for (const module of this.modules.values()) {
      for (const value of Object.values(module.values)) {
        for (const name of localsReferencedIn(value)) read.add(name);
      }
    }
    for (const local of this.locals.values()) {
      for (const name of localsReferencedIn(local.value)) {
        // A local reading itself is a cycle, not a use.
        if (name !== local.name) read.add(name);
      }
    }

    return this.localNames().filter((name) => !read.has(name));
  }

  /**
   * Outputs on the canvas that plausibly fill an input, by the naming rule.
   *
   * The same scoring the canvas wires with, exposed so the agent can be *told*
   * what would fit rather than having to infer the convention from examples.
   */
  wirableFor(target: string, input: string): Array<{ from: string }> {
    return [...this.modules.values()]
      .filter((module) => module.name !== target)
      .flatMap((module) =>
        module.outputs
          .filter(
            (output) =>
              Math.max(
                wiringScore(input, output.name, module.name),
                module.moduleName
                  ? wiringScore(input, output.name, module.moduleName)
                  : 0,
              ) >= MIN_WIRING_SCORE,
          )
          .map((output) => ({ from: `${module.name}.${output.name}` })),
      );
  }
}

function toAgentPort(port: {
  name: string;
  description: string | null;
  required?: boolean;
  type?: string | null;
}): AgentPort {
  return {
    name: port.name,
    type: port.type ?? null,
    required: port.required ?? false,
    description: port.description,
  };
}

function toGapNode(module: ProjectedModule): GapNode {
  return {
    id: module.name,
    label: module.name,
    inputs: module.inputs,
    outputs: module.outputs,
    setArguments: Object.keys(module.values),
  };
}

/** Names in a sentence, with a pointer to the tool that lists the rest. */
function summariseNames(names: readonly string[]): string {
  if (names.length === 0) return "no outputs";
  if (names.length <= 12) return names.join(", ");
  return `${names.slice(0, 12).join(", ")} and ${names.length - 12} more (describe_module lists them)`;
}

function referencesModule(value: string, name: string): boolean {
  return new RegExp(`\\bmodule\\.${escapeForRegExp(name)}\\b`).test(value);
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The closest of a set of names, when one is close enough to be worth offering.
 *
 * The point of a "did you mean" is that a wrong name costs the turn one call
 * instead of a wrong commit. That only works if the suggestion is usually right,
 * so the threshold is strict: a third of the name may differ, no more. Below that
 * the refusal simply says the name is unknown, which is still actionable.
 */
export function closestName(
  wanted: string,
  candidates: readonly string[],
): string | null {
  const needle = wanted.trim().toLowerCase();
  if (!needle) return null;

  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const distance = editDistance(needle, candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }

  const allowed = Math.max(1, Math.floor(needle.length / 3));
  return best !== null && bestDistance <= allowed ? best : null;
}

/** Levenshtein, two rows at a time; the inputs here are identifier-sized. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution =
        (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(
        substitution,
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
      );
    }
    previous = current;
  }

  return previous[b.length] as number;
}
