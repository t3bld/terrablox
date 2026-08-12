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
}

export interface TerraformModuleCall {
  name: string;
  source: string | null;
  version: string | null;
  sourceKind: TerraformModuleSourceKind;
  file: string | null;
}

export interface TerraformAnalysis {
  variables: TerraformVariable[];
  outputs: TerraformOutput[];
  providers: TerraformProvider[];
  resources: TerraformResource[];
  moduleCalls: TerraformModuleCall[];
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
    references: [],
    requiredVersion: null,
    errors: [],
  };
}

export type { TerraformReference, TerraformReferenceEndpointKind };
