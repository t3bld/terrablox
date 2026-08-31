import "server-only";

import {
  collectReferences,
  type ReferenceSourceBlock,
  type TerraformReferenceEndpointKind,
} from "./references";
import {
  emptyAnalysis,
  type TerraformAnalysis,
  type TerraformAnalysisError,
  type TerraformLocal,
  type TerraformModuleCall,
  type TerraformModuleSourceKind,
  type TerraformOutput,
  type TerraformProvider,
  type TerraformResource,
  type TerraformResourceKind,
  type TerraformSourceFile,
  type TerraformVariable,
} from "./types";

/**
 * Terraform analysis backed by HashiCorp's own HCL parser (`@cdktf/hcl2json`,
 * a WASM build of the upstream Go parser).
 *
 * A hand-rolled regex parser cannot handle the constructs real modules use --
 * multi-line `object({...})` types, heredoc descriptions, nested blocks inside
 * `required_providers` -- so anything short of a real parser silently produces
 * wrong data rather than failing loudly.
 *
 * The package resolves its WASM payload relative to `__dirname`, which webpack
 * would rewrite. It is therefore listed in `serverComponentsExternalPackages`
 * in `next.config.mjs`; removing that entry breaks parsing at runtime.
 */

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * HCL blocks are addressed by label and may legally repeat, so the parser
 * always yields arrays of bodies. Callers only care about the merged body.
 */
function blockBodies(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (isRecord(value)) return [value];
  return [];
}

function firstBody(value: unknown): JsonRecord {
  return blockBodies(value)[0] ?? {};
}

function asString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function asBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

/**
 * Type expressions and other unevaluated HCL come back wrapped as `${...}`.
 * Unwrap it so the UI shows `object({ ... })` rather than `${object({ ... })}`.
 */
function unwrapExpression(value: unknown): string | null {
  const raw = asString(value);
  if (raw === null) return null;

  const trimmed = raw.trim();
  if (trimmed.startsWith("${") && trimmed.endsWith("}")) {
    return trimmed.slice(2, -1).trim();
  }
  return trimmed;
}

/**
 * An HCL value as a single string, whatever hcl2json turned it into.
 *
 * A literal list or object arrives as a real array or record; an expression
 * arrives as an interpolated string. Both have to survive into one column, and
 * JSON is a lossy but readable stand-in for the HCL that produced them — enough
 * for {@link inferOutputType} to tell a list from a string.
 */
function describeValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return unwrapExpression(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function classifyModuleSource(
  source: string | null,
): TerraformModuleSourceKind {
  if (!source) return "unknown";

  const s = source.trim();
  if (s.startsWith("./") || s.startsWith("../")) return "local";
  if (
    s.startsWith("git::") ||
    s.startsWith("git@") ||
    s.startsWith("github.com/") ||
    s.startsWith("bitbucket.org/") ||
    /^https?:\/\//.test(s)
  ) {
    return "git";
  }

  // Registry addresses are `[<host>/]<namespace>/<name>/<provider>`.
  const parts = s.split("/");
  if (parts.length === 3 || parts.length === 4) return "registry";

  return "unknown";
}

/**
 * Terraform derives a resource's provider from the prefix of its type, so
 * `aws_s3_bucket` belongs to the provider with local name `aws`.
 */
function providerFromResourceType(type: string): string {
  const idx = type.indexOf("_");
  if (idx <= 0) return type;
  return type.slice(0, idx);
}

function collectVariables(body: JsonRecord, file: string): TerraformVariable[] {
  const declared = body["variable"];
  if (!isRecord(declared)) return [];

  const out: TerraformVariable[] = [];

  for (const [name, raw] of Object.entries(declared)) {
    const v = firstBody(raw);
    const hasDefault = Object.hasOwn(v, "default");

    out.push({
      name,
      description: asString(v["description"]),
      type: unwrapExpression(v["type"]),
      ...(hasDefault ? { default: v["default"] } : {}),
      required: !hasDefault,
      sensitive: asBoolean(v["sensitive"]) ?? false,
      nullable: asBoolean(v["nullable"]),
      file,
    });
  }

  return out;
}

function collectOutputs(body: JsonRecord, file: string): TerraformOutput[] {
  const declared = body["output"];
  if (!isRecord(declared)) return [];

  return Object.entries(declared).map(([name, raw]) => {
    const o = firstBody(raw);
    return {
      name,
      description: asString(o["description"]),
      sensitive: asBoolean(o["sensitive"]) ?? false,
      valueExpression: describeValue(o["value"]),
      file,
    } satisfies TerraformOutput;
  });
}

function collectModuleCalls(
  body: JsonRecord,
  file: string,
): TerraformModuleCall[] {
  const declared = body["module"];
  if (!isRecord(declared)) return [];

  return Object.entries(declared).map(([name, raw]) => {
    const m = firstBody(raw);
    const source = asString(m["source"]);

    return {
      name,
      source,
      version: asString(m["version"]),
      sourceKind: classifyModuleSource(source),
      file,
    } satisfies TerraformModuleCall;
  });
}

function collectResourcesOfKind(
  body: JsonRecord,
  key: "resource" | "data",
  kind: TerraformResourceKind,
  file: string,
): TerraformResource[] {
  const declared = body[key];
  if (!isRecord(declared)) return [];

  const out: TerraformResource[] = [];

  for (const [type, byName] of Object.entries(declared)) {
    if (!isRecord(byName)) continue;

    for (const [name, raw] of Object.entries(byName)) {
      const body = firstBody(raw);

      out.push({
        kind,
        type,
        name,
        provider: providerFromResourceType(type),
        file,
        conditionalOn: readMultiplicityGuard(body),
        // Unwrapped so it is an expression rather than `${…}` around one, which
        // is how the evaluator and the UI both want to see it.
        availabilityZone: unwrapExpression(body["availability_zone"]),
      });
    }
  }

  return out;
}

/**
 * The expression that decides whether a block exists at all, or null.
 *
 * `for_each` always counts: an empty collection creates nothing, and whether it
 * is empty depends on input we cannot see. `count` only counts when it is not a
 * literal number — `count = 2` says how many, `count = var.enabled ? 1 : 0` says
 * whether, and only the second one makes the resource conditional.
 *
 * The expression is kept rather than reduced to a boolean so the UI can name the
 * variable a reader would have to look up. Terraform's JSON form wraps
 * interpolations in a string, which is why a non-number is enough to tell them
 * apart without parsing HCL a second time.
 */
function readMultiplicityGuard(body: JsonRecord): string | null {
  const forEach = body["for_each"];
  if (forEach !== undefined && forEach !== null) {
    return asString(forEach) ?? "for_each";
  }

  const count = body["count"];
  if (count === undefined || count === null) return null;

  // A literal count is a multiplicity, not a condition — except zero, which is a
  // block deliberately switched off.
  if (typeof count === "number") return count === 0 ? "count = 0" : null;

  return asString(count) ?? "count";
}

/**
 * Providers are declared in two independent places and both must be read:
 * `required_providers` carries source and version, while a bare `provider`
 * block only proves the provider is configured.
 */
function collectProviders(body: JsonRecord): TerraformProvider[] {
  const out: TerraformProvider[] = [];

  for (const tfBlock of blockBodies(body["terraform"])) {
    for (const required of blockBodies(tfBlock["required_providers"])) {
      for (const [name, raw] of Object.entries(required)) {
        if (isRecord(raw)) {
          out.push({
            name,
            source: asString(raw["source"]),
            version: asString(raw["version"]),
          });
          continue;
        }

        // Legacy shorthand: `aws = "~> 5.0"`.
        out.push({ name, source: null, version: asString(raw) });
      }
    }
  }

  const configured = body["provider"];
  if (isRecord(configured)) {
    for (const [name, raw] of Object.entries(configured)) {
      const p = firstBody(raw);
      out.push({ name, source: null, version: asString(p["version"]) });
    }
  }

  return out;
}

function collectRequiredVersion(body: JsonRecord): string | null {
  for (const tfBlock of blockBodies(body["terraform"])) {
    const v = asString(tfBlock["required_version"]);
    if (v) return v;
  }
  return null;
}

/**
 * `locals` blocks are module-wide, so they are merged across every file before
 * references are resolved. A local declared in `locals.tf` is routinely used by
 * a resource in `main.tf`.
 */
function collectLocals(
  body: JsonRecord,
  file: string,
  into: Map<string, unknown>,
  declared: TerraformLocal[],
): void {
  for (const block of blockBodies(body["locals"])) {
    for (const [name, expression] of Object.entries(block)) {
      if (into.has(name)) continue;
      into.set(name, expression);

      // The unwrapped text, so the canvas shows `module.vpc.id` rather than
      // `${module.vpc.id}`. Non-string expressions (a number, a list) are
      // stringified, because the node has to render something.
      declared.push({
        name,
        expression:
          unwrapExpression(expression) ?? stringifyExpression(expression),
        file,
      });
    }
  }
}

/**
 * A last resort for expressions the parser did not hand back as a string.
 *
 * `locals { ports = [80, 443] }` comes back as an array, and the canvas still
 * has to show it. JSON is close enough to HCL for lists and objects that it
 * reads correctly, and it round-trips through {@link coerceHclValue} unchanged.
 */
function stringifyExpression(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

/**
 * Rebuilds the addressable blocks from a parsed file so references can be
 * resolved against them. Mirrors `collectResourcesOfKind`, but keeps the bodies
 * that the resource collector deliberately drops.
 */
function collectReferenceBlocks(
  body: JsonRecord,
  into: ReferenceSourceBlock[],
): void {
  for (const [key, kind] of [
    ["resource", "resource"],
    ["data", "data"],
  ] as const) {
    const declared = body[key];
    if (!isRecord(declared)) continue;

    for (const [type, byName] of Object.entries(declared)) {
      if (!isRecord(byName)) continue;

      for (const [name, blockBody] of Object.entries(byName)) {
        const address =
          kind === "data" ? `data.${type}.${name}` : `${type}.${name}`;
        into.push({ address, kind, body: blockBody });
      }
    }
  }

  const modules = body["module"];
  if (isRecord(modules)) {
    for (const [name, blockBody] of Object.entries(modules)) {
      into.push({
        address: `module.${name}`,
        kind: "module",
        body: blockBody,
      });
    }
  }
}

/** Keeps the richest entry per provider, since declarations are split. */
function mergeProviders(providers: TerraformProvider[]): TerraformProvider[] {
  const merged = new Map<string, TerraformProvider>();

  for (const p of providers) {
    if (!p.name) continue;

    const existing = merged.get(p.name);
    if (!existing) {
      merged.set(p.name, p);
      continue;
    }

    merged.set(p.name, {
      name: p.name,
      source: existing.source ?? p.source,
      version: existing.version ?? p.version,
    });
  }

  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Later declarations of the same key are dropped rather than duplicated; real
 * Terraform would reject duplicates anyway.
 */
function dedupeByKey<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];

  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }

  return out;
}

export async function analyzeTerraformFiles(
  files: TerraformSourceFile[],
): Promise<TerraformAnalysis> {
  if (files.length === 0) return emptyAnalysis();

  // Imported lazily so the WASM payload is only initialised when a module is
  // actually analysed, not on every request that touches this module.
  const { parse } = await import("@cdktf/hcl2json");

  const analysis = emptyAnalysis();
  const errors: TerraformAnalysisError[] = [];
  const providers: TerraformProvider[] = [];
  const locals = new Map<string, unknown>();
  const referenceBlocks: ReferenceSourceBlock[] = [];

  for (const file of files) {
    let body: JsonRecord;

    try {
      const parsed: unknown = await parse(file.path, file.content);
      if (!isRecord(parsed)) {
        errors.push({ file: file.path, message: "Parser returned no object" });
        continue;
      }
      body = parsed;
    } catch (e) {
      errors.push({
        file: file.path,
        message: e instanceof Error ? e.message : String(e),
      });
      continue;
    }

    analysis.variables.push(...collectVariables(body, file.path));
    analysis.outputs.push(...collectOutputs(body, file.path));
    analysis.moduleCalls.push(...collectModuleCalls(body, file.path));
    analysis.resources.push(
      ...collectResourcesOfKind(body, "resource", "resource", file.path),
      ...collectResourcesOfKind(body, "data", "data", file.path),
    );
    providers.push(...collectProviders(body));
    collectLocals(body, file.path, locals, analysis.locals);
    collectReferenceBlocks(body, referenceBlocks);

    analysis.requiredVersion ??= collectRequiredVersion(body);
  }

  analysis.variables = dedupeByKey(analysis.variables, (v) => v.name).sort(
    (a, b) => a.name.localeCompare(b.name),
  );
  analysis.outputs = dedupeByKey(analysis.outputs, (o) => o.name).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  analysis.moduleCalls = dedupeByKey(analysis.moduleCalls, (m) => m.name).sort(
    (a, b) => a.name.localeCompare(b.name),
  );
  analysis.resources = dedupeByKey(
    analysis.resources,
    (r) => `${r.kind}.${r.type}.${r.name}`,
  ).sort(
    (a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name),
  );
  analysis.providers = mergeProviders(providers);
  analysis.locals = analysis.locals.sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  // Resolved last: locals are module-wide and a reference may point at a block
  // declared in a different file, so every file must be parsed first.
  const knownAddresses = new Map<string, TerraformReferenceEndpointKind>();
  for (const r of analysis.resources) {
    knownAddresses.set(
      r.kind === "data" ? `data.${r.type}.${r.name}` : `${r.type}.${r.name}`,
      r.kind,
    );
  }
  for (const m of analysis.moduleCalls) {
    knownAddresses.set(`module.${m.name}`, "module");
  }

  analysis.references = collectReferences({
    blocks: referenceBlocks,
    locals,
    knownAddresses,
  });

  analysis.errors = errors;

  return analysis;
}
