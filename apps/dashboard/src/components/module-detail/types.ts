/**
 * Shape of `/api/modules/[moduleId]`. Kept next to the components that consume
 * it so the tabs share one definition instead of re-declaring `unknown` casts.
 */

import type { ModuleDependent, ModuleLink } from "@/lib/terraform/module-link";

export interface ModuleVariableDto {
  name: string;
  description: string | null;
  type: string | null;
  default?: unknown;
  required?: boolean;
  sensitive?: boolean;
  file?: string | null;
}

export interface ModuleOutputDto {
  name: string;
  description: string | null;
  sensitive?: boolean;
  file?: string | null;
}

export interface ModuleResourceDto {
  id: string;
  kind: string;
  providerName: string;
  resourceType: string;
  resourceName: string | null;
  version: string | null;
  sourceFile: string | null;
  resourceUrl: string | null;
  providerUrl: string | null;
  resourceDescription: string | null;
}

export interface ModuleDependencyDto {
  id: string;
  name: string;
  source: string | null;
  version: string | null;
  sourceKind: string;
  registryUrl: string | null;
  sourceFile: string | null;
  /** Set when this dependency resolves to a module the user has imported. */
  linkedModule?: ModuleLink | null;
}

export interface ModuleProviderDto {
  id: string;
  name: string;
  source: string | null;
  version: string | null;
  docsUrl: string | null;
}

export interface ModuleReferenceDto {
  id: string;
  fromAddress: string;
  fromKind: string;
  toAddress: string;
  toKind: string;
  attributes: string[];
  viaLocals: string[];
}

export interface ModuleSubmoduleDto {
  id: string;
  submoduleName: string | null;
  terraformRootFolder: string | null;
}

export interface ModuleSourceDto {
  id: string;
  name: string;
  description: string | null;
  tags: string[];
  url: string;
  provider: string;
}

export interface ModuleDetailDto {
  id: string;
  effectiveName: string;
  effectiveDescription: string | null;
  versionTag: string | null;
  url: string | null;
  sourceId: string | null;
  terraformRootFolder: string | null;
  isSubmodule: boolean;
  submoduleName: string | null;
  parentModuleId: string | null;
  variables: unknown;
  outputs: unknown;
  resources: ModuleResourceDto[];
  dependencies: ModuleDependencyDto[];
  /** Imported modules that call this one; the inverse of `dependencies`. */
  dependents?: ModuleDependent[];
  providers: ModuleProviderDto[];
  references?: ModuleReferenceDto[];
  submodules?: ModuleSubmoduleDto[];
  /** Sibling root versions of the same repository, newest first. */
  versions: { id: string; versionTag: string | null; createdAt: string }[];
  source: ModuleSourceDto | null;
}

/**
 * `variables` and `outputs` are JSONB columns, so the API cannot promise their
 * shape. Normalising here keeps the casts out of the components.
 */
function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (v): v is Record<string, unknown> =>
      typeof v === "object" && v !== null && !Array.isArray(v),
  );
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function parseVariables(value: unknown): ModuleVariableDto[] {
  return asRecordArray(value).map((v) => {
    const hasDefault = Object.hasOwn(v, "default");

    return {
      name: asString(v["name"]) ?? "",
      description: asString(v["description"]),
      type: asString(v["type"]),
      ...(hasDefault ? { default: v["default"] } : {}),
      // Older imports predate the `required` flag; fall back to the default.
      required:
        typeof v["required"] === "boolean" ? v["required"] : !hasDefault,
      sensitive: v["sensitive"] === true,
      file: asString(v["file"]),
    };
  });
}

export function parseOutputs(value: unknown): ModuleOutputDto[] {
  return asRecordArray(value).map((o) => ({
    name: asString(o["name"]) ?? "",
    description: asString(o["description"]),
    sensitive: o["sensitive"] === true,
    file: asString(o["file"]),
  }));
}
