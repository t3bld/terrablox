/**
 * The type of a module output, worked out from its value expression.
 *
 * Terraform declares types for inputs and not for outputs, so there is nothing to
 * read: an output's type is whatever its expression evaluates to, and evaluating
 * it properly needs a plan against real state. What is left is inference from the
 * shape of the expression, in three tiers of confidence:
 *
 *   1. Proven. A list literal is a list; a splat produces a list; `tostring()`
 *      returns a string. The expression says so.
 *   2. Exact by lookup. `value = var.subnet_ids` has the type the module declared
 *      for that variable — not a guess at all, just a second place to look.
 *   3. Conventional. `aws_subnet.this.arn` is a string because every `*_arn`
 *      attribute in the AWS provider is. True in practice, not by construction.
 *
 * Tier 3 is the reason the badge says "inferred" and carries the expression it
 * came from: a reader who doubts it can see the evidence without leaving the row.
 * Without it this answered 7% of the catalogue's outputs, which is not an answer.
 *
 * Anything still unrecognised returns null and renders nothing. A blank is a
 * better answer than a confident wrong one sitting next to the declared types of
 * the inputs, where a reader has no way to tell the two apart.
 */

/** Matches a splat, `[*]`, which always produces a list. */
const SPLAT = /\[\s*\*\s*\]/;

/** Interpolation markers left in a string by hcl2json. */
const INTERPOLATION = /\$\{/;

/** Functions whose return type does not depend on their arguments. */
const FUNCTION_RETURNS: Record<string, string> = {
  abs: "number",
  base64encode: "string",
  bool: "bool",
  can: "bool",
  ceil: "number",
  compact: "list(string)",
  concat: "list",
  contains: "bool",
  distinct: "list",
  flatten: "list",
  floor: "number",
  format: "string",
  formatlist: "list(string)",
  join: "string",
  jsonencode: "string",
  keys: "list(string)",
  length: "number",
  lower: "string",
  merge: "object",
  replace: "string",
  sha256: "string",
  sort: "list(string)",
  split: "list(string)",
  substr: "string",
  title: "string",
  tobool: "bool",
  tolist: "list",
  tomap: "map",
  tonumber: "number",
  toset: "set",
  tostring: "string",
  trimspace: "string",
  upper: "string",
  uuid: "string",
  values: "list",
  yamlencode: "string",
  zipmap: "map",
};

/**
 * Functions that hand back one of their arguments unchanged, so the type is the
 * type of that argument.
 */
const PASSTHROUGH_FUNCTIONS = new Set([
  "try",
  "coalesce",
  "one",
  "element",
  "lookup",
  "sensitive",
  "nonsensitive",
]);

/**
 * Attribute naming conventions in the AWS provider.
 *
 * Suffixes rather than a list of attribute names: `*_arn` is a string on every
 * resource that has one, and a table of the several hundred individual names would
 * be both huge and less complete.
 */
const ATTRIBUTE_SUFFIXES: ReadonlyArray<[RegExp, string]> = [
  [/(^|_)arns$/, "list(string)"],
  [/(^|_)ids$/, "list(string)"],
  [/(^|_)names$/, "list(string)"],
  [/(^|_)arn$/, "string"],
  [/(^|_)id$/, "string"],
  [/(^|_)name$/, "string"],
  [/(^|_)count$/, "number"],
  [/(^|_)port$/, "number"],
  [/(^|_)enabled$/, "bool"],
  [/^tags(_all)?$/, "map(string)"],
  [
    /(^|_)(endpoint|address|url|uri|hostname|dns_name|domain|domain_name|region|status|state|version|policy|json|cidr_block|availability_zone)$/,
    "string",
  ],
];

/** Splits a function call into its name and the text inside the parentheses. */
function parseCall(expression: string): { name: string; args: string } | null {
  const match = /^([a-z_][a-z0-9_]*)\s*\(([\s\S]*)\)$/i.exec(expression);
  if (!match?.[1] || match[2] === undefined) return null;

  return { name: match[1].toLowerCase(), args: match[2] };
}

/**
 * The first argument of an argument list, respecting nesting.
 *
 * A plain `split(",")` on the arguments would cut `try(merge(a, b), c)` in the
 * wrong place and infer from half an expression.
 */
function firstArgument(args: string): string | null {
  let depth = 0;
  let quote: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const char = args[i];

    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") depth--;
    else if (char === "," && depth === 0) return args.slice(0, i).trim();
  }

  return args.trim() || null;
}

/** The branch of `condition ? a : b` that decides the type — both must match. */
function firstBranch(expression: string): string | null {
  let depth = 0;
  let quote: string | null = null;

  for (let i = 0; i < expression.length; i++) {
    const char = expression[i];

    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") depth--;
    else if (char === "?" && depth === 0) {
      const rest = expression.slice(i + 1);
      const colon = rest.indexOf(":");
      const branch = colon === -1 ? rest : rest.slice(0, colon);
      return branch.trim() || null;
    }
  }

  return null;
}

/** The last dotted segment of a reference, ignoring any index or splat. */
function lastAttribute(expression: string): string | null {
  const withoutIndex = expression.replace(/\[[^\]]*\]/g, "");
  if (!/^[a-z_][a-z0-9_.]*$/i.test(withoutIndex)) return null;

  const segments = withoutIndex.split(".").filter(Boolean);
  // Needs at least `type.name.attribute`; `aws_vpc.this` on its own is an object.
  return segments.length >= 3 ? (segments.at(-1) ?? null) : null;
}

export interface OutputTypeContext {
  /** Declared input types by variable name, for `value = var.x`. */
  variableTypes?: Readonly<Record<string, string | null>>;
}

export function inferOutputType(
  expression: string | null,
  context: OutputTypeContext = {},
): string | null {
  const raw = expression?.trim();
  if (!raw) return null;

  // Structural literals first: hcl2json hands these over as real JSON, so the
  // shape is not a guess. A `[for …]` comprehension lands here too, and it is
  // still a list.
  if (raw.startsWith("[")) return "list";
  if (raw.startsWith("{")) return "object";

  if (raw === "true" || raw === "false") return "bool";
  if (/^-?\d+(\.\d+)?$/.test(raw)) return "number";

  // A quoted literal that survived as a quoted literal, and string
  // concatenation, which can only produce a string. A bare `${…}` was already
  // unwrapped by the analyzer, so a remaining marker means text beside it.
  if (/^"(?:[^"\\]|\\.)*"$/.test(raw)) return "string";
  if (INTERPOLATION.test(raw)) return "string";

  // Exact: the module already declared this type on the input.
  const variable = /^var\.([a-z_][a-z0-9_]*)$/i.exec(raw);
  if (variable?.[1]) {
    const declared = context.variableTypes?.[variable[1]];
    if (declared) return declared;
  }

  const call = parseCall(raw);
  if (call) {
    const known = FUNCTION_RETURNS[call.name];
    if (known) return known;

    if (PASSTHROUGH_FUNCTIONS.has(call.name)) {
      const first = firstArgument(call.args);
      // `one()` takes a list and returns a single element, so the argument's type
      // is not the answer — only its element type would be, which we do not track.
      if (first && call.name !== "one") {
        return inferOutputType(first, context);
      }
    }

    return null;
  }

  // A splat anywhere yields a list. Checked after calls so `join(x[*].id, ",")`
  // is still a string.
  if (SPLAT.test(raw)) {
    const attribute = lastAttribute(raw);
    const element = attribute ? attributeType(attribute) : null;
    return element && !element.startsWith("list") ? `list(${element})` : "list";
  }

  const branch = firstBranch(raw);
  if (branch) return inferOutputType(branch, context);

  const attribute = lastAttribute(raw);
  return attribute ? attributeType(attribute) : null;
}

function attributeType(attribute: string): string | null {
  for (const [pattern, type] of ATTRIBUTE_SUFFIXES) {
    if (pattern.test(attribute)) return type;
  }
  return null;
}
