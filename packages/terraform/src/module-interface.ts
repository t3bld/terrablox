import { coerceHclValue } from "./hcl-edit";
import { closestName } from "./identifier-suggest";
import { checkValueAgainstType } from "./type-check";

/**
 * Checking a module call against the module's declared interface.
 *
 * This is the product's central claim — "every call is checked against the module's real
 * interface" — and it existed twice: once in the dashboard's graph projection, for the
 * agent's own edits, and once in the MCP server, for a stack proposed from an editor. Two
 * implementations of the one sentence the marketing page makes is the worst possible place
 * for drift, and they had already drifted: the projection type-checked the raw value while
 * the MCP server coerced it first, so a bare `production` against a `list(string)` input
 * was caught in one and not the other.
 *
 * Here rather than in a package of its own, which is a deliberate departure from the plan:
 * everything it needs — `checkValueAgainstType`, `coerceHclValue`, `closestName` — is in
 * this package, and a workspace whose only dependency is its sibling is ceremony.
 *
 * What is *not* here is anything either caller knows alone. The dashboard reasons about
 * locals, unwired inputs and candidate sources on a canvas; the MCP server reasons about
 * duplicate labels and a stack that is not a graph. Those stayed where they are, because
 * shared code that needs a flag per caller is two functions wearing one name.
 */

/**
 * How much of a module's interface the caller can actually see.
 *
 * The concept that unified the two implementations, which had each invented half of it.
 * The dashboard had `portsKnown`: false for a `module` block written by hand against a
 * source nobody imported, where *nothing* is known and any complaint would be invented.
 * The MCP server had `confidence: unverifiable`: its catalogue snapshot keeps forty inputs
 * of a module that declares two hundred and thirty-six, so an absent argument may well be
 * real. Both are incomplete knowledge; they differ in degree, and the degree decides what
 * may be said:
 *
 *   complete  an undeclared argument is certainly wrong — Terraform will reject it
 *   partial   it may be real, so it is reported as a warning naming the uncertainty
 *   unknown   nothing is known, so nothing is claimed
 */
export type InterfaceKnowledge = "complete" | "partial" | "unknown";

/** Whether a finding is a fact about the module or a suspicion about it. */
export type Confidence = "certain" | "unverifiable";

export type InterfaceFindingKind =
  | "unknown-argument"
  | "type-mismatch"
  | "missing-input"
  | "dangling-module"
  | "unknown-output";

export interface PortSpec {
  name: string;
  type?: string | null;
  required?: boolean;
  description?: string | null;
}

export interface BlockInterface {
  /** Block label, as it appears in messages. */
  label: string;
  inputs: readonly PortSpec[];
  outputs: readonly PortSpec[];
  /** Defaults to `complete`; see {@link InterfaceKnowledge}. */
  knowledge?: InterfaceKnowledge;
  /**
   * Where to look when knowledge is `partial`, e.g. `terrablox/terrablox-aws-vpc at
   * v6.6.1`. Named in the message, because "this might be real" without saying where to
   * check is not actionable.
   */
  source?: string | null;
  /** How many ports are known to be absent from the lists above. */
  omitted?: { inputs?: number; outputs?: number };
}

export interface InterfaceFinding {
  kind: InterfaceFindingKind;
  confidence: Confidence;
  /** The block this is about. */
  where: string;
  /** The input or output name, when the finding has one. */
  subject?: string;
  /** One sentence, addressed to whoever has to fix it. */
  message: string;
}

function knowledgeOf(block: BlockInterface): InterfaceKnowledge {
  return block.knowledge ?? "complete";
}

/** `terrablox/x at v1` when the caller supplied it, else a bare instruction. */
function whereToCheck(block: BlockInterface): string {
  return block.source
    ? `Check ${block.source} before changing it.`
    : "Check the module's source before changing it.";
}

/**
 * One argument of one block, against that block's inputs.
 *
 * Two findings at most and never both: an argument that is not declared has no declared
 * type to check against, so the type check only runs once the name is known to be real.
 */
export function checkArgument(
  block: BlockInterface,
  name: string,
  value: string,
): InterfaceFinding[] {
  const knowledge = knowledgeOf(block);

  // Nothing is known about this interface, so nothing can be said about it. Standing
  // down rather than refusing every edit is what lets a hand-written `module` block
  // against an unimported source still be edited.
  if (knowledge === "unknown") return [];

  const declared = block.inputs.find((input) => input.name === name);

  if (!declared) {
    if (knowledge === "partial") {
      const omitted = block.omitted?.inputs ?? 0;

      return [
        {
          kind: "unknown-argument",
          confidence: "unverifiable",
          where: block.label,
          subject: name,
          message: `${block.label}.${name} is not among the ${block.inputs.length} inputs known here${
            omitted > 0 ? `, and ${omitted} more were omitted` : ""
          } — so it may well be real. ${whereToCheck(block)}`,
        },
      ];
    }

    const suggestion = closestName(
      name,
      block.inputs.map((input) => input.name),
    );

    return [
      {
        kind: "unknown-argument",
        confidence: "certain",
        where: block.label,
        subject: name,
        message: `${block.label} has no input called "${name}"${
          suggestion ? `; did you mean "${suggestion}"?` : ""
        }. Terraform rejects an argument a module does not declare.`,
      },
    ];
  }

  // Coerced before the type check, and this is where the two implementations had
  // diverged. `checkValueAgainstType` judges a *value*, and an uncoerced `production`
  // looks like a reference whose shape nothing can judge — so the projection silently
  // passed what the MCP server caught. Coercing here makes the stricter behaviour the
  // shared one.
  const mismatch = checkValueAgainstType(
    declared.type ?? null,
    coerceHclValue(value),
  );

  if (!mismatch) return [];

  return [
    {
      kind: "type-mismatch",
      confidence: "certain",
      where: block.label,
      subject: name,
      message: `${block.label}.${name} ${mismatch}`,
    },
  ];
}

/** Every argument of one block. */
export function checkArguments(
  block: BlockInterface,
  args: Readonly<Record<string, string>>,
): InterfaceFinding[] {
  return Object.entries(args).flatMap(([name, value]) =>
    checkArgument(block, name, value),
  );
}

/**
 * Required inputs the call leaves unset.
 *
 * `suggestionsFor` is how the two callers keep what only they know: the dashboard can
 * name outputs already on the canvas that would fit, and modules from the library that
 * could supply one, while a proposed stack has neither. A parameter rather than two
 * functions, because the finding is the same and only its ending differs.
 *
 * `partial` knowledge is handled by the caller, not here — whether required inputs
 * survived a truncation is a fact about how that truncation was made, and only the caller
 * knows. See the MCP server's own guard.
 */
export function missingRequiredInputs(
  block: BlockInterface,
  args: Readonly<Record<string, string>>,
  options?: { suggestionsFor?: (input: PortSpec) => readonly string[] },
): InterfaceFinding[] {
  if (knowledgeOf(block) === "unknown") return [];

  return block.inputs
    .filter((input) => input.required === true && !(input.name in args))
    .map((input) => {
      const from = options?.suggestionsFor?.(input) ?? [];

      return {
        kind: "missing-input" as const,
        confidence: "certain" as Confidence,
        where: block.label,
        subject: input.name,
        // The description last, as its own sentence. It is what tells a caller *what* to
        // put there rather than merely that something is missing — worth the length, and
        // worth keeping out of the way of the candidate sources, which are the more
        // actionable half when there are any.
        message: `${block.label}.${input.name}${
          input.type ? ` (${input.type})` : ""
        } is required and unset${
          from.length > 0 ? `; could come from ${from.join(" or ")}` : ""
        }.${input.description ? ` ${input.description}` : ""}`,
      };
    });
}

/** Names in a sentence, capped so a message stays readable. */
function summarise(names: readonly string[], hint?: string): string {
  if (names.length === 0) return "no outputs";
  if (names.length <= 12) return names.join(", ");

  return `${names.slice(0, 12).join(", ")} and ${names.length - 12} more${
    hint ? ` (${hint})` : ""
  }`;
}

/**
 * References in one expression that point at a block or output which is not there.
 *
 * Reads `module.<label>.<output>` out of the expression as written, rather than taking a
 * parsed form, because that is what both callers hold: an argument value is raw HCL on its
 * way into a file. A reference to a block declared later still resolves — `blocks` is the
 * whole set, and Terraform does not care about order either.
 *
 * `outputsHint` names the tool that would list the rest, which differs per caller and is
 * the one piece of wording this cannot decide.
 */
export function checkReferences(
  where: string,
  expression: string,
  blocks: ReadonlyMap<string, BlockInterface>,
  options?: { ownLabel?: string; outputsHint?: string },
): InterfaceFinding[] {
  const findings: InterfaceFinding[] = [];

  for (const match of expression.matchAll(
    /\bmodule\.([A-Za-z_][A-Za-z0-9_-]*)(?:\.([A-Za-z_][A-Za-z0-9_-]*))?/g,
  )) {
    const label = match[1];
    const output = match[2];
    if (!label) continue;

    const producer = blocks.get(label);

    if (!producer) {
      const suggestion = closestName(label, [...blocks.keys()]);

      findings.push({
        kind: "dangling-module",
        confidence: "certain",
        where: options?.ownLabel ?? where,
        subject: label,
        message: `${where} reads module.${label}, which does not exist${
          suggestion ? `; did you mean "${suggestion}"?` : ""
        }.`,
      });
      continue;
    }

    if (!output) continue;

    const knowledge = knowledgeOf(producer);
    if (knowledge === "unknown") continue;
    if (producer.outputs.some((port) => port.name === output)) continue;

    const names = producer.outputs.map((port) => port.name);

    if (knowledge === "partial") {
      const omitted = producer.omitted?.outputs ?? 0;

      findings.push({
        kind: "unknown-output",
        confidence: "unverifiable",
        where: options?.ownLabel ?? where,
        subject: output,
        message: `${where} reads module.${label}.${output}, which is not among the ${names.length} outputs known here${
          omitted > 0
            ? ` — but ${omitted} more were omitted, so it may exist`
            : ""
        }. ${whereToCheck(producer)}`,
      });
      continue;
    }

    const suggestion = closestName(output, names);

    findings.push({
      kind: "unknown-output",
      confidence: "certain",
      where: options?.ownLabel ?? where,
      subject: output,
      // The real names, not only the nearest one. A suggestion is a guess that often
      // misses — `subnet_ids` is nowhere near `private_subnets` — and a message that then
      // says nothing leaves the only fix to another guess.
      message: `${where} reads module.${label}.${output}, but ${label} has no such output${
        suggestion ? `; did you mean "${suggestion}"?` : ""
      }. It exposes ${summarise(names, options?.outputsHint)}.`,
    });
  }

  return findings;
}
