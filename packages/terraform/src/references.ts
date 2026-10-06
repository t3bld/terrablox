/**
 * Extracts the references between blocks of a Terraform module.
 *
 * `@cdktf/hcl2json` keeps unevaluated HCL as `${...}` strings, so a parsed body
 * still carries every reference verbatim -- `subnet_id: "${element(
 * aws_subnet.public[*].id, count.index)}"`. Walking those strings is what turns
 * a flat list of resources into a graph.
 *
 * Two decisions keep the result trustworthy:
 *
 * 1. Only strings containing `${` are scanned. A literal such as
 *    `"64:ff9b::/96"` or a prose description can never produce an edge.
 * 2. A token only counts once it matches an address that is actually declared
 *    in the module. That discards `count.index`, `each.value`, `path.module`
 *    and attribute access like `var.tags.Name` without maintaining a blocklist.
 */

export type TerraformReferenceEndpointKind = "resource" | "data" | "module";

export interface TerraformReference {
  /** The block containing the reference, i.e. the dependent one. */
  fromAddress: string;
  fromKind: TerraformReferenceEndpointKind;
  /** The block being referenced, i.e. the dependency. */
  toAddress: string;
  toKind: TerraformReferenceEndpointKind;
  /** Attributes of the dependent block that produced this edge, e.g. `subnet_id`. */
  attributes: string[];
  /** Locals the reference was routed through, in resolution order. */
  viaLocals: string[];
}

export interface ReferenceSourceBlock {
  address: string;
  kind: TerraformReferenceEndpointKind;
  body: unknown;
}

export interface CollectReferencesInput {
  blocks: readonly ReferenceSourceBlock[];
  /** Module-wide `locals`, merged across files. */
  locals: ReadonlyMap<string, unknown>;
  knownAddresses: ReadonlyMap<string, TerraformReferenceEndpointKind>;
}

/**
 * Matches dotted identifier chains. HCL identifiers allow `-`, and indexing
 * (`[0]`, `[*]`) terminates the match, which is exactly what we want: the
 * address is the part before the subscript.
 */
const DOTTED_CHAIN = /[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)+/g;

/** Guards against `local.a = local.b` cycles, which HCL itself rejects but we must not hang on. */
const MAX_LOCAL_DEPTH = 12;

interface ResolvedTarget {
  address: string;
  kind: TerraformReferenceEndpointKind;
  viaLocals: string[];
}

/**
 * Resolves one dotted chain to a declared address.
 *
 * Longest prefix wins so `data.aws_ami.foo.id` resolves to the data source and
 * not to a resource that happens to be called `data.aws_ami`.
 */
function matchKnownAddress(
  chain: string,
  knownAddresses: ReadonlyMap<string, TerraformReferenceEndpointKind>,
): { address: string; kind: TerraformReferenceEndpointKind } | null {
  const parts = chain.split(".");

  for (const length of [3, 2]) {
    if (parts.length < length) continue;
    const candidate = parts.slice(0, length).join(".");
    const kind = knownAddresses.get(candidate);
    if (kind) return { address: candidate, kind };
  }

  return null;
}

function isLocalChain(chain: string): string | null {
  const parts = chain.split(".");
  if (parts.length < 2 || parts[0] !== "local") return null;
  return parts[1] ?? null;
}

/** Collects every dotted chain from a string, but only if it is an interpolation. */
function chainsInString(value: string): string[] {
  if (!value.includes("${")) return [];
  return value.match(DOTTED_CHAIN) ?? [];
}

/**
 * Walks a parsed body and yields every dotted chain together with the
 * top-level attribute it was found under. The top-level key is what a reader
 * recognises (`subnet_id`, `depends_on`), so nested keys are not tracked.
 */
function chainsInValue(value: unknown, out: (chain: string) => void): void {
  if (typeof value === "string") {
    for (const chain of chainsInString(value)) out(chain);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) chainsInValue(item, out);
    return;
  }

  if (typeof value === "object" && value !== null) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      chainsInValue(nested, out);
    }
  }
}

/**
 * Expands a chain into the addresses it ultimately points at.
 *
 * A local is not a node in the graph but it does carry dependencies: in
 * terraform-aws-vpc `local.vpc_id` is `try(aws_vpc_ipv4_cidr_block_association
 * .this[0].vpc_id, aws_vpc.this[0].id, "")`, so every resource using
 * `local.vpc_id` genuinely depends on the VPC. Without this the graph would
 * lose most of its edges.
 */
function resolveChain(
  chain: string,
  input: CollectReferencesInput,
  viaLocals: string[],
  seenLocals: Set<string>,
  out: ResolvedTarget[],
): void {
  const direct = matchKnownAddress(chain, input.knownAddresses);
  if (direct) {
    out.push({ ...direct, viaLocals });
    return;
  }

  const localName = isLocalChain(chain);
  if (!localName) return;
  if (seenLocals.has(localName)) return;
  if (viaLocals.length >= MAX_LOCAL_DEPTH) return;

  const expression = input.locals.get(localName);
  if (expression === undefined) return;

  const nextSeen = new Set(seenLocals).add(localName);
  const nextVia = [...viaLocals, localName];

  chainsInValue(expression, (nested) => {
    resolveChain(nested, input, nextVia, nextSeen, out);
  });
}

export function collectReferences(
  input: CollectReferencesInput,
): TerraformReference[] {
  // Keyed by `from -> to` so a pair referenced from several attributes stays a
  // single edge instead of drawing duplicates on top of each other.
  const edges = new Map<string, TerraformReference>();

  for (const block of input.blocks) {
    if (typeof block.body !== "object" || block.body === null) continue;

    const bodies = Array.isArray(block.body) ? block.body : [block.body];

    for (const body of bodies) {
      if (typeof body !== "object" || body === null) continue;

      for (const [attribute, value] of Object.entries(
        body as Record<string, unknown>,
      )) {
        const targets: ResolvedTarget[] = [];

        chainsInValue(value, (chain) => {
          resolveChain(chain, input, [], new Set(), targets);
        });

        for (const target of targets) {
          // A resource referencing itself (commonly through a local) is noise,
          // not a dependency.
          if (target.address === block.address) continue;

          const key = `${block.address}->${target.address}`;
          const existing = edges.get(key);

          if (existing) {
            if (!existing.attributes.includes(attribute)) {
              existing.attributes.push(attribute);
            }
            // Prefer showing the shortest path a reference took.
            if (target.viaLocals.length < existing.viaLocals.length) {
              existing.viaLocals = target.viaLocals;
            }
            continue;
          }

          edges.set(key, {
            fromAddress: block.address,
            fromKind: block.kind,
            toAddress: target.address,
            toKind: target.kind,
            attributes: [attribute],
            viaLocals: target.viaLocals,
          });
        }
      }
    }
  }

  for (const edge of edges.values()) {
    edge.attributes.sort((a, b) => a.localeCompare(b));
  }

  return [...edges.values()].sort(
    (a, b) =>
      a.fromAddress.localeCompare(b.fromAddress) ||
      a.toAddress.localeCompare(b.toAddress),
  );
}
