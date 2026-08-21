/**
 * Shared shapes for the Terraform analysis pipeline.
 *
 * Kept free of `server-only` so both route handlers and client components can
 * import the types without pulling the WASM parser into a browser bundle.
 */

import type {
  TerraformReference,
  TerraformReferenceEndpointKind,
} from "./references";

export type TerraformResourceKind = "resource" | "data";

/**
 * Where a module call points to. Determines whether we can link it anywhere
 * and how it should be rendered in the dependency graph.
 */
export type TerraformModuleSourceKind =
  | "local"
  | "registry"
  | "git"
  | "unknown";

export interface TerraformVariable {
  name: string;
  description: string | null;
  /** Rendered HCL type expression, e.g. `object({ name = string })`. */
  type: string | null;
  /** Absent when the variable has no default, which makes it required. */
  default?: unknown;
  required: boolean;
  sensitive: boolean;
  nullable: boolean | null;
  /** File the block was declared in, relative to the module folder. */
  file: string | null;
}

export interface TerraformOutput {
  name: string;
  description: string | null;
  sensitive: boolean;
  /**
   * The `value` expression, as written.
   *
   * Terraform outputs declare no type, so this is the only evidence of what one
   * hands back. Stored raw rather than as a derived type: the expression is the
   * durable fact, and improving the inference should not require re-importing
   * every module.
   */
  valueExpression: string | null;
  file: string | null;
}

export interface TerraformProvider {
  /** Local name as used in resource type prefixes, e.g. `aws`. */
  name: string;
  /** Registry source, e.g. `hashicorp/aws`. Null when not declared. */
  source: string | null;
  /** Version constraint, e.g. `~> 5.0`. */
  version: string | null;
}

export interface TerraformResource {
  kind: TerraformResourceKind;
  /** Full type, e.g. `aws_s3_bucket`. */
  type: string;
  /** Local name, e.g. `logs`. */
  name: string;
  /** Provider local name derived from the type prefix. */
  provider: string;
  file: string | null;
  /**
   * The `count` or `for_each` expression, when the block may produce nothing.
   *
   * Null means the block is always created. This exists because reading HCL is
   * not the same as reading a plan: `count = var.create_x ? 1 : 0` is a resource
   * that is *in the code* and usually not deployed, and a diagram that cannot
   * tell the two apart states as fact something that depends on a variable
   * nobody has set yet.
   *
   * A literal `count = 2` is not a condition and is recorded as null: it says how
   * many, not whether.
   */
  conditionalOn: string | null;
}

export interface TerraformModuleCall {
  name: string;
  source: string | null;
  version: string | null;
  sourceKind: TerraformModuleSourceKind;
  file: string | null;
}

/**
 * A named value from a `locals` block.
 *
 * Reported as its own entity rather than only merged into the reference
 * resolver, because the project canvas draws locals: a user placing one needs
 * to see where it lives and what it says, not just that something resolved
 * through it.
 */
export interface TerraformLocal {
  name: string;
  /**
   * The expression as the parser returned it, with `${…}` already unwrapped.
   * Kept as text because a local can be any HCL expression, and evaluating it
   * is Terraform's job rather than ours.
   */
  expression: string | null;
  file: string | null;
}

export interface TerraformAnalysis {
  variables: TerraformVariable[];
  outputs: TerraformOutput[];
  providers: TerraformProvider[];
  resources: TerraformResource[];
  moduleCalls: TerraformModuleCall[];
  /** Named values from `locals` blocks, merged across files. */
  locals: TerraformLocal[];
  /**
   * Edges between the blocks above, i.e. which resource consumes which. Drives
   * the connection graph.
   */
  references: TerraformReference[];
  /** `required_version` from the terraform block, if declared. */
  requiredVersion: string | null;
  /**
   * Files that could not be parsed, with the parser's message. Surfaced instead
   * of swallowed so a broken module does not silently look empty.
   */
  errors: TerraformAnalysisError[];
}

export interface TerraformAnalysisError {
  file: string;
  message: string;
}

export interface TerraformSourceFile {
  /** Path used for error reporting and provenance. */
  path: string;
  content: string;
}

export function emptyAnalysis(): TerraformAnalysis {
  return {
    variables: [],
    outputs: [],
    providers: [],
    resources: [],
    moduleCalls: [],
    locals: [],
    references: [],
    requiredVersion: null,
    errors: [],
  };
}

export type { TerraformReference, TerraformReferenceEndpointKind };
