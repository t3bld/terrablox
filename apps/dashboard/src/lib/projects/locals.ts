/**
 * What a Terraform local is, from the UI's point of view.
 *
 * A local is not a peer of a module: a module is a thing that exists in an
 * account, a local is a value that feeds one. That is why locals are not drawn on
 * the canvas. Giving a value the same weight as a piece of infrastructure made a
 * six-module project look like a twenty-node system, and the wire from a value to
 * an input carries no information the input itself could not show.
 *
 * They live instead at the point of use: every module input offers the values and
 * outputs that could fill it, and a new value is created from the input that
 * needs it.
 *
 * Free of `server-only` so the picker, the route and the graph builder share one
 * definition of what a valid name is and how a value is classified.
 */

/**
 * Terraform identifiers: a letter or underscore, then letters, digits,
 * underscores and dashes. A dash is legal but has to be written `local["a-b"]`
 * to be read back, so it is rejected here rather than producing a reference the
 * canvas cannot render.
 */
export const LOCAL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidLocalName(value: string): boolean {
  return LOCAL_NAME_PATTERN.test(value.trim());
}

/**
 * Turns whatever the user typed into a usable local name.
 *
 * Used when a local is created from a module input, where the name comes from
 * the input it will feed and is already almost always valid.
 */
export function toLocalName(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^[^a-z_]+/, "")
      .replace(/_+$/, "") || "value"
  );
}

/** How a local is referenced from anywhere else in the configuration. */
export function localReference(name: string): string {
  return `local.${name}`;
}

/**
 * Selection key for a local.
 *
 * Namespaced because a module and a local may legally share a name — `module
 * "environment"` next to `local.environment` is unusual but valid — and a shared
 * key would open the wrong inspector. A module label cannot contain a dot, so
 * this can never collide with one.
 */
export function localNodeId(name: string): string {
  return `local.${name}`;
}

/**
 * The selection identity of a graph node.
 *
 * One place, because the canvas, the variables list and the inspector all have to
 * agree on it — and a mismatch shows up as an item that cannot be selected rather
 * than as an error.
 */
export function canvasNodeId(node: {
  id: string;
  kind: "module" | "local";
}): string {
  return node.kind === "local" ? localNodeId(node.id) : node.id;
}

/** The names a `local.<name>` expression reads, for drawing wires. */
export function localsReferencedIn(expression: string): string[] {
  const names = new Set<string>();
  for (const match of expression.matchAll(
    /\blocal\.([A-Za-z_][A-Za-z0-9_]*)/g,
  )) {
    if (match[1]) names.add(match[1]);
  }
  return [...names];
}

/**
 * What kind of value a local holds, as far as its text reveals.
 *
 * Shown as a badge on the node. Deliberately shallow: this is a reading aid, not
 * type inference — Terraform resolves the real type, and claiming more than the
 * text supports would be worse than saying "expression".
 */
export type LocalValueKind =
  | "string"
  | "number"
  | "bool"
  | "list"
  | "map"
  | "reference"
  | "expression"
  | "empty";

export function localValueKind(expression: string | null): LocalValueKind {
  const value = (expression ?? "").trim();
  if (value === "") return "empty";

  // A quoted string with no interpolation is a plain string; one with `${…}` is
  // an expression that happens to produce a string.
  if (/^"(?:[^"\\]|\\.)*"$/.test(value)) {
    return value.includes("${") ? "expression" : "string";
  }

  if (/^-?\d+(\.\d+)?$/.test(value)) return "number";
  if (value === "true" || value === "false") return "bool";
  if (value.startsWith("[")) return "list";
  if (value.startsWith("{")) return "map";

  // A bare reference chain, e.g. `module.vpc.id` or `var.environment`.
  if (/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_-]*)+$/.test(value)) {
    return "reference";
  }

  return "expression";
}

/**
 * The types offered when a variable is created.
 *
 * Terraform infers a local's type from its value — `locals` blocks carry no type
 * declaration — so this is not stored anywhere. It exists because the same text
 * means different things depending on the intended type: `10.0.0.0/16` is a
 * string that has to be quoted, `8080` is a number that must not be, and getting
 * that wrong surfaces as a plan error rather than as a mistake in the form.
 *
 * On the way back, {@link localValueKind} infers the type from the value, so a
 * variable reopened later still reads correctly without anything persisting it.
 */
export type LocalValueType =
  | "string"
  | "number"
  | "bool"
  | "list"
  | "map"
  | "expression";

export const LOCAL_VALUE_TYPES: Array<{
  value: LocalValueType;
  label: string;
  hint: string;
}> = [
  { value: "string", label: "string", hint: "production" },
  { value: "number", label: "number", hint: "8080" },
  { value: "bool", label: "bool", hint: "true" },
  { value: "list", label: "list(string)", hint: "a, b, c" },
  { value: "map", label: "map(string)", hint: "key = value, other = 2" },
  {
    value: "expression",
    label: "expression",
    hint: "module.vpc.id or var.env",
  },
];

/** Wraps a string in quotes, escaping what HCL requires escaping. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The HCL for a value the user typed, given the type they picked.
 *
 * Deliberately forgiving about input that is already in HCL form: someone typing
 * `"production"` into a string field means the same thing as `production`, and
 * quoting it twice would be a surprise rather than a correction.
 */
export function formatLocalValue(type: LocalValueType, input: string): string {
  const raw = input.trim();
  if (raw === "") return raw;

  switch (type) {
    case "string":
      // Already a complete quoted string, or an interpolation the user wants
      // evaluated — either way it is HCL already.
      return /^"(?:[^"\\]|\\.)*"$/.test(raw) ? raw : quote(raw);

    case "number":
      return raw;

    case "bool":
      return raw === "true" || raw === "false" ? raw : "false";

    case "list": {
      if (raw.startsWith("[")) return raw;
      const items = raw
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "");
      // Numbers stay bare so a list of ports is a list of numbers.
      return `[${items
        .map((entry) => (/^-?\d+(\.\d+)?$/.test(entry) ? entry : quote(entry)))
        .join(", ")}]`;
    }

    case "map": {
      if (raw.startsWith("{")) return raw;
      const pairs = raw
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "")
        .map((entry) => {
          const at = entry.indexOf("=");
          if (at === -1) return null;
          const key = entry.slice(0, at).trim();
          const value = entry.slice(at + 1).trim();
          if (!key) return null;
          const rendered = /^-?\d+(\.\d+)?$/.test(value)
            ? value
            : value === "true" || value === "false"
              ? value
              : quote(value);
          return `${key} = ${rendered}`;
        })
        .filter((entry): entry is string => entry !== null);

      return pairs.length ? `{ ${pairs.join(", ")} }` : "{}";
    }

    case "expression":
      return raw;
  }
}

/** The type a stored value reads as, for showing an existing variable. */
export function localValueTypeOf(expression: string | null): LocalValueType {
  const kind = localValueKind(expression);

  switch (kind) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "bool":
      return "bool";
    case "list":
      return "list";
    case "map":
      return "map";
    default:
      return "expression";
  }
}

/** A value short enough to read on a node, with the rest elided. */
export function summariseLocalValue(
  expression: string | null,
  max = 48,
): string {
  const value = (expression ?? "").trim().replace(/\s+/g, " ");
  if (value === "") return "not set";
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
