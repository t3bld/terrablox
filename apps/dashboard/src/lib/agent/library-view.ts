/**
 * The module library as the agent needs to see it.
 *
 * The library used to reach a turn as `{ id, name, versionTag }`. That is enough
 * to *place* a module and not nearly enough to choose one or wire one: the agent
 * could call `add_module`, and then had to guess the output names to connect it
 * by. All of it was already loaded — `readModuleLibrary` returns the variables and
 * outputs JSON — and thrown away one line before the prompt.
 *
 * Two shapes come out of here, and the split is the whole design:
 *
 *   {@link summariseLibraryModule}  one line per module, for the prompt. What the
 *                                   module is, in enough words to pick from.
 *   {@link AgentLibraryModule}      every port, in memory, never rendered whole.
 *                                   Read by `describe_module` for the two or three
 *                                   modules a turn actually cares about, and by
 *                                   the validation that refuses a wrong port name.
 *
 * Putting every port of every module in the prompt would be the obvious version
 * and the wrong one: a catalogue of a hundred modules is tens of thousands of
 * tokens of ports, most of them for modules the turn will never touch, crowding
 * out the project the user is actually asking about.
 *
 * Free of `server-only`: pure mapping over rows somebody else read.
 */

import {
  type ModuleOutputDto,
  type ModuleVariableDto,
  parseOutputs,
  parseVariables,
} from "@/components/module-detail/types";
import { type LibraryModule, libraryModuleName } from "@/lib/projects/graph";
import {
  type CostClass,
  resolveCostDriver,
} from "@/lib/terraform/aws-cost-drivers";
import { inferOutputType } from "@/lib/terraform/output-type";

/** An input or an output, with everything needed to decide about it. */
export interface AgentPort {
  name: string;
  /**
   * Declared for an input, inferred for an output.
   *
   * Terraform declares no type on an output, so the value there comes from
   * {@link inferOutputType} and is a reading of the expression rather than a
   * promise. Worth having anyway: it is what turns "these two names match" into
   * "these two names match and both are `list(string)`".
   */
  type: string | null;
  required: boolean;
  description: string | null;
  /** The declared default, rendered compactly. Absent for outputs. */
  default?: string;
}

export interface AgentLibraryModule {
  /** Library id, which is what `add_module` takes. */
  id: string;
  name: string;
  versionTag: string | null;
  description: string | null;
  tags: string[];
  inputs: AgentPort[];
  outputs: AgentPort[];
}

/** How much of a description survives into a one-line summary. */
const SUMMARY_DESCRIPTION_CHARS = 140;

/**
 * How many ports `describe_module` will report.
 *
 * The upstream AWS VPC module declares over three hundred variables. Reading all
 * of them costs a turn most of its context for a module it may then decide not to
 * use, and the ones past the first few dozen are edge-case toggles. Required
 * inputs are sorted to the front, so what the cap drops is always the optional
 * tail.
 */
export const DESCRIBE_PORT_LIMIT = 60;

export function toAgentLibrary(
  modules: readonly LibraryModule[],
): AgentLibraryModule[] {
  return modules
    .map((module) => ({
      id: module.id,
      name: libraryModuleName(module),
      versionTag: module.versionTag,
      description: module.description ?? null,
      tags: module.tags ?? [],
      inputs: toInputPorts(parseVariables(module.variables)),
      outputs: toOutputPorts(
        parseOutputs(module.outputs),
        parseVariables(module.variables),
      ),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Required first, then alphabetical.
 *
 * Not cosmetic. Every consumer here truncates, and the required inputs are the
 * ones that decide whether the configuration plans at all — so they have to be on
 * the side of the cut that survives.
 */
function toInputPorts(variables: ModuleVariableDto[]): AgentPort[] {
  return variables
    .map((variable) => ({
      name: variable.name,
      type: variable.type ?? null,
      required: variable.required ?? false,
      description: variable.description,
      ...(Object.hasOwn(variable, "default")
        ? { default: renderDefault(variable.default) }
        : {}),
    }))
    .sort(
      (a, b) =>
        Number(b.required) - Number(a.required) || a.name.localeCompare(b.name),
    );
}

function toOutputPorts(
  outputs: ModuleOutputDto[],
  variables: ModuleVariableDto[],
): AgentPort[] {
  const variableTypes = Object.fromEntries(
    variables.map((variable) => [variable.name, variable.type ?? null]),
  );

  return outputs
    .map((output) => ({
      name: output.name,
      type: inferOutputType(output.valueExpression ?? null, { variableTypes }),
      // An output is never "required": nothing has to read it.
      required: false,
      description: output.description,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A default as HCL-ish text, short enough to sit at the end of a line. */
function renderDefault(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  const json = JSON.stringify(value) ?? "";
  return json.length > 60 ? `${json.slice(0, 59)}…` : json;
}

/**
 * One module, on one line, for the prompt's library section.
 *
 * The id first because that is what `add_module` takes, then what the module is
 * for. Port counts rather than port names: they tell the agent whether the module
 * is worth a `describe_module` call without spending the tokens that call costs.
 */
export function summariseLibraryModule(module: AgentLibraryModule): string {
  const required = module.inputs.filter((input) => input.required).length;

  const parts = [
    `${module.name}${module.versionTag ? ` @${module.versionTag}` : ""}`,
    module.tags.length ? `[${module.tags.join(", ")}]` : null,
    describeShort(module.description),
    `${required} of ${module.inputs.length} inputs required, ${module.outputs.length} output${module.outputs.length === 1 ? "" : "s"}`,
  ].filter((part): part is string => part !== null && part !== "");

  return `- ${module.id}: ${parts.join(" — ")}`;
}

/** A description flattened to one line, cut on a word where it can be. */
function describeShort(description: string | null): string {
  const text = (description ?? "").trim().replace(/\s+/g, " ");
  if (!text) return "";
  if (text.length <= SUMMARY_DESCRIPTION_CHARS) return text;

  const cut = text.slice(0, SUMMARY_DESCRIPTION_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return `${lastSpace > 40 ? cut.slice(0, lastSpace) : cut}…`;
}

/** A port as one line of a `describe_module` answer. */
export function renderPort(port: AgentPort): string {
  const parts = [
    port.name,
    port.type ? `(${port.type})` : null,
    port.required ? "required" : null,
    port.default !== undefined ? `default ${port.default}` : null,
    describeShort(port.description),
  ].filter((part): part is string => part !== null && part !== "");

  return `- ${parts.join(" — ")}`;
}

export interface CostSummary {
  /** Resource types that bill from the moment they exist. */
  recurring: Array<{ resourceType: string; driver: string | null }>;
  /** Resource types that bill for what passes through them. */
  usage: Array<{ resourceType: string; driver: string | null }>;
  freeCount: number;
  /** Types no tier of the cost table recognises. */
  unclassified: string[];
}

/**
 * What a set of resource types does to a bill.
 *
 * The agent places modules, and a module is where the expensive decisions get
 * made — three NAT gateways for three availability zones is a real monthly charge
 * that no part of the prompt mentioned before this. Never an amount: the table it
 * reads is deliberately structural, because the numbers that decide a bill are
 * inputs supplied at deploy time.
 */
export function summariseCost(
  resources: ReadonlyArray<{ kind: string; resourceType: string }>,
): CostSummary {
  const summary: CostSummary = {
    recurring: [],
    usage: [],
    freeCount: 0,
    unclassified: [],
  };

  const seen = new Set<string>();

  for (const resource of resources) {
    // A data source reads; it never creates anything to be billed for.
    if (resource.kind !== "resource") continue;
    if (seen.has(resource.resourceType)) continue;
    seen.add(resource.resourceType);

    const driver = resolveCostDriver(resource.resourceType);
    if (!driver) {
      summary.unclassified.push(resource.resourceType);
      continue;
    }

    const entry = {
      resourceType: resource.resourceType,
      driver: driver.driver ?? null,
    };

    const bucket: Record<CostClass, () => void> = {
      recurring: () => summary.recurring.push(entry),
      usage: () => summary.usage.push(entry),
      free: () => {
        summary.freeCount += 1;
      },
    };

    bucket[driver.costClass]();
  }

  return summary;
}
