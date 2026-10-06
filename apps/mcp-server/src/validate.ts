import {
  CATALOGUE_ENTRIES,
  type CatalogueEntry,
  resolveCatalogueEntry,
  sortedInputs,
} from "@terrablox/catalogue";
import { closestName } from "@terrablox/terraform/identifier-suggest";
import {
  type BlockInterface,
  checkArgument,
  checkReferences,
  type InterfaceFinding,
  missingRequiredInputs,
} from "@terrablox/terraform/module-interface";

import { SEVERITY_ORDER, type Stack, type StackProblem } from "./stack.js";

/**
 * Checks a proposed stack against the modules' declared interfaces.
 *
 * The interface check itself lives in `@terrablox/terraform/module-interface`, shared with
 * the dashboard's graph projection — it used to exist here in full and there in full, which
 * is two implementations of the one claim the product makes about itself. They had already
 * drifted: this one coerced a value before type-checking it and the projection did not, so
 * a bare word against a `list(string)` input was caught here and missed there.
 *
 * What remains here is what only this server knows: the shape of a *stack* rather than a
 * graph — duplicate labels, a module that is not in the catalogue, a block referring to
 * itself — and the translation of the catalogue's truncation into the shared function's
 * notion of partial knowledge.
 *
 * What it deliberately does not attempt: anything needing the providers downloaded or the
 * whole configuration in hand. That is `terraform validate`, it runs later, and pretending
 * to replace it would be the one failure mode worth avoiding — an agent that trusts a
 * green result here and skips the real plan.
 */

/**
 * A catalogue entry as the shared checker sees it.
 *
 * `partial` whenever the snapshot truncated the interface, which is the whole reason that
 * knowledge level exists: the snapshot keeps forty inputs of a module that declares two
 * hundred and thirty-six, so "not declared" is genuinely unknown for those and must come
 * back as a warning naming the omission rather than as an error.
 */
function toBlockInterface(
  label: string,
  entry: CatalogueEntry,
): BlockInterface {
  const truncated = entry.omitted.inputs > 0 || entry.omitted.outputs > 0;

  return {
    label,
    inputs: entry.inputs.map((input) => ({
      name: input.name,
      type: input.type,
      required: input.required,
      description: input.description,
    })),
    outputs: entry.outputs.map((output) => ({ name: output.name })),
    knowledge: truncated ? "partial" : "complete",
    source: `${entry.repo} at ${entry.version}`,
    omitted: { inputs: entry.omitted.inputs, outputs: entry.omitted.outputs },
  };
}

/** The shared finding, as this server reports problems. */
function toStackProblem(finding: InterfaceFinding): StackProblem {
  return {
    kind: finding.kind,
    // Anything the catalogue cannot settle is a warning. Telling an agent to delete a
    // legitimate argument is worse than saying nothing, and `unverifiable` is exactly
    // the case where that would happen.
    severity: finding.confidence === "unverifiable" ? "warning" : "blocking",
    confidence: finding.confidence,
    where: finding.where,
    message: finding.message,
  };
}

export function checkStack(stack: Stack): StackProblem[] {
  const problems: StackProblem[] = [];

  /** Resolved calls, so references can be checked against what the stack really holds. */
  const entries = new Map<string, CatalogueEntry>();
  const blocks = new Map<string, BlockInterface>();
  const seen = new Set<string>();

  for (const call of stack.calls) {
    const label = call.name?.trim() ?? "";

    if (!label || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(label)) {
      problems.push({
        kind: "invalid-label",
        severity: "blocking",
        confidence: "certain",
        where: label || null,
        message: `"${label}" is not a usable block label. Terraform accepts letters, digits, underscores and dashes, starting with a letter or underscore.`,
      });
      continue;
    }

    if (seen.has(label)) {
      problems.push({
        kind: "duplicate-label",
        severity: "blocking",
        confidence: "certain",
        where: label,
        message: `Two calls are both labelled "${label}". Terraform rejects duplicate module blocks; give one of them another name.`,
      });
      continue;
    }
    seen.add(label);

    const entry = resolveCatalogueEntry(call.module);
    if (!entry) {
      const suggestion = closestName(
        call.module,
        CATALOGUE_ENTRIES.map((candidate) => candidate.slug),
      );
      problems.push({
        kind: "unknown-module",
        severity: "blocking",
        confidence: "certain",
        where: label,
        message: `No module called "${call.module}" in the catalogue${
          suggestion ? `; did you mean "${suggestion}"?` : ""
        }. Call list_catalogue_modules for what is available.`,
      });
      continue;
    }

    entries.set(label, entry);
    blocks.set(label, toBlockInterface(label, entry));
  }

  // A second pass, because a reference is only dangling from the point of view of the
  // whole stack: `module.network.vpc_id` is fine when `network` is declared three calls
  // later, and Terraform does not care about order either.
  for (const call of stack.calls) {
    const label = call.name?.trim() ?? "";
    const block = blocks.get(label);
    const entry = entries.get(label);
    if (!block || !entry) continue;

    const args = call.arguments ?? {};

    for (const [name, value] of Object.entries(args)) {
      const found = checkArgument(block, name, value);
      problems.push(...found.map(toStackProblem));

      // An argument the module certainly does not declare has a moot value: a dangling
      // reference inside it is noise about a line that cannot be committed anyway. An
      // *unverifiable* one is different — the argument probably is real, so a broken
      // reference in it is a real finding, and skipping that is how one went unreported
      // until a probe against the running server showed the gap.
      const certainlyUndeclared = found.some(
        (finding) =>
          finding.kind === "unknown-argument" &&
          finding.confidence === "certain",
      );
      if (certainlyUndeclared) continue;

      if (label === firstSelfReference(value, label)) {
        problems.push({
          kind: "self-reference",
          severity: "blocking",
          confidence: "certain",
          where: label,
          message: `${label}.${name} reads module.${label}, which is itself. Terraform reports this as a dependency cycle.`,
        });
        continue;
      }

      problems.push(
        ...checkReferences(`${label}.${name}`, value, blocks, {
          ownLabel: label,
          outputsHint: "describe_catalogue_module lists them",
        }).map(toStackProblem),
      );
    }

    problems.push(...checkRequired(block, entry, args));
  }

  return problems.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
}

/** The block's own label when the expression reads it, else null. */
function firstSelfReference(value: string, label: string): string | null {
  for (const match of value.matchAll(/\bmodule\.([A-Za-z_][A-Za-z0-9_-]*)/g)) {
    if (match[1] === label) return label;
  }
  return null;
}

/**
 * Required inputs the call leaves unset, plus the guard the shared function cannot make.
 *
 * Whether required inputs survived the snapshot's truncation is a fact about how that
 * truncation was made, and only this side knows it: the generator sorts required inputs
 * first, so they survive the cap unless there are more required inputs than the cap
 * itself. If the last input kept is still a required one, the list may have been cut
 * mid-way — so this says so rather than claiming completeness.
 */
function checkRequired(
  block: BlockInterface,
  entry: CatalogueEntry,
  args: Readonly<Record<string, string>>,
): StackProblem[] {
  const problems = missingRequiredInputs(block, args).map(toStackProblem);

  const ordered = sortedInputs(entry);
  const last = ordered.at(-1);

  if (entry.omitted.inputs > 0 && last?.required === true) {
    problems.push({
      kind: "missing-input",
      severity: "warning",
      confidence: "unverifiable",
      where: block.label,
      message: `${entry.slug} has more required inputs than this catalogue kept, so this list may be incomplete. Check ${entry.repo} at ${entry.version}.`,
    });
  }

  return problems;
}

/** Whether anything in the report should stop a stack being written out. */
export function hasBlocking(problems: readonly StackProblem[]): boolean {
  return problems.some((problem) => problem.severity === "blocking");
}
