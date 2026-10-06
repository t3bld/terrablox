/**
 * A proposed stack: module calls with their arguments, before anything is written.
 *
 * The shape an agent hands over when it says "here is what I would build". Deliberately
 * flat — a list of calls, each naming a catalogue module and carrying raw HCL expressions
 * — because that is the smallest thing that can be checked against real interfaces, and
 * anything richer would be a project model this server has no business owning.
 *
 * Wiring is not a separate concept here. One module reads another by writing
 * `module.<label>.<output>` as an argument value, exactly as Terraform does, and the
 * checker reads those references back out. A dedicated `connect` would be a second way to
 * express the same fact, and the two would drift.
 */

export interface StackCall {
  /** Catalogue slug or display name, e.g. `vpc` or `Certificate Manager`. */
  module: string;
  /** The `module "<label>"` block label this call becomes. */
  name: string;
  /** Input name to raw HCL expression, e.g. `{ vpc_id: "module.network.vpc_id" }`. */
  arguments?: Record<string, string>;
}

export interface Stack {
  calls: StackCall[];
}

/** How sure the checker is that a finding is real. */
export type Confidence = "certain" | "unverifiable";

export type ProblemKind =
  | "unknown-module"
  | "duplicate-label"
  | "invalid-label"
  | "missing-input"
  | "unknown-argument"
  | "type-mismatch"
  | "dangling-module"
  | "unknown-output"
  | "self-reference";

export type Severity = "blocking" | "warning";

export interface StackProblem {
  kind: ProblemKind;
  severity: Severity;
  /**
   * Whether the snapshot could actually settle this.
   *
   * `unverifiable` is the honest answer for a module whose interface the snapshot
   * truncated: the argument may well exist upstream, so the finding is reported as a
   * warning naming the uncertainty rather than as an error the agent should "fix" by
   * deleting a legitimate argument.
   */
  confidence: Confidence;
  /** Block label the finding is about, when it belongs to one. */
  where: string | null;
  /** One sentence, addressed to whoever has to act on it. */
  message: string;
}

/** Worst first, so a reader can stop when it stops mattering. */
export const SEVERITY_ORDER: Record<Severity, number> = {
  blocking: 0,
  warning: 1,
};
