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
  answersNetworkInput,
  coerceHclValue,
  isPassThroughOutput,
  isVpcScopedAttribute,
  isWirableInput,
  MIN_WIRING_SCORE,
  networkRelationOf,
  providesNetworkShape,
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
 * How badly wrong a problem is, in the terms that decide what to do about it.
 *
 * Three levels rather than a boolean, and the middle one is the reason. It used to
 * be `blocking: boolean`, so an unwired load balancer had to be filed either as
 * "this will not plan" — untrue, every input has a default — or as advice, next to
 * "this local is unused". Filed as advice it was ignored, and the verdict on a
 * stack with no wiring at all read "Nothing left unfilled".
 *
 *   blocking    `terraform plan` fails. A misspelt input, a dangling reference.
 *   incomplete  it plans, it applies, and it builds something that cannot work:
 *               a service in no subnet, a database no network can reach.
 *   advisory    it works and looks unintended.
 */
export type ProblemSeverity = "blocking" | "incomplete" | "advisory";

/** Something wrong with the projected configuration. */
export interface ProjectionProblem {
  kind:
    | "missing-input"
    | "unwired-input"
    | "unknown-argument"
    | "unknown-output"
    | "dangling-module"
    | "dangling-local"
    | "type-mismatch"
    | "unused-local";
  severity: ProblemSeverity;
  /** One sentence, addressed to whoever has to fix it. */
  message: string;
}

/**
 * How many candidate sources one unwired input is offered.
 *
 * A VPC module exposes seven kinds of subnet, so `subnets` genuinely has seven
 * answers and the choice between them is the question. Past a handful the list
 * stops being a choice and starts being the reason nobody reads the review.
 */
const MAX_SUGGESTED_SOURCES = 6;

/** An input nothing fills, and what could fill it. */
export interface UnwiredInput {
  module: string;
  /** One input name, or several joined by "or" when any of them would do. */
  input: string;
  kind: "wirable" | "network";
  sources: string[];
}

/** Worst first, so a caller can read down and stop when it stops mattering. */
const SEVERITY_ORDER: Record<ProblemSeverity, number> = {
  blocking: 0,
  incomplete: 1,
  advisory: 2,
};

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

      case "set-arguments":
        for (const entry of mutation.values) {
          this.set(mutation.name, entry.input, coerceHclValue(entry.value));
        }
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

  /** Every other placed module, i.e. the possible sources for one module's inputs. */
  private producersFor(name: string): ProjectedModule[] {
    return [...this.modules.values()].filter((module) => module.name !== name);
  }

  /**
   * How well each output of each other module fits one input.
   *
   * Shared by the wiring and the reporting paths so they cannot disagree about
   * what counts as a match.
   */
  private candidatesFor(
    input: string,
    producers: ProjectedModule[],
  ): Array<{ producer: string; output: string; score: number }> {
    return producers.flatMap((producer) =>
      producer.outputs
        // An output that mirrors one of the producer's own inputs is that value
        // travelling through, not that module producing it.
        .filter((output) => !isPassThroughOutput(output.name, producer.inputs))
        .map((output) => ({
          producer: producer.name,
          output: output.name,
          // A block is often named after what it is (`vpc`), but not always
          // (`this`), so the module's own name is a second chance at the prefix.
          score: Math.max(
            wiringScore(input, output.name, producer.name),
            producer.moduleName
              ? wiringScore(input, output.name, producer.moduleName)
              : 0,
          ),
        })),
    );
  }

  /**
   * Fills a module's unset inputs from unambiguous matches.
   *
   * The same rule as the canvas: one clear source or none at all. A wrong wire is
   * silent — it plans, it applies, and it builds the wrong thing.
   *
   * No longer limited to *required* inputs, because that limit made this dead
   * code: almost no upstream module declares a required variable, so every wire it
   * could have drawn was skipped. {@link isWirableInput} is the replacement, and it
   * keeps the guarantee that mattered — a bare `name` is never filled from
   * somebody else's `name`.
   */
  private autoWire(name: string): void {
    const target = this.modules.get(name);
    if (!target) return;

    const producers = this.producersFor(name);
    if (producers.length === 0) return;

    for (const input of target.inputs) {
      if (!isWirableInput(input)) continue;
      if (target.values[input.name] !== undefined) continue;

      const choice = unambiguousSource(
        this.candidatesFor(input.name, producers),
      );
      if (!choice) continue;

      target.values[input.name] = `module.${choice.producer}.${choice.output}`;
    }
  }

  /**
   * Inputs left unset that something on this canvas could fill.
   *
   * The finding the agent had no way to make. `computeGaps` reports required
   * inputs only, and with 324 of 372 library modules declaring none it reports
   * nothing — so `review_project` said "Nothing left unfilled" about a stack whose
   * load balancer, ECS service and database were wired to nothing at all, and the
   * agent had no reason to disbelieve it.
   *
   * Two kinds, and the difference is whether the answer is known:
   *
   *   `wirable`  exactly one output fits by name, so this is a wire waiting to be
   *              drawn. `auto_connect` draws precisely these.
   *   `network`  the module is attached to no VPC or no subnet, the canvas offers
   *              one, and the names do not match closely enough to choose. Grouped
   *              per relation rather than per input, because several inputs carry
   *              the same fact and any one of them settles it.
   *
   * Nothing here blocks `terraform plan` — every one of these inputs has a
   * default. They stop the infrastructure from working, which is a different and
   * quieter kind of broken.
   */
  unwiredInputs(): UnwiredInput[] {
    const found: UnwiredInput[] = [];

    for (const target of this.modules.values()) {
      if (!target.portsKnown) continue;
      const producers = this.producersFor(target.name);
      if (producers.length === 0) continue;

      const certainSource = (input: string) => {
        const choice = unambiguousSource(this.candidatesFor(input, producers));
        return choice ? `${choice.producer}.${choice.output}` : null;
      };

      /** Unset inputs per network relation, and the relations already satisfied. */
      const open = new Map<string, string[]>();
      const attached = new Set<string>();

      for (const input of target.inputs) {
        // A security group cannot span VPCs, so a module handed one is in that
        // VPC. The same inference the architecture diagram draws with, and here it
        // is what stops a module wired through `security_group_ids` from being
        // told it belongs to no network.
        if (
          isVpcScopedAttribute(input.name) &&
          target.values[input.name] !== undefined
        ) {
          attached.add("vpc");
          continue;
        }

        const relation = networkRelationOf(input.name);
        if (!relation) continue;

        // Checked before the self-provider exemption below, or a module attached
        // through the one input it also exposes would count as attached by
        // nothing: ElastiCache both takes and returns `subnet_group_name`.
        if (target.values[input.name] !== undefined) {
          attached.add(relation);
          continue;
        }

        // A module that hands this kind of value out is not asking for one: the
        // VPC module takes `elasticache_subnet_group_name` to name the group it
        // creates.
        if (providesNetworkShape(target.outputs, input.name)) continue;

        open.set(relation, [...(open.get(relation) ?? []), input.name]);
      }

      // Required inputs outside the network vocabulary: reported only when one
      // source is certain, since there is nothing else useful to say about them.
      for (const input of target.inputs) {
        if (target.values[input.name] !== undefined) continue;
        if (networkRelationOf(input.name)) continue;
        if (!isWirableInput(input)) continue;

        const source = certainSource(input.name);
        if (source) {
          found.push({
            module: target.name,
            input: input.name,
            kind: "wirable",
            sources: [source],
          });
        }
      }

      for (const [relation, inputs] of open) {
        if (attached.has(relation)) continue;

        // One certain source settles the relation outright; that is the `vpc_id`
        // case, and it is the one `auto_connect` can finish by itself.
        const certain = inputs
          .map((input) => ({ input, source: certainSource(input) }))
          .find((entry) => entry.source !== null);

        if (certain?.source) {
          found.push({
            module: target.name,
            input: certain.input,
            kind: "wirable",
            sources: [certain.source],
          });
          continue;
        }

        /**
         * Pass-throughs are *not* excluded here, unlike in `candidatesFor`.
         *
         * The VPC module takes `public_subnets` as a list of CIDR blocks and
         * returns `public_subnets` as a list of subnet ids — the same name for two
         * different values — so the asymmetry that identifies an echo elsewhere
         * would here discard the only real answer. And these are offered for a
         * decision rather than applied, where dropping a candidate costs more than
         * listing one too many.
         */
        const sources = producers.flatMap((producer) =>
          producer.outputs
            .filter((output) =>
              inputs.some((input) => answersNetworkInput(input, output.name)),
            )
            .map((output) => `${producer.name}.${output.name}`),
        );
        // Silent when there is no network to attach to: a project without a VPC
        // module is not a project that forgot to wire one.
        if (sources.length === 0) continue;

        found.push({
          module: target.name,
          input: [...inputs].sort().join(" or "),
          kind: "network",
          sources: sources.slice(0, MAX_SUGGESTED_SOURCES),
        });
      }
    }

    return found;
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
        severity: "blocking",
        message: `${gap.node}.${gap.input}${gap.type ? ` (${gap.type})` : ""} is required and unset${
          from.length ? `; could come from ${from.join(" or ")}` : ""
        }.`,
      });
    }

    // The finding `computeGaps` structurally cannot make; see `unwiredInputs`.
    for (const unwired of this.unwiredInputs()) {
      problems.push({
        kind: "unwired-input",
        severity: "incomplete",
        message:
          unwired.kind === "wirable"
            ? `${unwired.module}.${unwired.input} is unset and ${unwired.sources[0]} fits it by name. Wire it, or say why it should stay empty.`
            : `${unwired.module}.${unwired.input} is unset, so ${unwired.module} is not attached to any network. Candidates: ${unwired.sources.join(", ")} — the names do not match closely enough to pick one, so choose or ask.`,
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
            severity: "blocking",
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
            severity: "blocking",
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
        severity: "advisory",
        message: `local.${name} is not read anywhere. Wire it into an input or remove it.`,
      });
    }

    return problems.sort(
      (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
    );
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
          severity: "blocking",
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
          severity: "blocking",
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
        severity: "blocking",
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
