/**
 * Shape of `/api/modules/[moduleId]`, and the parsers that make it trustworthy.
 *
 * It sat under `components/module-detail` for as long as only the tabs read it. Then
 * `lib/projects/service.ts`, `lib/projects/graph.ts` and `lib/agent/library-view.ts`
 * needed `parseVariables` and `parseOutputs` as well, and three server modules were
 * importing out of a UI folder — the one dependency direction this codebase does not
 * otherwise have. Nothing about the file was ever UI: it is the contract of an endpoint
 * plus two functions that normalise JSONB columns.
 *
 * The parsers are the reason it is shared rather than duplicated. `variables` and
 * `outputs` are JSON columns, so no caller can be promised their shape, and a second
 * copy of "what an older import might be missing" is a copy that goes stale.
 */

import type {
  ModuleDependent,
  ModuleLink,
} from "@terrablox/terraform/module-link";

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
  /**
   * The `value` expression as written. An output declares no type, so this is
   * what {@link inferOutputType} reads to work one out.
   */
  valueExpression?: string | null;
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
  /**
   * The `count`/`for_each` expression guarding this block, or null when it is
   * always created. Null also on modules imported before this was recorded.
   */
  conditionalOn: string | null;
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
  /** Which icon source the module shows: `repo`, `aws` or `none`. */
  iconMode: string;
  /** A bundled AWS icon chosen at import, without the extension. */
  iconName: string | null;
  /**
   * Presence is all the client needs — the bytes are fetched through our own
   * proxy, which is the only thing that can reach a private repository's raw URL.
   */
  iconUrl: string | null;
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
  /**
   * Part of the catalogue Terrablox ships with: shared by every user, owned by
   * none, and not deletable. Drives the badge and the absent actions menu.
   */
  isBuiltin: boolean;
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
    valueExpression: asString(o["valueExpression"]),
    file: asString(o["file"]),
  }));
}
