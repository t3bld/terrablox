/**
 * Whether a literal value could possibly satisfy a declared Terraform type.
 *
 * The narrow question on purpose. Terraform's own type checker runs at plan time
 * with the whole configuration in hand, and anything approaching it here would be
 * a second implementation of a language we do not own. What this catches is the
 * one class of mistake worth catching before a commit: a value whose *shape* is
 * wrong, written by something that could not see the declared type.
 *
 *   var.subnet_ids  list(string)   set to  "subnet-abc"     wrong, and obvious
 *   var.enabled     bool           set to  "yes"            wrong, and obvious
 *   var.port        number         set to  "http"           wrong, and obvious
 *
 * Everything else returns null. An expression that references anything —
 * `module.vpc.private_subnets`, `local.ports`, `var.env`, a function call, an
 * interpolation — has a type that depends on what it points at, and guessing
 * would refuse valid edits. Refusing a correct value is worse than accepting a
 * wrong one here: the wrong one fails loudly at plan time, while a refusal costs
 * a turn its ability to make the edit at all.
 */

/** The base of a type expression: `list(string)` → `list`, `string` → `string`. */
function baseType(type: string): string | null {
  const match = /^([a-z]+)/.exec(type.trim().toLowerCase());
  return match?.[1] ?? null;
}

type ValueShape = "string" | "number" | "bool" | "list" | "object" | "unknown";

/**
 * What a value literally is, or `unknown` when it depends on something else.
 *
 * `unknown` is the answer for every expression, and it is the answer that keeps
 * this safe: the check only ever fires on values that stand entirely on their own.
 */
function shapeOf(value: string): ValueShape {
  const raw = value.trim();
  if (raw === "") return "unknown";

  // A heredoc is a string, and its body may contain anything.
  if (/^<<-?[A-Za-z_]/.test(raw)) return "string";

  if (raw.startsWith("[")) return "list";
  if (raw.startsWith("{")) return "object";

  if (raw === "true" || raw === "false") return "bool";
  if (/^-?\d+(\.\d+)?$/.test(raw)) return "number";

  if (/^"(?:[^"\\]|\\.)*"$/.test(raw)) {
    // An interpolated string is still a string, but its content is not known, so
    // "the quotes contain something numeric" cannot be decided.
    return raw.includes("${") ? "unknown" : "string";
  }

  return "unknown";
}

/** The text inside a plain quoted string, or null when it is not one. */
function stringContent(value: string): string | null {
  const raw = value.trim();
  if (!/^"(?:[^"\\]|\\.)*"$/.test(raw) || raw.includes("${")) return null;
  return raw.slice(1, -1);
}

/**
 * A sentence naming the mismatch, or null when there is nothing to say.
 *
 * Phrased as an instruction rather than an error code, because the reader is a
 * model deciding what to do next and "expected list(string), got string" leaves
 * it guessing at the fix.
 */
export function checkValueAgainstType(
  type: string | null | undefined,
  value: string,
): string | null {
  const declared = type?.trim();
  if (!declared) return null;

  const base = baseType(declared);
  if (!base) return null;

  const shape = shapeOf(value);
  if (shape === "unknown") return null;

  switch (base) {
    case "list":
    case "set":
    case "tuple":
      return shape === "list"
        ? null
        : `is declared \`${declared}\`, so its value has to be a collection — write \`[${value.trim()}]\` if you meant a single element.`;

    case "map":
    case "object":
      return shape === "object"
        ? null
        : `is declared \`${declared}\`, so its value has to be an object, e.g. \`{ key = "value" }\`.`;

    case "bool": {
      if (shape === "bool") return null;
      const text = stringContent(value);
      if (text !== null && (text === "true" || text === "false")) {
        return `is declared \`bool\`, so write \`${text}\` unquoted rather than as a string.`;
      }
      return "is declared `bool`, so its value has to be `true` or `false`.";
    }

    case "number": {
      if (shape === "number") return null;
      const text = stringContent(value);
      if (text !== null && /^-?\d+(\.\d+)?$/.test(text)) {
        // Terraform converts this one silently, so it is not worth a refusal —
        // but saying so is cheap and the next value is more likely to be right.
        return null;
      }
      return "is declared `number`, so its value has to be numeric.";
    }

    case "string":
      return shape === "list" || shape === "object"
        ? `is declared \`string\`, so its value cannot be a ${shape === "list" ? "list" : "object"}.`
        : null;

    // `any`, and anything the parser does not recognise, constrains nothing.
    default:
      return null;
  }
}
