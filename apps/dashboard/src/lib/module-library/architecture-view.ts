/**
 * What the architecture diagram shows about a module, derived from what was fetched.
 *
 * All of this used to be `useMemo` bodies inside `architecture-tab.tsx`, which meant the
 * only way to check any of it was to render a canvas and click a box. It is the part of
 * that view with decisions in it: which repository a source address points at, which
 * module declares a given box, which neighbours a selected box actually has.
 *
 * The hard idea running through it is the **call path**. A diagram address carries the
 * chain of module calls in front of it, so `module.vpc/aws_subnet.private` is a subnet
 * belonging to whatever `module "vpc"` resolves to — not to the module being viewed. The
 * same repository reached through two different calls is two different boxes, and only
 * the chain of names says which one an address belongs to.
 */

import type {
  ArchitectureAttachment,
  ArchitectureModuleCall,
  NestedModuleData,
} from "@terrablox/terraform/architecture-graph";
import { resourceAddress } from "@terrablox/terraform/architecture-graph";

import type {
  ModuleDependencyDto,
  ModuleReferenceDto,
  ModuleResourceDto,
} from "./types";

/**
 * The subset of a resource the architecture endpoint returns. Narrower than
 * `ModuleResourceDto` on purpose: claiming the full shape would let a reader of
 * this file use `id`, which the endpoint does not send.
 */
export type NestedResource = Pick<
  ModuleResourceDto,
  | "kind"
  | "resourceType"
  | "resourceName"
  | "providerName"
  | "providerUrl"
  | "sourceFile"
  | "conditionalOn"
  | "resourceUrl"
  | "resourceDescription"
>;

export interface NestedModule {
  id: string;
  name: string;
  versionTag: string | null;
  resources: NestedResource[];
  references: ModuleReferenceDto[];
  /** Output names and expressions, so a nested call can be placed in a subnet. */
  outputs?: { name: string; valueExpression: string | null }[];
  moduleCalls: {
    name: string;
    source: string | null;
    sourceKind: string | null;
    linkedModule: {
      moduleId: string;
      exactVersion: boolean;
      requestedRef: string | null;
    } | null;
  }[];
}

export interface NestedResponse {
  rootId: string;
  modules: Record<string, NestedModule>;
}

/**
 * Where a box on the diagram came from: which module declared it, and under
 * what address inside that module.
 *
 * Nested boxes carry their call path in front of every address, so
 * `module.vpc/aws_subnet.private` is a subnet belonging to whatever
 * `module "vpc"` resolves to — not to the module being viewed. Splitting that
 * apart is what lets the panel show the same detail for a box three levels
 * down as for one the module declares itself.
 */
export interface ResolvedAddress {
  /** The address as Terraform would write it, without the call path. */
  local: string;
  /** Name of the module that declares it, when that is not the one on screen. */
  fromModule?: string;
  /** Link to that module, when it was imported. */
  fromModuleId?: string;
  resource?: NestedResource;
  /** For a `module "x"` box, the source the call points at. */
  moduleSource?: string;
  /** How to read that source; without it a registry address parses wrongly. */
  moduleSourceKind?: string | null;
}

/**
 * Terraform source addresses include a forwarding prefix, subdirectory and
 * ref; the repository itself is the useful destination for a reader.
 */
export function repositoryUrl(
  source: string | null | undefined,
): string | null {
  const withoutForwarder = source?.trim().replace(/^[a-z][a-z0-9+.-]*::/i, "");
  if (!withoutForwarder?.startsWith("http")) return null;

  const withoutQuery = withoutForwarder.split("?", 1)[0] ?? "";
  const schemeEnd = withoutQuery.indexOf("://") + 3;
  const subdirectory = withoutQuery.indexOf("//", schemeEnd);

  return subdirectory === -1
    ? withoutQuery
    : withoutQuery.slice(0, subdirectory);
}

/**
 * This module's own `module` blocks, as boxes the diagram can draw.
 *
 * A call without a source is dropped rather than drawn: there is nothing to resolve it
 * to and nothing to link it at. `requestedRef` is carried only when the imported module
 * is *not* the ref the call asked for, because that is the case the diagram has to be
 * able to mark — a box silently showing a different version is worse than no box.
 */
export function toModuleCalls(
  dependencies: ModuleDependencyDto[] | undefined,
): ArchitectureModuleCall[] {
  return (dependencies ?? [])
    .filter((d) => d.source)
    .map((d) => ({
      name: d.name,
      source: d.source as string,
      sourceKind: d.sourceKind,
      moduleId: d.linkedModule?.moduleId,
      requestedRef:
        d.linkedModule && !d.linkedModule.exactVersion
          ? d.linkedModule.requestedRef
          : null,
    }));
}

/**
 * The contents of an expanded module call, or null when there is nothing to expand.
 *
 * Null covers both "this call resolved to no imported module" and "the nested response
 * does not have it", which behave the same way: the box stays closed.
 */
export function nestedModuleData(
  call: ArchitectureModuleCall,
  nested: NestedResponse | null,
): NestedModuleData | null {
  const target = call.moduleId ? nested?.modules[call.moduleId] : null;
  if (!target) return null;

  return {
    id: target.id,
    name: target.name,
    versionTag: target.versionTag,
    resources: target.resources,
    references: target.references,
    outputs: target.outputs,
    moduleCalls: target.moduleCalls
      .filter((c) => c.source)
      .map((c) => ({
        name: c.name,
        source: c.source as string,
        sourceKind: c.sourceKind,
        moduleId: c.linkedModule?.moduleId,
        requestedRef:
          c.linkedModule && !c.linkedModule.exactVersion
            ? c.linkedModule.requestedRef
            : null,
      })),
  };
}

/** What `resolveAddress` needs to walk a call path: the fetched tree and this module. */
export interface AddressContext {
  nested: NestedResponse | null;
  resources: ModuleResourceDto[];
  dependencies?: ModuleDependencyDto[];
}

/**
 * Splits a diagram address into the module that declares it and the address
 * inside that module, then finds the resource behind it.
 *
 * The call path is walked rather than guessed: the same repository reached
 * through two different calls is two boxes, and only the chain of names says
 * which one a given address belongs to.
 */
export function resolveAddress(
  prefixed: string,
  context: AddressContext,
): ResolvedAddress {
  const { nested, resources, dependencies } = context;

  const segments = prefixed.split("/");
  const local = segments.pop() ?? prefixed;

  let currentId = nested?.rootId;
  let currentName: string | undefined;

  for (const segment of segments) {
    const call = currentId
      ? nested?.modules[currentId]?.moduleCalls.find(
          (candidate) => `module.${candidate.name}` === segment,
        )
      : undefined;

    // An unresolvable chain still yields the local address, which is more
    // useful than refusing to say anything about the box.
    if (!call?.linkedModule) return { local };

    currentId = call.linkedModule.moduleId;
    currentName = nested?.modules[currentId]?.name;
  }

  const isRoot = segments.length === 0;
  const pool: NestedResource[] | undefined = isRoot
    ? resources
    : currentId
      ? nested?.modules[currentId]?.resources
      : undefined;

  const declaring = isRoot ? undefined : currentId;
  const calls = local.startsWith("module.")
    ? isRoot
      ? (dependencies ?? []).map((d) => ({
          name: d.name,
          source: d.source,
          sourceKind: d.sourceKind,
        }))
      : declaring
        ? nested?.modules[declaring]?.moduleCalls
        : undefined
    : undefined;

  const call = calls?.find((entry) => `module.${entry.name}` === local);

  return {
    local,
    fromModule: isRoot ? undefined : currentName,
    fromModuleId: declaring,
    resource: pool?.find((candidate) => resourceAddress(candidate) === local),
    moduleSource: call?.source ?? undefined,
    moduleSourceKind: call?.sourceKind ?? undefined,
  };
}

/** The bit of a drawn box the neighbour lists and the panel read. */
export interface DiagramBox {
  id: string;
  label: string;
  sublabel?: string;
  addresses: string[];
  isModuleCall?: boolean;
  attachments?: ArchitectureAttachment[];
}

/** A box's name as the reader sees it on the canvas, for the neighbour lists. */
export function labelFor(
  boxes: ReadonlyMap<string, DiagramBox>,
  id: string,
): string {
  const node = boxes.get(id);
  if (!node) return id;
  return node.sublabel ? `${node.label} · ${node.sublabel}` : node.label;
}

/** One end of a drawn connection, named as the canvas names it. */
export interface Neighbour {
  address: string;
  label: string;
  note?: string;
}

/** The edge shape the neighbour lists read: two ends and an optional route. */
export interface DiagramEdge {
  source: string;
  target: string;
  via?: string[];
}

/**
 * Neighbours of the selected box, read from the edges actually drawn. Unlike
 * the Connections view there is no filter to look past here: a connection
 * missing from this list is missing because it lives inside a module that is
 * still collapsed, and the panel says so rather than listing boxes that are
 * nowhere on screen.
 */
export function neighboursOf(
  edges: readonly DiagramEdge[],
  selectedId: string | null,
  name: (id: string) => string,
): { feeds: Neighbour[]; fedBy: Neighbour[] } {
  if (!selectedId) return { feeds: [], fedBy: [] };

  const build = (matches: (edge: DiagramEdge) => boolean) => {
    const seen = new Map<string, Neighbour>();

    for (const edge of edges) {
      if (!matches(edge)) continue;
      const other = edge.source === selectedId ? edge.target : edge.source;
      if (seen.has(other)) continue;

      seen.set(other, {
        address: other,
        label: name(other),
        // Routed connections would otherwise look invented: nothing in the
        // Terraform says CloudFront points at a load balancer, an
        // `aws_cloudfront_vpc_origin` between them does.
        note: edge.via?.length
          ? `via ${edge.via.map((address) => address.split("/").pop()).join(" → ")}`
          : undefined,
      });
    }

    return [...seen.values()].sort((a, b) =>
      a.label.localeCompare(b.label, "en", { numeric: true }),
    );
  };

  return {
    feeds: build((edge) => edge.source === selectedId),
    fedBy: build((edge) => edge.target === selectedId),
  };
}

export interface BoxDetail {
  /** The `module "x"` call itself, when the box stands for one. */
  call?: ResolvedAddress;
  resources: ResolvedAddress[];
  /** Set only when the box stands for exactly one resource. */
  only?: ResolvedAddress;
  declaredBy?: string;
  /**
   * The attachment as the graph built it, plus each address resolved.
   *
   * Spread rather than re-listed so a field added to `ArchitectureAttachment` reaches
   * the panel without a change here — the panel reads `service`, `icon` and `shared`.
   */
  supporting: Array<ArchitectureAttachment & { entries: ResolvedAddress[] }>;
}

/**
 * What the panel has to show about the selected box, split by what it is.
 *
 * A box is not always one resource: an HTTP API is five Terraform blocks
 * drawn as one tile, and a wrapper's own resources are folded into the module
 * call they configure. The tile shows only a "×5", which tells the reader
 * that something was folded but not what — this is where they find out.
 */
export function boxDetail(
  selected: DiagramBox | null,
  resolve: (address: string) => ResolvedAddress,
): BoxDetail | null {
  if (!selected) return null;

  const all = selected.addresses.map(resolve);

  // A module call's first address is the call itself; anything after it was
  // folded in from the caller.
  const call = selected.isModuleCall ? all[0] : undefined;
  const rest = selected.isModuleCall ? all.slice(1) : all;

  return {
    call,
    resources: rest,
    only: !call && rest.length === 1 ? rest[0] : undefined,
    declaredBy: call?.fromModule ?? rest[0]?.fromModule,
    /**
     * The undrawn resources serving this box. Resolved through the same call
     * path as the addresses above, so a role inside a nested module reports
     * the file it is actually declared in.
     */
    supporting: (selected.attachments ?? []).map((attachment) => ({
      ...attachment,
      entries: attachment.addresses.map(resolve),
    })),
  };
}

/**
 * Where each `module "x"` box links to.
 *
 * Only module calls that resolved to an imported module become links, so a
 * tile never promises a page that does not exist.
 */
export function moduleHrefs(
  dependencies: ModuleDependencyDto[] | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const dependency of dependencies ?? []) {
    if (dependency.linkedModule) {
      map.set(
        `module.${dependency.name}`,
        `/modules/${dependency.linkedModule.moduleId}#architecture`,
      );
    }
  }
  return map;
}
