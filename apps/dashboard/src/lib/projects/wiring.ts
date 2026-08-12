/**
 * Deciding which output belongs in which input.
 *
 * Terraform has no type system that would answer this — every id is a string —
 * so the only signal available is the naming convention modules already follow:
 * a module that produces a VPC calls its output `vpc_id`, and a module that
 * needs one calls its variable `vpc_id` too.
 *
 * The rules below are therefore deliberately narrow. Guessing wrong here writes
 * a wrong value into the user's infrastructure code, which is far worse than
 * leaving an input empty and letting them draw the wire themselves.
 */

/** Exact name match: `vpc_id` into `vpc_id`. */
const SCORE_EXACT = 3;
/** The producer's name supplies the prefix: `vpc` + `id` into `vpc_id`. */
const SCORE_PREFIXED = 2;

export const MIN_WIRING_SCORE = SCORE_PREFIXED;

/**
 * How well an output fits an input. Zero means "no evidence", and no amount of
 * partial overlap is allowed to add up to a match.
 */
export function wiringScore(
  input: string,
  output: string,
  producer: string,
): number {
  const wanted = normalize(input);
  const provided = normalize(output);
  if (wanted === provided) return SCORE_EXACT;

  const prefix = normalize(producer);
  if (prefix && `${prefix}_${provided}` === wanted) return SCORE_PREFIXED;

  return 0;
}

/** Block labels carry the noise: `vpc_main`, `this`, numbering from a copy. */
function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/-/g, "_");
}

export interface WiringSource {
  /** Block label on the canvas, or the library module's name. */
  producer: string;
  output: string;
  score: number;
}

/**
 * The single best source for an input, or null when there is more than one.
 *
 * Ambiguity is treated as failure on purpose: two modules that both expose a
 * `vpc_id` are exactly the case where the user has to say which one they meant,
 * and picking either would look like the tool understood the intent.
 */
export function unambiguousSource<T extends WiringSource>(
  candidates: T[],
): T | null {
  const scored = candidates.filter((c) => c.score >= MIN_WIRING_SCORE);
  if (scored.length === 0) return null;

  const best = Math.max(...scored.map((c) => c.score));
  const winners = scored.filter((c) => c.score === best);

  return winners.length === 1 ? (winners[0] as T) : null;
}

/**
 * Turns what a user typed into a valid HCL right-hand side.
 *
 * The inspector offers one text field for both `t3.micro` and
 * `module.vpc.private_subnets`, because demanding that people quote their own
 * strings is how a configuration editor earns its reputation. Anything that
 * already reads as an expression is passed through untouched.
 */
export function coerceHclValue(input: string): string {
  const value = input.trim();
  if (value === "") return '""';

  const isExpression =
    /^["'[{(]/.test(value) ||
    /^-?\d+(\.\d+)?$/.test(value) ||
    value === "true" ||
    value === "false" ||
    value === "null" ||
    /^(var|local|module|data|each|count|path|terraform)\./.test(value) ||
    // A function call or an interpolation: `merge(...)`, `"${...}"`.
    /^[a-z_][a-z0-9_]*\s*\(/i.test(value);

  if (isExpression) return value;

  return JSON.stringify(value);
}
