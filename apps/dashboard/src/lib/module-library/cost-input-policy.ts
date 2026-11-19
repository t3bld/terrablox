import { categoricalCostOptions } from "@/lib/module-library/cost-driver-controls";
import type { ModuleVariableDto } from "@/lib/module-library/types";

/**
 * Which module inputs a cost calculation may expose, shared by the calculator
 * UI and the pricing route so neither can offer what the other refuses.
 *
 * Only three control kinds exist: a boolean, a choice from a known list, and a
 * number with a default to slide from. Free text is never offered — a value
 * the user has to invent is a value they can get wrong, and none of them moves
 * a price that a curated choice could not.
 */

export type CostInputControl =
  | { kind: "boolean"; defaultValue: boolean | null }
  | {
      kind: "choice";
      defaultValue: string | null;
      options: ReadonlyArray<{ value: string; label: string }>;
    }
  | {
      kind: "number";
      defaultValue: number;
      min: number;
      max: number;
      step: number;
    };

/** Placeholder for identity inputs; it never reaches a real AWS account. */
export const COST_PLACEHOLDER = "terrablox-cost-estimate";

/** Inputs that only switch the module itself on or off, or carry no meaning. */
const IGNORED_INPUTS = new Set(["create", "putin_khuylo", "region"]);

const IDENTITY_NAMES = new Set([
  "name",
  "name_prefix",
  "description",
  "identifier",
  "identifier_prefix",
  "alias",
  "bucket",
  "bucket_prefix",
  "tags",
  "title",
  "comment",
]);

/**
 * Names, descriptions, tags and references to other resources.
 *
 * None of them changes a price. They are also exactly the inputs a module
 * feeds into `coalesce(var.name, var.name_prefix)` and friends, which is why
 * the server fills them instead of leaving them null.
 */
export function isIdentityInput(name: string): boolean {
  const lower = name.toLowerCase();
  if (IDENTITY_NAMES.has(lower)) return true;
  return /(?:^|_)(?:name|names|prefix|suffix|description|tags|tag|alias|identifier|title|comment|email|id|ids|arn|arns|region)$/.test(
    lower,
  );
}

function rootType(variable: ModuleVariableDto): string {
  return variable.type?.trim().toLowerCase() ?? "any";
}

function defaultOf(variable: ModuleVariableDto): unknown {
  return Object.hasOwn(variable, "default") ? variable.default : undefined;
}

/** The bounds a number slider uses, from the variable's name and default. */
export function costNumberBounds(name: string, value: number) {
  const lower = name.toLowerCase();
  const max = /request|invocation|transition/.test(lower)
    ? 10_000_000
    : /iops/.test(lower)
      ? 100_000
      : /storage|volume|memory|throughput|capacity|size/.test(lower)
        ? 10_000
        : Math.max(100, Math.ceil(value * 4));
  const step = max >= 1_000_000 ? 10_000 : max >= 10_000 ? 100 : 1;
  return { min: 0, max: Math.max(max, value), step };
}

/** The control for an input, or null when the input is not offered at all. */
export function costInputControl(
  variable: ModuleVariableDto,
): CostInputControl | null {
  if (variable.sensitive) return null;
  if (IGNORED_INPUTS.has(variable.name)) return null;
  if (isIdentityInput(variable.name)) return null;

  const type = rootType(variable);
  const value = defaultOf(variable);

  if (type.startsWith("bool")) {
    return {
      kind: "boolean",
      defaultValue: typeof value === "boolean" ? value : null,
    };
  }

  if (type.startsWith("string")) {
    const known = categoricalCostOptions(variable.name);
    if (!known) return null;
    const current = typeof value === "string" ? value : null;
    // A default outside the curated list is still a valid answer, and leaving
    // it out would make the picker unable to show what is configured.
    const options =
      current && !known.some((option) => option.value === current)
        ? [{ value: current, label: current }, ...known]
        : known;
    return { kind: "choice", defaultValue: current, options };
  }

  // Without a default there is nothing sensible to slide from.
  if (type.startsWith("number") && typeof value === "number") {
    return {
      kind: "number",
      defaultValue: value,
      ...costNumberBounds(variable.name, value),
    };
  }

  return null;
}

/**
 * The resource's own name. Empty, these are what `coalesce(var.name, …)` reads,
 * and filling them changes nothing but the label.
 */
const PRIMARY_NAMES = new Set([
  "name",
  "identifier",
  "bucket",
  "function_name",
  "cluster_name",
  "repository_name",
  "service_name",
]);

/**
 * Values the server supplies itself so the module evaluates.
 *
 * An empty name makes `coalesce(var.name, var.name_prefix)` fail before any
 * price is read, so the resource's own name is always filled. Every other
 * identity input is filled only when the module requires it: an optional ID or
 * ARN is a switch in disguise — `snapshot_identifier` restores from a snapshot,
 * `kms_key_arn` skips creating a key — and setting one would price a different
 * deployment from the default.
 */
export function identityPlaceholders(
  variables: ModuleVariableDto[],
): Record<string, string | string[]> {
  const names = new Set(variables.map((variable) => variable.name));
  const filled: Record<string, string | string[]> = {};

  for (const variable of variables) {
    if (variable.sensitive || !isIdentityInput(variable.name)) continue;
    if (variable.name.endsWith("region")) continue;

    const value = defaultOf(variable);
    const empty = value === undefined || value === null || value === "";
    const type = rootType(variable);
    // Only when there is no `name` to fill instead: setting both conflicts.
    const soleNamePrefix =
      variable.name === "name_prefix" && !names.has("name");
    const fill =
      variable.required ||
      (empty && (PRIMARY_NAMES.has(variable.name) || soleNamePrefix));
    if (!fill) continue;

    if (type.startsWith("string")) {
      filled[variable.name] = COST_PLACEHOLDER;
    } else if (
      variable.required &&
      (type.startsWith("list(string") || type.startsWith("set(string"))
    ) {
      filled[variable.name] = [COST_PLACEHOLDER];
    }
  }
  return filled;
}

/**
 * Required inputs neither a control nor a placeholder can provide.
 *
 * A module with any of these cannot be priced honestly, so the calculator says
 * so instead of asking the user to type a value.
 */
export function unpriceableRequiredInputs(
  variables: ModuleVariableDto[],
): string[] {
  const placeholders = identityPlaceholders(variables);
  return variables
    .filter((variable) => variable.required)
    .filter((variable) => !(variable.name in placeholders))
    .filter((variable) => variable.name !== "region")
    .filter((variable) => costInputControl(variable) === null)
    .map((variable) => variable.name);
}
