/**
 * Derives a coarse AWS architecture diagram from a module's resources and the
 * references between them.
 *
 * The interesting part is that containment is not stored anywhere: Terraform
 * expresses "this subnet belongs to that VPC" as an ordinary reference through
 * the `vpc_id` attribute. Because the analyzer records *which* attribute
 * carried each reference, placement can be read straight out of the graph
 * rather than guessed from naming conventions.
 */

import {
  architectureEntry,
  CONTAINMENT_ATTRIBUTES,
  moduleArchitectureEntry,
  resolveServiceIcon,
} from "./aws-architecture";
import { parseModuleSourceRef } from "./module-link";

export interface ArchitectureResource {
  resourceType: string;
  resourceName: string | null;
  kind: string;
}

/**
 * A `module "name" { source = … }` block. For wrapper repositories these carry
 * the entire architecture, so they are drawn alongside plain resources.
 */
export interface ArchitectureModuleCall {
  name: string;
  source: string;
  /** Set when the call resolves to a module the user has imported. */
  moduleId?: string | null;
  /**
   * The ref this call pins, when the imported copy is a different version.
   * Carried here rather than rebuilt from paths in the UI, because only the
   * builder knows which call produced which box.
   */
  requestedRef?: string | null;
}

/** A called module's own contents, needed to draw it expanded. */
export interface NestedModuleData {
  id: string;
  name: string;
  versionTag: string | null;
  resources: ArchitectureResource[];
  references: ArchitectureReference[];
  moduleCalls: ArchitectureModuleCall[];
}

export interface NestingOptions {
  /**
   * Paths the reader has opened, as `module.vpc` or `module.a/module.b`. Paths
   * rather than plain addresses because the same module reached through two
   * different call chains is two boxes, and opening one must not open the other.
   */
  expanded: Set<string>;
  /** Contents for a call's target, or null when nothing was imported for it. */
  moduleFor: (call: ArchitectureModuleCall) => NestedModuleData | null;
  /** Set while recursing; callers leave these alone. */
  basePath?: string;
  /** Module ids already on the current path, so a cycle cannot recurse. */
  visited?: Set<string>;
}

export interface ArchitectureReference {
  fromAddress: string;
  toAddress: string;
  attributes?: string[];
}

export type ArchitectureNodeType = "vpc" | "subnet" | "service" | "module";

export interface ArchitectureNode {
  /** Version this call asks for, when it differs from what was imported. */
  versionMismatch?: string;
  id: string;
  type: ArchitectureNodeType;
  label: string;
  /** The Terraform name, shown small; omitted when it adds nothing. */
  sublabel?: string;
  icon?: string;
  parentId?: string;
  /** Drawn differently: its detail lives in another repository. */
  isModuleCall?: boolean;
  /** The imported module this call resolves to, if any. */
  moduleId?: string;
  /** True when the target was imported, so opening it would show something. */
  expandable?: boolean;
  /** How many nodes appear once opened; lets the UI promise something real. */
  expandableCount?: number;
  /** Currently drawn as a frame containing the callee's own architecture. */
  expanded?: boolean;
  /** Path from the root diagram, used as the expand/collapse key. */
  path?: string;
  /** Every Terraform address folded into this node, for the detail panel. */
  addresses: string[];
}

export interface ArchitectureEdge {
  id: string;
  source: string;
  target: string;
  /**
   * The wiring resources this edge was routed through. CloudFront reaches a
   * load balancer via an `aws_cloudfront_vpc_origin`, which is not itself worth
   * a box; recording the detour keeps the shortcut explainable.
   */
  via?: string[];
}

/** Something left off the diagram, with the reason, so the UI can say which. */
export interface ArchitectureOmission {
  address: string;
  reason: "data-source" | "detail" | "unknown-type" | "unknown-module";
}

export interface ArchitectureGraph {
  nodes: ArchitectureNode[];
  edges: ArchitectureEdge[];
  /** Resources deliberately left out, so the UI can say so honestly. */
  omittedCount: number;
  /** Everything not drawn, itemised — a count alone invites suspicion. */
  omissions: ArchitectureOmission[];
  /** Types with no table entry — the diagram may be incomplete because of them. */
  unmappedTypes: string[];
}

export function resourceAddress(resource: ArchitectureResource): string {
  const base = resource.resourceName
    ? `${resource.resourceType}.${resource.resourceName}`
    : resource.resourceType;

  return resource.kind === "data" ? `data.${base}` : base;
}

export function buildArchitecture(
  resources: ArchitectureResource[],
  references: ArchitectureReference[],
  moduleCalls: ArchitectureModuleCall[] = [],
  nesting?: NestingOptions,
): ArchitectureGraph {
  const basePath = nesting?.basePath ?? "";
  const visited = nesting?.visited ?? new Set<string>();
  const inheritedEdges: ArchitectureEdge[] = [];
  // Nodes belonging to expanded callees. Kept apart from this module's own
  // nodes until the very end: the containment and `global` passes below reason
  // about *this* module's Terraform, and must not re-parent a foreign node out
  // of the frame it was just placed in.
  const adopted: ArchitectureNode[] = [];

  // Data sources describe lookups, not deployed infrastructure. None of them
  // belong on an architecture diagram.
  const managed = resources.filter((r) => r.kind !== "data");

  const byAddress = new Map<string, ArchitectureResource>();
  for (const resource of managed)
    byAddress.set(resourceAddress(resource), resource);

  const publicSubnets = findPublicSubnets(references, byAddress);

  // Which container each address sits in, resolved before nodes exist so a
  // subnet can be attached to its VPC in the same pass.
  const containerOf = new Map<string, string>();
  for (const ref of references) {
    const relation = containmentRelation(ref);
    if (!relation) continue;
    if (!byAddress.has(ref.fromAddress) || !byAddress.has(ref.toAddress))
      continue;

    // A subnet reference wins over a VPC one: something placed in a subnet is
    // in that VPC anyway, and the subnet is the more precise answer.
    const existing = containerOf.get(ref.fromAddress);
    if (existing && relation === "vpc") continue;

    containerOf.set(ref.fromAddress, ref.toAddress);
  }

  const nodes: ArchitectureNode[] = [];
  const nodeOfAddress = new Map<string, string>();
  const groupNodes = new Map<string, ArchitectureNode>();
  const unmapped = new Set<string>();
  const unrecognisedModules = new Set<string>();
  const omissions: ArchitectureOmission[] = [];

  // Data sources describe lookups, not deployed infrastructure — but they were
  // being dropped without ever being counted, which made the tally on screen
  // impossible to reconcile with the resource count.
  for (const resource of resources) {
    if (resource.kind === "data") {
      omissions.push({
        address: resourceAddress(resource),
        reason: "data-source",
      });
    }
  }

  for (const resource of managed) {
    const address = resourceAddress(resource);
    const entry = architectureEntry(resource.resourceType);

    if (!entry) {
      unmapped.add(resource.resourceType);
      omissions.push({ address, reason: "unknown-type" });
      continue;
    }
    if (entry.role === "omit") {
      omissions.push({ address, reason: "detail" });
      continue;
    }

    if (entry.group) {
      // Several Terraform resources, one box: an HTTP API is five blocks but
      // one thing on a diagram.
      const existing = groupNodes.get(entry.group);
      if (existing) {
        existing.addresses.push(address);
        nodeOfAddress.set(address, existing.id);
        continue;
      }

      const node: ArchitectureNode = {
        id: `group:${entry.group}`,
        type: "service",
        label: entry.label ?? resource.resourceType,
        icon: entry.icon,
        addresses: [address],
      };
      groupNodes.set(entry.group, node);
      nodes.push(node);
      nodeOfAddress.set(address, node.id);
      continue;
    }

    const isSubnet = resource.resourceType === "aws_subnet";
    const isPublic = isSubnet && publicSubnets.has(address);

    const node: ArchitectureNode = {
      id: address,
      type:
        entry.role === "container"
          ? resource.resourceType === "aws_vpc"
            ? "vpc"
            : "subnet"
          : "service",
      label: isSubnet
        ? isPublic
          ? "Public subnet"
          : "Private subnet"
        : (entry.label ?? resource.resourceType),
      sublabel: resource.resourceName ?? undefined,
      icon: isSubnet
        ? isPublic
          ? "subnet-public"
          : "subnet-private"
        : entry.icon,
      addresses: [address],
    };

    nodes.push(node);
    nodeOfAddress.set(address, node.id);
  }

  // Module calls, one box each. Deliberately not folded by `group` the way
  // resources are: `waf` and `waf_cdn` are two distinct web ACLs guarding
  // different things, and collapsing them would erase the very structure this
  // diagram is meant to show. A module call is already an aggregate — the unit
  // its author chose.
  for (const call of moduleCalls) {
    const address = `module.${call.name}`;
    const ref = parseModuleSourceRef(call.source);
    const entry = ref ? moduleArchitectureEntry(ref.repo) : null;

    if (entry?.role === "omit") {
      omissions.push({ address, reason: "detail" });
      continue;
    }

    const path = basePath ? `${basePath}/${address}` : address;

    // A module already on this path would recurse forever. Refusing to expand
    // it keeps the box, so the cycle stays visible instead of silently
    // vanishing from the diagram.
    const contents =
      nesting && call.moduleId && !visited.has(call.moduleId)
        ? nesting.moduleFor(call)
        : null;

    const node: ArchitectureNode = {
      id: address,
      type: "service",
      label: entry?.label ?? ref?.repo ?? call.name,
      sublabel: call.name,
      icon: entry?.icon,
      isModuleCall: true,
      moduleId: call.moduleId ?? undefined,
      path,
      addresses: [address],
    };

    if (!entry) unrecognisedModules.add(ref?.repo ?? call.name);

    if (contents && nesting) {
      const inner = buildArchitecture(
        contents.resources,
        contents.references,
        contents.moduleCalls,
        {
          ...nesting,
          basePath: path,
          visited: new Set([...visited, contents.id]),
        },
      );

      node.expandable = inner.nodes.length > 0;
      node.expandableCount = inner.nodes.length;
      if (call.requestedRef) node.versionMismatch = call.requestedRef;

      if (node.expandable && nesting?.expanded.has(path)) {
        // The tile becomes a frame around the callee's own diagram. Its label
        // switches to the repository name: inside the frame the local call name
        // is what identifies it, and the service label is now redundant with
        // the icons it contains.
        node.type = "module";
        node.expanded = true;
        node.label = ref?.repo ?? call.name;

        adoptSubgraph(inner, path, node.id, adopted, omissions, inheritedEdges);
        for (const type of inner.unmappedTypes) unmapped.add(type);
      }
    }

    nodes.push(node);
    nodeOfAddress.set(address, node.id);
  }

  const drawn = mergeWrapperDuplicates(nodes, nodeOfAddress, references);
  const nodeById = new Map(drawn.map((n) => [n.id, n]));

  for (const node of drawn) {
    // A grouped node inherits placement from whichever of its members is
    // placed; they belong to the same logical service either way.
    for (const address of node.addresses) {
      const container = containerOf.get(address);
      const parentId = container ? nodeOfAddress.get(container) : undefined;
      if (!parentId || parentId === node.id) continue;

      const parent = nodeById.get(parentId);
      // Only frames may contain things. A service referencing another service
      // through `subnet_id` is a connection, not containment.
      if (!parent || parent.type === "service") continue;

      node.parentId = parentId;
      break;
    }
  }

  // Global services keep their own frame-free placement even when they mention
  // something inside the VPC.
  for (const node of drawn) {
    if (node.type !== "service") continue;
    const entry = entryForNode(node);
    if (entry?.global) node.parentId = undefined;
  }

  return {
    // Frames must precede their contents: React Flow paints in array order.
    nodes: [...drawn, ...adopted],
    edges: [
      ...buildEdges(references, nodeOfAddress, nodeById),
      ...inheritedEdges,
    ],
    omittedCount: omissions.length,
    omissions,
    unmappedTypes: [...unmapped, ...unrecognisedModules].sort(),
  };
}

/**
 * Folds a local resource group into the module call that created the service it
 * configures.
 *
 * This is the wrapper pattern: `module "http_api"` builds the API Gateway and
 * the repository then adds its own routes, stages and mappings to it. Left
 * apart they became two boxes both labelled "API Gateway" with an arrow between
 * them, which reads as two gateways talking to each other.
 *
 * Two conditions must hold, and the second is what keeps it honest: the group
 * has to *reference* the module call, not merely resemble it. `vmland` declares
 * a log group of its own and separately calls a CloudWatch module — both are
 * "CloudWatch Logs", but they are two different log groups and stay apart
 * because neither mentions the other.
 */
function mergeWrapperDuplicates(
  nodes: ArchitectureNode[],
  nodeOfAddress: Map<string, string>,
  references: ArchitectureReference[],
): ArchitectureNode[] {
  const merged = new Set<string>();

  for (const group of nodes) {
    if (group.isModuleCall || !group.id.startsWith("group:")) continue;
    if (!group.icon) continue;

    const owned = new Set(group.addresses);
    const target = nodes.find(
      (candidate) =>
        candidate.isModuleCall &&
        // An opened module is a frame with its own contents on display; folding
        // the caller's resources into it would file them under a repository
        // that does not contain them.
        !candidate.expanded &&
        !merged.has(candidate.id) &&
        candidate.icon === group.icon &&
        references.some(
          (ref) =>
            owned.has(ref.fromAddress) &&
            ref.toAddress === candidate.addresses[0],
        ),
    );

    if (!target) continue;

    target.addresses.push(...group.addresses);
    for (const address of group.addresses)
      nodeOfAddress.set(address, target.id);
    merged.add(group.id);
  }

  return nodes.filter((node) => !merged.has(node.id));
}

/**
 * Pulls a called module's finished diagram into the caller's, under a frame.
 *
 * Every id is rewritten with the call path in front of it, because ids are only
 * unique within one module: two repositories both containing `aws_vpc.this` are
 * routine, and without the prefix the second would silently overwrite the
 * first's placement. Addresses are prefixed too, so the omission list can say
 * which module a hidden resource came from.
 */
function adoptSubgraph(
  inner: ArchitectureGraph,
  path: string,
  frameId: string,
  nodes: ArchitectureNode[],
  omissions: ArchitectureOmission[],
  inheritedEdges: ArchitectureEdge[],
): void {
  const idOf = (id: string) => `${path}/${id}`;

  for (const child of inner.nodes) {
    nodes.push({
      ...child,
      id: idOf(child.id),
      // Top-level nodes of the callee hang off the frame; deeper ones keep the
      // parent they already had, rewritten to its new id.
      parentId: child.parentId ? idOf(child.parentId) : frameId,
      addresses: child.addresses.map((address) => `${path}/${address}`),
    });
  }

  for (const edge of inner.edges) {
    inheritedEdges.push({
      ...edge,
      id: idOf(edge.id),
      source: idOf(edge.source),
      target: idOf(edge.target),
    });
  }

  for (const omission of inner.omissions) {
    omissions.push({
      ...omission,
      address: `${path}/${omission.address}`,
    });
  }
}

function entryForNode(node: ArchitectureNode) {
  const first = node.addresses[0];
  if (!first) return null;

  const type = first.startsWith("data.")
    ? first.split(".")[1]
    : first.split(".")[0];

  return type ? architectureEntry(type) : null;
}

function containmentRelation(
  ref: ArchitectureReference,
): "vpc" | "subnet" | null {
  for (const attribute of ref.attributes ?? []) {
    const relation = CONTAINMENT_ATTRIBUTES[attribute];
    if (relation) return relation;
  }

  return null;
}

/**
 * A subnet is public when traffic from it can reach an internet gateway, which
 * is a three-link chain rather than a property: the subnet is associated with a
 * route table, and that table holds a route whose target is the gateway.
 *
 * Naming would have been easier and wrong — plenty of modules call a private
 * subnet `public_db_subnet` or the reverse.
 */
function findPublicSubnets(
  references: ArchitectureReference[],
  byAddress: Map<string, ArchitectureResource>,
): Set<string> {
  const typeOf = (address: string) => byAddress.get(address)?.resourceType;

  const internetRouteTables = new Set<string>();
  for (const ref of references) {
    if (typeOf(ref.fromAddress) !== "aws_route") continue;
    if (typeOf(ref.toAddress) !== "aws_internet_gateway") continue;

    for (const other of references) {
      if (other.fromAddress !== ref.fromAddress) continue;
      if (typeOf(other.toAddress) === "aws_route_table") {
        internetRouteTables.add(other.toAddress);
      }
    }
  }

  const publicSubnets = new Set<string>();
  for (const ref of references) {
    if (typeOf(ref.fromAddress) !== "aws_route_table_association") continue;
    if (!internetRouteTables.has(ref.toAddress)) continue;

    for (const other of references) {
      if (other.fromAddress !== ref.fromAddress) continue;
      if (typeOf(other.toAddress) === "aws_subnet") {
        publicSubnets.add(other.toAddress);
      }
    }
  }

  return publicSubnets;
}

/**
 * Edges follow references between drawn things, minus the ones that only
 * restate the nesting already visible as a frame.
 *
 * References that land on an undrawn resource are followed *through* it. Much
 * of AWS is wired with small connector resources — an `aws_lb_listener` between
 * a balancer and its certificate, an `aws_cloudfront_vpc_origin` between a
 * distribution and a balancer — and each one omitted for being detail used to
 * sever the relationship it existed to express. Bridging is what turns the
 * diagram from a scatter of boxes into something that reads.
 */
/**
 * Some connectors are not *on* a path between two services, they sit beside
 * both and point at each: an `aws_wafv2_web_acl_association` names the web ACL
 * and the load balancer it guards. Walking forward from either service never
 * reaches the other, so the single most telling line on a security diagram —
 * "this WAF protects that balancer" — was missing.
 *
 * Such a connector is attributed to whichever service it belongs to, and its
 * remaining references are re-issued from there. Ownership is read from the
 * icon both resolve to, so no new table is needed: the association derives
 * `waf`, and among its targets only the WAF module does too.
 *
 * Attributing rather than simply joining the pair is what fixes the direction.
 * A bare "these two are related" edge could be drawn either way round; anchored
 * at the owner it always points outward from the thing doing the work.
 */
function attributeConnectorsToOwners(
  references: ArchitectureReference[],
  nodeOfAddress: Map<string, string>,
  nodeById: Map<string, ArchitectureNode>,
): ArchitectureReference[] {
  const ownerOf = new Map<string, string>();

  for (const ref of references) {
    const from = ref.fromAddress;
    if (nodeOfAddress.has(from) || ownerOf.has(from)) continue;

    const type = from.startsWith("data.")
      ? (from.split(".")[1] ?? "")
      : (from.split(".")[0] ?? "");
    const icon = resolveServiceIcon(type);
    if (!icon) continue;

    for (const other of references) {
      if (other.fromAddress !== from) continue;

      const nodeId = nodeOfAddress.get(other.toAddress);
      if (nodeId && nodeById.get(nodeId)?.icon === icon) {
        ownerOf.set(from, other.toAddress);
        break;
      }
    }
  }

  if (!ownerOf.size) return references;

  return references.map((ref) => {
    const owner = ownerOf.get(ref.fromAddress);
    return owner ? { ...ref, fromAddress: owner } : ref;
  });
}

function buildEdges(
  references: ArchitectureReference[],
  nodeOfAddress: Map<string, string>,
  nodeById: Map<string, ArchitectureNode>,
): ArchitectureEdge[] {
  const rewritten = attributeConnectorsToOwners(
    references,
    nodeOfAddress,
    nodeById,
  );

  const outgoing = new Map<string, ArchitectureReference[]>();
  for (const ref of rewritten) {
    if (containmentRelation(ref)) continue;
    const list = outgoing.get(ref.fromAddress);
    if (list) list.push(ref);
    else outgoing.set(ref.fromAddress, [ref]);
  }

  const seen = new Set<string>();
  const edges: ArchitectureEdge[] = [];
  // An expanded module call stays a valid endpoint even though it is drawn as a
  // frame: "the endpoint module needs the VPC module" is exactly the sentence
  // the diagram exists to convey, and opening the box must not delete it. A VPC
  // or subnet frame is different — an arrow into the side of it says nothing
  // that the nesting does not already show.
  const canConnect = (id: string) => {
    const type = nodeById.get(id)?.type;
    return type === "service" || type === "module";
  };

  for (const from of nodeOfAddress.keys()) {
    const source = nodeOfAddress.get(from);
    if (!source || !canConnect(source)) continue;

    for (const [to, via] of reachableDrawnTargets(
      from,
      outgoing,
      nodeOfAddress,
    )) {
      const target = nodeOfAddress.get(to);
      if (!target || target === source || !canConnect(target)) continue;

      const id = `${source}->${target}`;
      if (seen.has(id)) continue;

      seen.add(id);
      edges.push(
        via.length ? { id, source, target, via } : { id, source, target },
      );
    }
  }

  return edges;
}

/**
 * Walks forward from one address, passing through undrawn resources only, and
 * reports every drawn address it arrives at together with the detour taken.
 *
 * Hops are capped because chains of connectors can be long and each extra link
 * weakens the claim that the two ends are meaningfully related. Three covers
 * the real patterns (distribution -> origin -> balancer) without inventing
 * relationships out of coincidence.
 */
const MAX_BRIDGE_HOPS = 3;

function reachableDrawnTargets(
  start: string,
  outgoing: Map<string, ArchitectureReference[]>,
  nodeOfAddress: Map<string, string>,
): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const visited = new Set<string>([start]);
  let frontier: Array<{ address: string; via: string[] }> = [
    { address: start, via: [] },
  ];

  for (let hop = 0; hop < MAX_BRIDGE_HOPS && frontier.length; hop++) {
    const next: Array<{ address: string; via: string[] }> = [];

    for (const { address, via } of frontier) {
      for (const ref of outgoing.get(address) ?? []) {
        const to = ref.toAddress;
        if (visited.has(to)) continue;
        visited.add(to);

        if (nodeOfAddress.has(to)) {
          if (!found.has(to)) found.set(to, via);
          continue;
        }

        // Undrawn: keep walking, remembering what was passed through.
        next.push({ address: to, via: [...via, to] });
      }
    }

    frontier = next;
  }

  return found;
}
