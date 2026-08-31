import {
  CONTAINMENT_ATTRIBUTES,
  VPC_SCOPED_ATTRIBUTES,
} from "@/lib/terraform/aws-architecture";

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

/**
 * Whether an output is really a source, or just this module echoing its own input.
 *
 * Half of the upstream modules expose an output named after an input they take:
 * the security-group module accepts `vpc_id` and returns `vpc_id`, the ECS service
 * accepts `task_exec_iam_role_name` and returns it. By name those are perfect
 * matches, and following them wires a module to a peer that is passing the value
 * along rather than producing it — `alb.vpc_id = module.sg_alb.vpc_id` instead of
 * the VPC, and a pair of ECS modules feeding each other's IAM role names.
 *
 * A module that creates the thing does not take it as an argument. That asymmetry
 * is the signal, and it is a fact about the module rather than a guess about
 * intent.
 */
export function isPassThroughOutput(
  output: string,
  producerInputs: ReadonlyArray<{ name: string }>,
): boolean {
  const name = normalize(output);
  return producerInputs.some((input) => normalize(input.name) === name);
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
 * Whether an input this module leaves unset may be filled from the canvas at all.
 *
 * `required` selects almost nothing — 324 of 372 imported modules declare no
 * required variable, because the upstream convention gives every one a default, so
 * a rule that only looked at `required` never fired and never reported anything.
 * The network vocabulary is what carries it instead: those are the inputs whose
 * absence leaves a module unattached rather than merely unconfigured.
 *
 * Nothing broader. Relaxing this to "any compound name" was tried against the real
 * projects and reported an ECS cluster and an ECS service as sources for each
 * other's IAM roles, a load balancer as taking its `name` from the VPC, and
 * ElastiCache as the place a VPC gets its subnet group name. Every one of those is
 * a genuine name match and none of them is a wire.
 *
 * Both gates in one place, because the auto-wiring path and the reporting path
 * have to agree about which inputs are in scope or the review would name inputs
 * the tools decline to fill.
 */
export function isWirableInput(input: {
  name: string;
  /** Absent on the canvas DTO, where a missing default is the same as false. */
  required?: boolean;
}): boolean {
  return input.required === true || networkRelationOf(input.name) !== null;
}

/**
 * What kind of network object an input asks for, when its name says so.
 *
 * Read from the architecture diagram's own vocabulary — the table that decides
 * what "this thing is inside that thing" means when the diagram nests one box in
 * another. Sharing it is the point: an input that would have placed a module
 * inside a VPC on the diagram is exactly an input whose absence leaves the module
 * outside of it in reality.
 *
 * Needed because the naming convention misses precisely these. `subnets` and
 * `private_subnets` score zero against each other, so an ALB wired to nothing
 * looks identical to an ALB that needs nothing — and that is the omission that
 * shipped a stack with every service sitting beside its VPC instead of in it.
 */
export function networkRelationOf(input: string): "vpc" | "subnet" | null {
  return CONTAINMENT_ATTRIBUTES[normalize(input)] ?? null;
}

/**
 * Whether an input carries a security group, and so settles which VPC a module is
 * in without saying anything about its subnets.
 *
 * From the same table the architecture diagram uses to place a database inside its
 * VPC when nothing else says where it lives. A module wired through
 * `security_group_ids` is attached to a network, and telling its author otherwise
 * is how a review loses their trust.
 */
export function isVpcScopedAttribute(input: string): boolean {
  return VPC_SCOPED_ATTRIBUTES.has(normalize(input));
}

/**
 * What kind of value a network name carries, on either side of a wire.
 *
 * Applied to inputs and outputs alike, and matching shapes is what keeps the
 * suggestions usable. `subnets` asked against relation alone drew twenty
 * candidates — every subnet-ish output the VPC module has, including ARNs and
 * subnet-group ids, neither of which a `subnets` input accepts. A list of twenty
 * is not a choice, it is noise.
 */
export type NetworkShape =
  | "vpc-id"
  | "subnet-ids"
  | "subnet-arns"
  | "subnet-group"
  | "subnet-group-name";

export function networkShapeOf(name: string): NetworkShape | null {
  const value = normalize(name);

  if (/(^|_)vpc_id$/.test(value)) return "vpc-id";
  if (/(^|_)subnet_group_name$/.test(value)) return "subnet-group-name";
  if (/(^|_)subnet_group$/.test(value)) return "subnet-group";
  if (/(^|_)subnet_arns$/.test(value)) return "subnet-arns";
  if (/(^|_)subnets$/.test(value) || /(^|_)subnet_ids$/.test(value))
    return "subnet-ids";

  return null;
}

/**
 * Whether an output could answer a network input at all.
 *
 * Deliberately not fed into {@link wiringScore}: this is good enough to say "here
 * is what the network on this canvas offers", and nowhere near good enough to pick
 * one unasked. `public_subnets`, `private_subnets` and `database_subnets` are all
 * valid answers to `subnets`, and which one belongs there is the whole question.
 */
export function answersNetworkInput(input: string, output: string): boolean {
  const shape = networkShapeOf(input);
  return shape !== null && networkShapeOf(output) === shape;
}

/**
 * Whether a module *supplies* the kind of value this input asks for.
 *
 * A module that hands out subnet group names is not a module looking for one: the
 * VPC module takes `elasticache_subnet_group_name` as a name to give the group it
 * creates, and reading that as "the VPC is attached to no network" was exactly as
 * useful as it sounds.
 */
export function providesNetworkShape(
  outputs: ReadonlyArray<{ name: string }>,
  input: string,
): boolean {
  const shape = networkShapeOf(input);
  if (!shape) return false;

  return outputs.some((output) => networkShapeOf(output.name) === shape);
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
