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
  VPC_SCOPED_ATTRIBUTES,
} from "./aws-architecture";
import { iconOfService, serviceOfResource } from "./aws-services";
import {
  createScope,
  type EvaluationScope,
  type EvaluationVariable,
  evaluateExpression,
  resolveInstances,
  resolveMultiplicity,
  withIndex,
} from "./evaluate";
import { parseModuleSourceRef } from "./module-link";
import { meaningfulResourceName } from "./resource-label";

export interface ArchitectureResource {
  resourceType: string;
  resourceName: string | null;
  kind: string;
  /**
   * Only read to name the service a supporting resource belongs to, and only
   * consulted for types that are not `aws_*`. Optional so a caller with less
   * than the full DTO — the nested architecture endpoint, a test — still fits.
   */
  providerName?: string | null;
  /**
   * The `count`/`for_each` expression guarding the block, when there is one.
   *
   * Optional, and null on anything imported before it was recorded — which is
   * why its absence has to mean "unconditional", the behaviour those modules
   * were already drawn with.
   */
  conditionalOn?: string | null;
  /**
   * The `availability_zone` argument, as written. Names the instances of a
   * multi-instance container; see {@link ArchitectureNode.availabilityZone}.
   */
  availabilityZone?: string | null;
}

/** How a subnet reaches an internet gateway, and whether that is guaranteed. */
interface PublicRoute {
  /** The expression the path depends on, or null when it always exists. */
  conditionalOn: string | null;
}

/**
 * A `module "name" { source = … }` block. For wrapper repositories these carry
 * the entire architecture, so they are drawn alongside plain resources.
 */
export interface ArchitectureModuleCall {
  name: string;
  source: string;
  /**
   * `registry`, `git` or `local`, as recorded at import.
   *
   * Needed because a registry address means something different from a Git URL:
   * `terraform-aws-modules/kms/aws` names the *provider* last, not the module,
   * so reading its final segment as the repository produced a box labelled
   * "aws" with no icon. {@link parseModuleSourceRef} can only tell the two
   * apart when it is told which it is looking at.
   */
  sourceKind?: string | null;
  /** Set when the call resolves to a module the user has imported. */
  moduleId?: string | null;
  /**
   * The ref this call pins, when the imported copy is a different version.
   * Carried here rather than rebuilt from paths in the UI, because only the
   * builder knows which call produced which box.
   */
  requestedRef?: string | null;
  /**
   * Every argument this call sets, as written — and *every* one, not a subset.
   *
   * Completeness is the whole contract. Knowing the full argument list is what
   * makes "not set here, so it takes its default" a sound inference, and that
   * inference is what lets a block be declared absent. A partial list would
   * quietly erase infrastructure that exists, so a caller that cannot supply all
   * of them must supply none.
   */
  arguments?: Readonly<Record<string, string>>;
}

/** One `output` block of a called module, as far as placement is concerned. */
export interface ArchitectureModuleOutput {
  name: string;
  /** The expression as written, e.g. `aws_subnet.public[*].id`. */
  valueExpression: string | null;
}

/** A called module's own contents, needed to draw it expanded. */
export interface NestedModuleData {
  id: string;
  name: string;
  versionTag: string | null;
  resources: ArchitectureResource[];
  references: ArchitectureReference[];
  moduleCalls: ArchitectureModuleCall[];
  /**
   * The module's outputs, so a caller wired to one of them can be drawn in the
   * right place. Optional: without them a caller still lands in the module's
   * VPC, just not in a particular subnet.
   */
  outputs?: ArchitectureModuleOutput[];
  /**
   * Declared variables and locals, so this module's `count` guards can be
   * resolved against the arguments its caller passed. Optional, and absent on
   * anything imported before they were recorded — in which case every guard
   * reads as unknown and the module is drawn in full, as it always was.
   */
  variables?: EvaluationVariable[];
  locals?: { name: string; expression: string | null }[];
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
  /**
   * When the target is a module call: the outputs of it this reference reads.
   *
   * Only the project level can supply these — it parses the expression itself
   * and knows that `subnet_id = module.vpc.public_subnets[0]` reads
   * `public_subnets`, element zero. The stored module references keep the
   * attribute but not the output, so a nested module call falls back to a coarser
   * placement.
   *
   * The index is what makes per-instance frames worth drawing: without it a box
   * wired to one of two subnets can only be put in the first by convention, and
   * with it the placement is read out of the code.
   */
  outputs?: Array<{ name: string; index?: number }>;
}

export type ArchitectureNodeType = "vpc" | "subnet" | "service" | "module";

/**
 * Resources that serve a drawn box without being one themselves, gathered under
 * the service they belong to.
 *
 * This is the answer to the question the diagram otherwise leaves hanging. A
 * Step Functions module declares fifteen resources and draws two; thirteen of
 * them are one IAM role with five policies and their attachments. Those thirteen
 * are not thirteen things on an architecture diagram — an IAM role is a property
 * of the state machine, not a component traffic flows through, and giving it a
 * box of its own would put the same box in every module, wired to everything and
 * explaining nothing.
 *
 * So they are attributed instead of drawn: the state machine carries them, says
 * how many there are, and lists them when asked.
 */
export interface ArchitectureAttachment {
  /** As a person names it — "IAM", "KMS" — from `serviceOfResource`. */
  service: string;
  icon?: string;
  addresses: string[];
  /**
   * Another drawn box claims at least one of these too. A role used by two
   * Lambdas genuinely belongs to both, and saying so is better than picking one.
   */
  shared?: boolean;
}

export interface ArchitectureNode {
  /** Version this call asks for, when it differs from what was imported. */
  versionMismatch?: string;
  id: string;
  type: ArchitectureNodeType;
  label: string;
  /** The Terraform name, shown small; omitted when it adds nothing. */
  sublabel?: string;
  icon?: string;
  /**
   * On a public subnet whose route to the internet gateway is behind a `count`
   * or `for_each`: the expression it depends on.
   *
   * Information, not a reclassification. The subnet is still drawn public,
   * because the code does route it out; this is what a reader needs in order to
   * check whether their own inputs actually switch that route on.
   */
  publicRouteCondition?: string;
  /**
   * Which instance of its Terraform block this frame is, when the block makes
   * more than one.
   *
   * A `count = 2` subnet is two subnets in two availability zones, and they are
   * two different places: the box wired to `public_subnets[0]` is in the first and
   * not the second. One frame could not express that, so a resolved multiplicity
   * becomes one frame per instance and this says which.
   *
   * `addresses` deliberately stays the undecorated block address on every
   * instance. Both frames are that one declaration, the detail panel should say
   * so, and everything else in the builder keys off addresses and would have had
   * to learn about indices for no gain.
   */
  instanceIndex?: number;
  /**
   * How many instances the block makes.
   *
   * Set alongside `instanceIndex` on a split frame, and *without* it on a
   * collapsed one — a single frame standing for all N instances still has to say
   * that it is N of them.
   */
  instanceCount?: number;
  /** The zone this instance is in, once resolved. What makes two frames legible. */
  availabilityZone?: string;
  /**
   * Every zone a collapsed frame covers, in instance order.
   *
   * The instances of one subnet block differ by zone and by nothing else. When no
   * box is pinned to a particular one, drawing three frames draws a distinction
   * the code does not make: the reader sees two empty boxes and concludes the
   * workload runs in one zone, which is the opposite of what a three-zone subnet
   * means. So they collapse into one frame that names all three.
   */
  availabilityZones?: string[];
  /**
   * The block's own name, kept so a collapsed frame can be relabelled.
   *
   * Carried rather than parsed back out of `sublabel`: the collapse happens in a
   * later pass with no access to the resource, and recovering a name by splitting
   * a string we formatted ourselves is the kind of coupling that survives exactly
   * until somebody changes the separator.
   */
  instanceName?: string;
  /**
   * The one zone this box is pinned to, when its wiring names a single subnet.
   *
   * Absent is the common case and means the box covers its whole tier:
   * `subnet_ids = module.vpc.private_subnets` puts a service in all three private
   * subnets, and the frame it sits in already says how many there are. Present is
   * the exception worth marking — `single_nat_gateway = true` yields one NAT in
   * the first public subnet, and a reader looking at a three-zone tier has no way
   * to know that without being told.
   */
  zone?: string;
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
  /**
   * Undrawn resources serving this box, by service. Ordered by size, so the
   * first entry is the one worth putting on the tile.
   */
  attachments?: ArchitectureAttachment[];
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
  reason:
    | "data-source"
    | "detail"
    | "unknown-type"
    | "unknown-module"
    /** Declared, but its `count`/`for_each` resolves to nothing under these inputs. */
    | "not-created";
  /**
   * Carried rather than parsed back out of `address`, because the address of a
   * resource inside a nested module has the call path in front of it and the
   * type is no longer its first segment.
   */
  resourceType?: string;
  providerName?: string | null;
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
  scope?: EvaluationScope,
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
  const declared = resources.filter((r) => r.kind !== "data");

  /**
   * Blocks whose `count` or `for_each` is known to produce nothing.
   *
   * Only ever populated when a scope is available, and a scope is only available
   * when the whole argument list is — see `ArchitectureModuleCall.arguments`. The
   * evaluator answers "unknown" for anything it cannot settle, and unknown keeps
   * the block, so the untouched path stays exactly what it was.
   */
  const absent = new Set<string>();
  if (scope) {
    for (const resource of declared) {
      if (resolveMultiplicity(resource.conditionalOn, scope) === "absent")
        absent.add(resourceAddress(resource));
    }
  }

  const managed = absent.size
    ? declared.filter((r) => !absent.has(resourceAddress(r)))
    : declared;

  const byAddress = new Map<string, ArchitectureResource>();
  for (const resource of managed)
    byAddress.set(resourceAddress(resource), resource);

  /**
   * Only references between blocks that exist.
   *
   * This is what makes a resolved guard reclassify a subnet rather than merely
   * hide a box. The database subnet reads as public because
   * `aws_route.database_internet_gateway` routes it to the gateway — a route
   * behind `var.create_database_internet_gateway_route`, which defaults to false.
   * Drop the route and the chain `subnet -> route table -> route -> gateway`
   * breaks on its own, without `findPublicSubnets` knowing anything about
   * evaluation.
   */
  const live = absent.size
    ? references.filter(
        (ref) => !absent.has(ref.fromAddress) && !absent.has(ref.toAddress),
      )
    : references;

  const publicSubnets = findPublicSubnets(live, byAddress);

  /**
   * How good a candidate container is, judged by what it *is* rather than by
   * which attribute named it.
   *
   *   2  a subnet — the most precise answer, and anything in a subnet is in that
   *      subnet's VPC anyway
   *   1  a VPC
   *   0  anything else, which cannot contain a box no matter what named it
   *
   * Read from the architecture table rather than hardcoded, so a container type
   * added there is understood here without a second edit.
   */
  const frameRank = (address: string): 0 | 1 | 2 => {
    const resource = byAddress.get(address);
    if (!resource) return 0;
    if (architectureEntry(resource.resourceType)?.role !== "container")
      return 0;
    return resource.resourceType === "aws_subnet" ? 2 : 1;
  };

  /**
   * Containment targets per address, before nodes exist so a subnet can be
   * attached to its VPC in the same pass.
   *
   * Ranked rather than first-one-wins, and this is a fix rather than a
   * refinement. A real module reaches its VPC through a local:
   *
   *   locals { vpc_id = try(aws_vpc_ipv4_cidr_block_association.this[0].vpc_id,
   *                         aws_vpc.this[0].id, "") }
   *
   * so the analyser records `aws_subnet.public -> aws_vpc.this` *and*
   * `aws_subnet.public -> aws_vpc_ipv4_cidr_block_association.this`, both through
   * `vpc_id`. Keeping whichever arrived first made the placement depend on the
   * order Postgres returned the rows — and for the upstream VPC module it picked
   * the association, which is not drawn, so all seven subnets were rendered
   * outside the VPC frame they belong to.
   */
  const containerOf = new Map<string, string>();
  const containerRank = new Map<string, number>();

  for (const ref of live) {
    if (!containmentRelation(ref)) continue;
    if (!byAddress.has(ref.fromAddress) || !byAddress.has(ref.toAddress))
      continue;

    const rank = frameRank(ref.toAddress);
    const best = containerRank.get(ref.fromAddress) ?? -1;

    // Ties are broken by address so the result cannot depend on row order: two
    // subnets are never both the container, but a module with two VPCs would
    // otherwise draw differently on every request.
    const current = containerOf.get(ref.fromAddress);
    if (
      rank < best ||
      (rank === best && current !== undefined && current <= ref.toAddress)
    ) {
      continue;
    }

    containerOf.set(ref.fromAddress, ref.toAddress);
    containerRank.set(ref.fromAddress, rank);
  }

  /**
   * Containment that runs through something we do not draw.
   *
   * When the only container an address names is not a frame — the association
   * above, a `vpc_endpoint`, a resource the table omits — that intermediary
   * usually names the real frame itself. Following it one hop recovers the
   * placement instead of dropping the box out of every frame.
   *
   * Bounded and visited-guarded: `try()` chains can be several deep and a
   * malformed module could name itself.
   */
  for (const [address, target] of [...containerOf.entries()]) {
    if (frameRank(target) > 0) continue;

    const seen = new Set<string>([address, target]);
    let next = containerOf.get(target);
    let hops = 0;

    while (next && hops < 4) {
      if (frameRank(next) > 0) {
        containerOf.set(address, next);
        containerRank.set(address, frameRank(next));
        break;
      }
      if (seen.has(next)) break;
      seen.add(next);
      next = containerOf.get(next);
      hops += 1;
    }
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
        resourceType: resource.resourceType,
        providerName: resource.providerName,
      });
    }
  }

  // Declared but switched off by the inputs in force here. A different reason
  // from `detail` because it is a different statement: not "this is too small to
  // draw" but "this configuration does not create it".
  for (const resource of declared) {
    const address = resourceAddress(resource);
    if (!absent.has(address)) continue;

    omissions.push({
      address,
      reason: "not-created",
      resourceType: resource.resourceType,
      providerName: resource.providerName,
    });
  }

  for (const resource of managed) {
    const address = resourceAddress(resource);
    const entry = architectureEntry(resource.resourceType);

    const provenance = {
      resourceType: resource.resourceType,
      providerName: resource.providerName,
    };

    if (!entry) {
      unmapped.add(resource.resourceType);
      omissions.push({ address, reason: "unknown-type", ...provenance });
      continue;
    }
    if (entry.role === "omit") {
      omissions.push({ address, reason: "detail", ...provenance });
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
    const publicRoute = isSubnet ? publicSubnets.get(address) : undefined;
    const isPublic = publicRoute !== undefined;

    /**
     * The condition the route out depends on, when there is one — reported, not
     * acted on.
     *
     * Drawing such a subnet as private was tried and was worse. In a real module
     * essentially every block is guarded: the upstream VPC module wraps all 84 of
     * them in `local.create_vpc ? … : 0`, and the *public* subnet's own route
     * carries `local.create_public_subnets && var.create_igw`. Reclassifying on
     * the presence of a guard therefore turned the one subnet everybody knows is
     * public into a private one.
     *
     * Telling "opt-in" from "on by default" needs the defaults of every variable
     * and local in the expression evaluated — a Terraform interpreter, not a
     * heuristic. Until that exists the honest move is to draw what the code says
     * and hand the reader the condition.
     */
    const publicRouteCondition = publicRoute?.conditionalOn ?? null;

    const isContainer = entry.role === "container";

    const template: ArchitectureNode = {
      id: address,
      type: isContainer
        ? resource.resourceType === "aws_vpc"
          ? "vpc"
          : "subnet"
        : "service",
      label: isSubnet
        ? isPublic
          ? "Public subnet"
          : "Private subnet"
        : (entry.label ?? resource.resourceType),
      ...(publicRouteCondition ? { publicRouteCondition } : {}),
      // `this` and `current` are conventions meaning "the only one", so they
      // filled the second line of a tile with a word that told the reader
      // nothing. Omitted rather than shown small.
      sublabel: meaningfulResourceName(resource.resourceName),
      icon: isSubnet
        ? isPublic
          ? "subnet-public"
          : "subnet-private"
        : entry.icon,
      addresses: [address],
    };

    /**
     * One frame per instance, for containers only.
     *
     * A container is a *place*, and its multiplicity is therefore structural: two
     * public subnets are two places, and which of them holds the instance wired
     * to `public_subnets[0]` is a fact the diagram should be able to state. A
     * service's multiplicity is a quantity in one place, which needs no second box
     * to be understood — and giving it one would double every edge it has.
     */
    const instances =
      isContainer && scope ? instanceFrames(resource, scope) : null;

    if (!instances) {
      // Nothing resolved the count — no inputs to resolve it with, or a guard the
      // evaluator cannot settle. The expression still says something the frame
      // would otherwise leave out entirely; see `declaredSpread`.
      const spread = declaredSpread(resource);
      if (spread) {
        template.sublabel = template.sublabel
          ? `${template.sublabel} · ${spread}`
          : spread;
      }

      nodes.push(template);
      nodeOfAddress.set(address, template.id);
      continue;
    }

    for (const instance of instances) {
      nodes.push({ ...template, ...instance });
    }

    /**
     * The first instance is what an address resolves to.
     *
     * Everything else in the builder — containment, edges, attachments — reasons
     * about declarations rather than instances, and pointing an address at
     * instance zero keeps all of it working unchanged. The places that do need
     * instances recover them by grouping nodes on their shared address, which is
     * the same fact without a second index to keep in step.
     *
     * The consequence, stated plainly: a resource placed inside a multi-instance
     * subnet by a reference within its own module lands in the first zone. Which
     * zone it is really in is written as `element(aws_subnet.public[*].id,
     * count.index)`, an expression the analyser does not keep, so the alternative
     * is not a better zone but no subnet at all.
     */
    const first = instances[0];
    if (first) nodeOfAddress.set(address, first.id);
  }

  // What each expanded module call offers as a place to sit. Filled in as the
  // calls are expanded below and read afterwards, once every frame exists.
  const exposed = new Map<string, ExposedFrames>();

  // Module calls, one box each. Deliberately not folded by `group` the way
  // resources are: `waf` and `waf_cdn` are two distinct web ACLs guarding
  // different things, and collapsing them would erase the very structure this
  // diagram is meant to show. A module call is already an aggregate — the unit
  // its author chose.
  for (const call of moduleCalls) {
    const address = `module.${call.name}`;
    const ref = parseModuleSourceRef(call.source, call.sourceKind);
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
        calleeScope(scope, call, contents),
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

        // Prefixed with this one call, not the whole path; see `adoptSubgraph`.
        adoptSubgraph(
          inner,
          address,
          node.id,
          adopted,
          omissions,
          inheritedEdges,
        );
        for (const type of inner.unmappedTypes) unmapped.add(type);

        // Recorded against the call address, which is what the caller's own
        // references name — the path prefix is an implementation detail of the
        // adopted ids and nobody outside knows it.
        exposed.set(
          address,
          exposedFrames(
            inner,
            contents.outputs ?? [],
            contents.references,
            address,
          ),
        );
      }
    }

    nodes.push(node);
    nodeOfAddress.set(address, node.id);
  }

  /**
   * Last resort: draw the module coarsely rather than not at all.
   *
   * `ARCHITECTURE_MAP` is a curated table and the AWS provider adds resources
   * faster than anyone maintains one, so a module built entirely from types the
   * table has not reached drew nothing — and said so in a way that read as "this
   * module contains no infrastructure". The App Runner, AppSync, EMR, MemoryDB,
   * Grafana and DMS modules were all in that state: every one of them declares
   * the service it is named after, and every one of them showed an empty canvas.
   *
   * The curation exists to stop supporting detail from crowding out services.
   * When there are no services on the canvas, nothing is being crowded — so the
   * argument for withholding does not apply, and one box per service is strictly
   * better than a blank page. Both tiers are gated on the canvas being empty,
   * which is why a VPC module's forty route tables and security groups still stay
   * off the diagram: that module has real boxes to protect.
   *
   * Ordered: unclassified types first, since "we have no opinion" is a weaker
   * reason to hide something than "this is supporting detail". Only if that still
   * yields nothing are the deliberate omissions promoted, which is what gives a
   * dedicated ACM or IAM module a diagram of its own.
   */
  if (nodes.length === 0) {
    promoteToServiceBoxes("unknown-type", omissions, nodes, nodeOfAddress);
  }
  if (nodes.length === 0) {
    promoteToServiceBoxes("detail", omissions, nodes, nodeOfAddress);
  }

  const drawn = mergeWrapperDuplicates(nodes, nodeOfAddress, live);
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

  // Anything still homeless whose network lives in a module: the EC2 box wired
  // to `module.vpc.public_subnets[0]` goes inside that subnet, not beside it.
  placeAcrossModules(drawn, adopted, live, exposed);

  // Only this module's own nodes: an adopted one already had its supporting
  // resources attributed inside the recursive call, against that module's
  // Terraform rather than this one's.
  attachSupportingResources(drawn, byAddress, nodeOfAddress, live);

  /**
   * Last, and only at the outermost level.
   *
   * Last because it re-parents: everything placed in any instance has to have been
   * placed first. Outermost only because a nested call builds the frames its caller
   * then pins boxes into — folding them on the way up would take away the very
   * instances the caller is about to subscript.
   */
  const laid =
    basePath === ""
      ? collapseZoneInstances([...drawn, ...adopted])
      : [...drawn, ...adopted];

  return {
    nodes: framesBeforeContents(laid),
    edges: [...buildEdges(live, nodeOfAddress, nodeById), ...inheritedEdges],
    omittedCount: omissions.length,
    omissions,
    unmappedTypes: [...unmapped, ...unrecognisedModules].sort(),
  };
}

/**
 * Folds a block's per-zone frames into the one tier they are.
 *
 * The instances of a subnet block differ by availability zone and by nothing
 * else, and a tier is what a reader is looking for: the public subnets, the
 * private ones, the database ones. Drawing three frames per tier answers a
 * question nobody asked and loses the one they did.
 *
 * The real project this was built against settles it. Four tiers of three zones,
 * and every box wired to a whole tier — an ALB across `public_subnets`, Fargate
 * tasks across `private_subnets`, RDS through a subnet group spanning all three,
 * the same for ElastiCache. Twelve frames, of which exactly one held anything: the
 * single NAT gateway pinned to the first public subnet. Eleven empty boxes, and
 * the four facts that matter — which tier each service is in — nowhere to be seen.
 *
 * So the tier becomes one frame saying `×3` and naming its zones, everything that
 * was in any instance is re-parented onto it, and the exception keeps its detail:
 * a box that named one subnet carries `zone`, which is how the NAT still says it
 * is only in `eu-central-1a`.
 */
function collapseZoneInstances(nodes: ArchitectureNode[]): ArchitectureNode[] {
  const groups = new Map<string, ArchitectureNode[]>();

  for (const node of nodes) {
    if (node.instanceIndex === undefined) continue;
    // Instances of one block share their address; the id carries the index.
    const key = node.addresses[0] ?? node.id;
    const group = groups.get(key);
    if (group) group.push(node);
    else groups.set(key, [node]);
  }

  if (groups.size === 0) return nodes;

  /** Dropped frame to the one that absorbed it, for re-parenting. */
  const absorbed = new Map<string, string>();

  for (const group of groups.values()) {
    if (group.length < 2) continue;

    group.sort((a, b) => (a.instanceIndex ?? 0) - (b.instanceIndex ?? 0));

    const [keep, ...rest] = group;
    if (!keep) continue;

    const zones = group
      .map((frame) => frame.availabilityZone)
      .filter((zone): zone is string => zone !== undefined);

    for (const frame of rest) absorbed.set(frame.id, keep.id);

    // `instanceIndex` goes and `instanceCount` stays: this frame is no longer one
    // place among several, but it is still three subnets, and the count is the
    // whole point of the label.
    keep.instanceIndex = undefined;
    keep.instanceCount = group.length;
    keep.availabilityZone = undefined;
    if (zones.length) keep.availabilityZones = zones;

    const detail = [
      `×${group.length}`,
      zones.length ? compressZones(zones) : null,
    ]
      .filter((part): part is string => part !== null)
      .join(" · ");

    keep.sublabel = keep.instanceName
      ? `${keep.instanceName} · ${detail}`
      : detail;
  }

  if (absorbed.size === 0) return nodes;

  for (const node of nodes) {
    const moved = node.parentId ? absorbed.get(node.parentId) : undefined;
    if (moved) node.parentId = moved;
  }

  return nodes.filter((node) => !absorbed.has(node.id));
}

/**
 * Zone names as a person would read three of them: `eu-central-1a/b/c`.
 *
 * Written out in full they are 42 characters of near-identical text, and the
 * frame has to be wide enough for its own label — so the honest list would widen
 * every collapsed subnet past the width of its contents for no information. The
 * shared prefix is stated once; only the part that differs is repeated.
 *
 * Falls back to a plain list when they share nothing, which is what a
 * multi-region layout would look like and is worth showing as the oddity it is.
 */
function compressZones(zones: string[]): string {
  const unique = [...new Set(zones)];
  if (unique.length < 2) return unique[0] ?? "";

  const first = unique[0] ?? "";
  let shared = 0;
  while (
    shared < first.length &&
    unique.every((zone) => zone[shared] === first[shared])
  ) {
    shared += 1;
  }

  // A prefix worth collapsing has to leave something behind on every entry.
  if (shared === 0 || unique.some((zone) => zone.length <= shared)) {
    return unique.join(", ");
  }

  return `${first}${unique
    .slice(1)
    .map((zone) => zone.slice(shared))
    .map((suffix) => `/${suffix}`)
    .join("")}`;
}

/**
 * Turns omitted resources into one box per AWS service.
 *
 * Coarser than a curated entry on purpose: it has no opinion about which
 * resource is the subject and which serves it, so it groups by the only thing it
 * can derive — the service the type belongs to. `aws_appsync_graphql_api`, its
 * resolvers and its data sources become one "AppSync ×8" box rather than eight.
 * That is the same answer the curated table gives for API Gateway, arrived at
 * without knowing anything about AppSync.
 *
 * The promoted resources stop being omissions, because they are now drawn.
 * `unmappedTypes` deliberately still lists them: they remain absent from the
 * table, and that is the signal for whoever extends it next.
 */
function promoteToServiceBoxes(
  reason: ArchitectureOmission["reason"],
  omissions: ArchitectureOmission[],
  nodes: ArchitectureNode[],
  nodeOfAddress: Map<string, string>,
): void {
  const byService = new Map<string, string[]>();
  const consumed = new Set<string>();

  for (const omission of omissions) {
    // Module calls carry no resource type and already have a box of their own.
    if (omission.reason !== reason || !omission.resourceType) continue;

    const service = serviceOfResource(
      omission.resourceType,
      omission.providerName ?? "",
    );

    const list = byService.get(service);
    if (list) list.push(omission.address);
    else byService.set(service, [omission.address]);

    consumed.add(omission.address);
  }

  if (consumed.size === 0) return;

  const promoted = [...byService.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  );

  for (const [service, addresses] of promoted) {
    // Namespaced so it cannot collide with a resource address or a `group:` id.
    const id = `service:${service.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

    nodes.push({
      id,
      type: "service",
      label: service,
      icon: iconOfService(service),
      addresses: [...addresses].sort((a, b) =>
        a.localeCompare(b, "en", { numeric: true }),
      ),
    });

    for (const address of addresses) nodeOfAddress.set(address, id);
  }

  const kept = omissions.filter((entry) => !consumed.has(entry.address));
  omissions.length = 0;
  omissions.push(...kept);
}

/**
 * How far a supporting resource may sit from the box that owns it.
 *
 * IAM sets the bar and needs three: a state machine names a role, an attachment
 * names that role *and* a policy, so the policy is two links out and its own
 * attachment one. Four allows a single further indirection; past that the walk
 * has stopped describing one service's wiring.
 */
const MAX_ATTACHMENT_HOPS = 4;

/**
 * Works out which undrawn resources serve which drawn box, and records them on
 * the node.
 *
 * Two decisions carry this, and both were arrived at by being wrong first.
 *
 * **The walk is undirected.** Following references forwards reaches the IAM role
 * — a state machine names it through `role_arn` — and stops, because a policy
 * attachment points *at* the role rather than being pointed at by it. Reference
 * direction says which resource mentions which; it says nothing about ownership,
 * so nothing about ownership can be read out of it.
 *
 * **The nearest box wins.** An undirected walk that simply collects everything
 * it can reach does the right thing for a Step Functions module and something
 * useless for a VPC: route tables, security groups and NACLs form one connected
 * mass that every subnet and gateway can reach, so all fourteen boxes claimed
 * the same forty-eight resources and every badge on the diagram read the same
 * number. Distance breaks that, and breaks it correctly — a route table names
 * the VPC directly and is two links from any subnet, so the VPC owns it, which
 * is also the answer a person would give. Ties are kept as ties: one role used
 * by two ECS services is one link from each and is listed under both, marked
 * `shared`, because picking a winner there would be arbitrary.
 *
 * Drawn resources are walls — reaching one ends the branch, since it has a box
 * of its own and speaks for itself. Data sources are never traversed:
 * `data.aws_region.current` is referenced by half a module and going through it
 * would join every service to every other. They are counted as omissions
 * instead, which is where they belong.
 */
function attachSupportingResources(
  nodes: ArchitectureNode[],
  byAddress: Map<string, ArchitectureResource>,
  nodeOfAddress: Map<string, string>,
  references: ArchitectureReference[],
): void {
  const neighbours = new Map<string, string[]>();
  const link = (from: string, to: string) => {
    const list = neighbours.get(from);
    if (list) list.push(to);
    else neighbours.set(from, [to]);
  };

  for (const ref of references) {
    // `byAddress` holds managed resources only, which is also what keeps data
    // sources out of the walk.
    if (!byAddress.has(ref.fromAddress) || !byAddress.has(ref.toAddress))
      continue;

    link(ref.fromAddress, ref.toAddress);
    link(ref.toAddress, ref.fromAddress);
  }

  /** Distance of the closest box, so a later, further one cannot claim it. */
  const distance = new Map<string, number>();
  /** Every box tied at that distance. */
  const owners = new Map<string, Set<string>>();
  const expanded = new Set<string>();

  // All boxes advance together, one ring at a time. Running them one after
  // another would let whichever happened to be first claim a resource that a
  // later box sits closer to.
  let frontier = nodes.flatMap((node) =>
    node.addresses
      .filter((address) => byAddress.has(address))
      .map((address) => ({ address, nodeId: node.id })),
  );

  for (let hop = 1; hop <= MAX_ATTACHMENT_HOPS && frontier.length; hop++) {
    const next: { address: string; nodeId: string }[] = [];

    for (const { address, nodeId } of frontier) {
      for (const neighbour of neighbours.get(address) ?? []) {
        if (nodeOfAddress.has(neighbour)) continue;

        const best = distance.get(neighbour);
        if (best !== undefined && best < hop) continue;

        if (best === undefined) {
          distance.set(neighbour, hop);
          owners.set(neighbour, new Set([nodeId]));
        } else {
          owners.get(neighbour)?.add(nodeId);
        }

        // Guards the ring order: without it a resource reached by two boxes at
        // the same distance would be expanded twice and the pair could ping-pong.
        const key = `${nodeId}\u0000${neighbour}`;
        if (expanded.has(key)) continue;
        expanded.add(key);

        next.push({ address: neighbour, nodeId });
      }
    }

    frontier = next;
  }

  const claimed = new Map<string, string[]>();
  for (const [address, nodeIds] of owners) {
    for (const nodeId of nodeIds) {
      const list = claimed.get(nodeId);
      if (list) list.push(address);
      else claimed.set(nodeId, [address]);
    }
  }

  for (const node of nodes) {
    const addresses = claimed.get(node.id);
    if (!addresses?.length) continue;

    const byService = new Map<string, string[]>();
    for (const address of addresses) {
      const resource = byAddress.get(address);
      if (!resource) continue;

      const service = serviceOfResource(
        resource.resourceType,
        resource.providerName ?? "",
      );
      const list = byService.get(service);
      if (list) list.push(address);
      else byService.set(service, [address]);
    }

    node.attachments = [...byService.entries()]
      .map(([service, group]) => {
        group.sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
        const shared = group.some(
          (address) => (owners.get(address)?.size ?? 1) > 1,
        );

        return shared
          ? { service, icon: iconOfService(service), addresses: group, shared }
          : { service, icon: iconOfService(service), addresses: group };
      })
      // Largest first: the badge names as many services as fit and then counts
      // the rest, so this decides which ones a reader sees named.
      .sort(
        (a, b) =>
          b.addresses.length - a.addresses.length ||
          a.service.localeCompare(b.service),
      );
  }
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
 * Every id is rewritten with the call in front of it, because ids are only unique
 * within one module: two repositories both containing `aws_vpc.this` are routine,
 * and without the prefix the second would silently overwrite the first's
 * placement. Addresses are prefixed too, so the omission list can say which
 * module a hidden resource came from.
 *
 * The prefix is one call — `module.service` — and not the path from the root.
 * That distinction only became visible once relative sources started resolving
 * and a module could be expanded two levels deep: the callee had already prefixed
 * its own adopted nodes, so prefixing again with the full path produced
 * `module.service/module.service/module.container_definition/…`. Composing one
 * segment per level is what makes the result a path rather than a path with the
 * middle repeated.
 */
function adoptSubgraph(
  inner: ArchitectureGraph,
  call: string,
  frameId: string,
  nodes: ArchitectureNode[],
  omissions: ArchitectureOmission[],
  inheritedEdges: ArchitectureEdge[],
): void {
  const idOf = (id: string) => `${call}/${id}`;

  for (const child of inner.nodes) {
    nodes.push({
      ...child,
      id: idOf(child.id),
      // Top-level nodes of the callee hang off the frame; deeper ones keep the
      // parent they already had, rewritten to its new id.
      parentId: child.parentId ? idOf(child.parentId) : frameId,
      addresses: child.addresses.map(idOf),
      // Prefixed for the same reason as the addresses above: the panel resolves
      // these back to a resource by walking the call path, and an unprefixed
      // `aws_iam_role.this` would be looked up in the wrong repository.
      attachments: child.attachments?.map((attachment) => ({
        ...attachment,
        addresses: attachment.addresses.map(idOf),
      })),
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
    omissions.push({ ...omission, address: idOf(omission.address) });
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

/**
 * What a block's own expressions say about its multiplicity, when nothing
 * resolved it.
 *
 * The module pages are the case this exists for. A module viewed on its own has no
 * caller, so there are no inputs and no scope — and giving it one built from its
 * own defaults would be worse than nothing: the upstream VPC module defaults every
 * subnet list to `[]` and `enable_nat_gateway` to false, so every subnet, the NAT
 * and the subnet group evaluate to zero instances. The page would show one empty
 * VPC box for a module that builds a seven-tier network.
 *
 * So the numbers stay unknown, which is honest, and the *shape* is read off the
 * expression instead, which is also honest and is the part a reader was missing.
 * `availability_zone = element(var.azs, count.index)` says one subnet per zone
 * however many zones there turn out to be — a fact that needs no inputs, cannot be
 * wrong, and is exactly what distinguishes a tier from a single subnet.
 *
 * Reported rather than acted on, the same way `publicRouteCondition` is: the frame
 * stays one frame, because how many is still unknown.
 */
function declaredSpread(resource: ArchitectureResource): string | null {
  const zone = resource.availabilityZone;
  if (!zone) return null;

  // `count.index` or `each.key` over a zone list is the idiom for spreading one
  // block across the zones. A literal `availability_zone = "eu-central-1a"` says
  // the opposite and must not be labelled as a spread.
  if (!/\bcount\.index\b|\beach\.(key|value)\b/.test(zone)) return null;

  return "one per availability zone";
}

/**
 * Beyond this many instances, one frame per instance stops helping.
 *
 * Availability zones come in twos and threes, so four covers every real subnet
 * layout with a zone to spare. A block with ten instances is a pattern rather
 * than a set of places, and ten nested frames would cost more room than the
 * distinction is worth — so it keeps the single frame it has always had.
 */
const MAX_INSTANCE_FRAMES = 4;

/**
 * The frames a container block should be drawn as, or null to leave it alone.
 *
 * A single-instance block still comes back as a one-element list, and that is not
 * a no-op: the frame keeps its plain address as its id, so nothing downstream can
 * tell the difference, but it picks up its availability zone. One subnet in
 * `eu-central-1a` is worth saying so even with nothing to tell it apart from.
 *
 * Null when the count could not be resolved, or resolved to more instances than
 * are worth separating. Both leave the frame exactly as it was drawn before.
 */
function instanceFrames(
  resource: ArchitectureResource,
  scope: EvaluationScope,
): Array<Partial<ArchitectureNode> & { id: string }> | null {
  const count = resolveInstances(resource.conditionalOn, scope);
  if (count === null || count < 1 || count > MAX_INSTANCE_FRAMES) return null;

  const address = resourceAddress(resource);
  const name = meaningfulResourceName(resource.resourceName);
  const only = count === 1;

  return Array.from({ length: count }, (_, index) => {
    const zone = resource.availabilityZone
      ? evaluateExpression(resource.availabilityZone, withIndex(scope, index))
      : undefined;
    const inZone = typeof zone === "string" ? zone : undefined;

    /**
     * Both the block name and the zone, not just the zone. A VPC with a
     * `database` and a `private` subnet in the same zone would otherwise show two
     * identically labelled private frames, and the name is what says which is
     * which.
     */
    const sublabel = inZone
      ? name
        ? `${name} · ${inZone}`
        : inZone
      : only
        ? name
        : `${name ?? address}[${index}]`;

    return {
      // A lone instance *is* the block. Labelling it `[0]` would invite the
      // reader to look for a `[1]` that does not exist.
      id: only ? address : `${address}[${index}]`,
      ...(only ? {} : { instanceIndex: index, instanceCount: count }),
      ...(inZone ? { availabilityZone: inZone } : {}),
      ...(name ? { instanceName: name } : {}),
      ...(sublabel ? { sublabel } : {}),
    };
  });
}

/**
 * The frames an expanded module call offers as a home, addressed the way its
 * caller would name them.
 *
 * This is what makes placement work across a module boundary. Within one module
 * the reference `aws_instance.web -> aws_subnet.public` names the subnet
 * directly; between modules the same fact is spelt `subnet_id =
 * module.vpc.public_subnets[0]`, and the subnet only becomes nameable once the
 * callee's `public_subnets` output is read back to `aws_subnet.public`.
 */
interface ExposedFrames {
  /**
   * Frames per output name, in instance order — `public_subnets` yields both
   * public subnets, so `public_subnets[1]` can be placed in the second.
   */
  byOutput: Map<string, string[]>;
  /** The module's VPC, when it declares exactly one — otherwise nothing is certain. */
  vpc?: string;
  /**
   * Subnet frames grouped by the block that declared them. One declaration needs
   * no output name to be unambiguous, which covers the many single-subnet
   * wrappers; its instances still need an index to be told apart.
   */
  subnets: string[][];
}

/**
 * Two-segment dotted prefixes, which is what a Terraform resource address is.
 *
 * Deliberately loose: the result is only ever used as a lookup key against the
 * frames the module actually declares, so a chain that is not an address simply
 * matches nothing. Indexing terminates the match, so `aws_subnet.public[*].id`
 * yields `aws_subnet.public`.
 */
const ADDRESS_CHAIN = /[A-Za-z_][A-Za-z0-9_-]*\.[A-Za-z_][A-Za-z0-9_-]*/g;

function exposedFrames(
  inner: ArchitectureGraph,
  outputs: ArchitectureModuleOutput[],
  references: ArchitectureReference[],
  call: string,
): ExposedFrames {
  // Ids inside `inner` are rewritten on adoption; see `adoptSubgraph`.
  const idOf = (id: string) => `${call}/${id}`;

  const frames = inner.nodes.filter(
    (node) => node.type === "vpc" || node.type === "subnet",
  );

  /**
   * Frames per block address, instance order preserved.
   *
   * A block drawn as several frames has one entry per instance, all under the
   * same address — which is exactly what an output like `public_subnets` hands
   * back, a list.
   */
  const framesOfAddress = new Map<string, ArchitectureNode[]>();
  for (const frame of frames) {
    for (const address of frame.addresses) {
      const list = framesOfAddress.get(address);
      if (list) list.push(frame);
      else framesOfAddress.set(address, [frame]);
    }
  }
  for (const list of framesOfAddress.values()) {
    list.sort((a, b) => (a.instanceIndex ?? 0) - (b.instanceIndex ?? 0));
  }

  /**
   * Frames reachable one containment hop from a resource that is not drawn.
   *
   * The case is `database_subnet_group_name`, which names an
   * `aws_db_subnet_group` — undrawn by design, because the group is exactly the
   * "which subnets may this live in" statement the diagram makes by nesting. The
   * output therefore identifies a subnet without naming one, and stopping at the
   * group would send every database to the VPC at large instead.
   */
  const viaOmitted = new Map<string, ArchitectureNode[]>();
  for (const ref of references) {
    if (!containmentRelation(ref)) continue;
    if (framesOfAddress.has(ref.fromAddress)) continue;

    const found = framesOfAddress.get(ref.toAddress);
    if (!found) continue;

    // A group listing several subnet blocks has several of these. Most precise
    // wins, then the lower id, so the answer cannot depend on reference order.
    const current = viaOmitted.get(ref.fromAddress)?.[0];
    const frame = found[0];
    if (
      current &&
      frame &&
      (current.type === frame.type
        ? current.id <= frame.id
        : frame.type === "vpc")
    ) {
      continue;
    }
    viaOmitted.set(ref.fromAddress, found);
  }

  const byOutput = new Map<string, string[]>();
  for (const output of outputs) {
    if (!output.valueExpression) continue;

    for (const [address] of output.valueExpression.matchAll(ADDRESS_CHAIN)) {
      const found = framesOfAddress.get(address) ?? viaOmitted.get(address);
      if (!found?.length) continue;
      byOutput.set(
        output.name,
        found.map((frame) => idOf(frame.id)),
      );
      break;
    }
  }

  const declarations = [...framesOfAddress.values()];

  // One VPC *declaration*, however many instances it has; the first instance is
  // where anything without a subnet falls back to.
  const vpcs = declarations.filter((list) => list[0]?.type === "vpc");
  const only = vpcs.length === 1 ? vpcs[0]?.[0] : undefined;

  const subnets = declarations
    .filter((list) => list[0]?.type === "subnet")
    .map((list) => list.map((frame) => idOf(frame.id)));

  return {
    byOutput,
    ...(only ? { vpc: idOf(only.id) } : {}),
    subnets,
  };
}

/**
 * The scope a called module's own `count` guards should be read in.
 *
 * Three conditions, and every one of them is a licence to conclude something
 * rather than a convenience:
 *
 *   - the caller has a scope, so its own `local.azs` can be resolved;
 *   - the call carries its arguments, and carries *all* of them;
 *   - the callee's variables were supplied, so an unset argument has a default.
 *
 * Any of them missing yields no scope, which means every guard reads as unknown
 * and the module is drawn in full. That is the pre-existing behaviour, and it is
 * the right default: the cost of drawing a block that will not be created is a
 * reader wondering about one box, while the cost of hiding one that will be is a
 * diagram that lies about the deployment.
 *
 * Note what is *not* required: locals. A module imported before they were
 * recorded still qualifies, because a local the evaluator cannot find is unknown
 * rather than false, and its three-valued logic never turns an unknown operand
 * into a false result — `var.create && local.missing` is unknown, so the block
 * stays. Demanding locals would have cost every simple module its resolution to
 * guard against a case the arithmetic already rules out.
 */
function calleeScope(
  scope: EvaluationScope | undefined,
  call: ArchitectureModuleCall,
  contents: NestedModuleData,
): EvaluationScope | undefined {
  if (!scope || !call.arguments || !contents.variables) return undefined;

  return createScope({
    variables: contents.variables,
    locals: contents.locals,
    arguments: call.arguments,
    callerScope: scope,
  });
}

/** A home found for a box, and how precise it is: 2 a subnet, 1 a VPC. */
interface Placement {
  frameId: string;
  rank: 1 | 2;
  /**
   * Which instance the wire named, when it named one of several.
   *
   * Absent means the whole tier, which is the ordinary case. Present is what lets
   * the box be labelled with its zone once the instances are folded together.
   */
  zoneIndex?: number;
}

/**
 * How far a VPC may be inherited through security groups.
 *
 * Three is the real chain: a database names a security-group module, that module
 * names the VPC module. One spare hop covers a wrapper in between; past that the
 * claim has stopped being about this box.
 */
const MAX_PLACEMENT_HOPS = 4;

/**
 * Places boxes inside frames that belong to a *different* module call.
 *
 * Without this the project level draws nothing inside anything. Every box comes
 * from some module, each module's containment was resolved against its own
 * Terraform, and the reference that ties them together — `subnet_id =
 * module.vpc.public_subnets[0]` — names a module rather than a subnet, so it was
 * dropped for having no resource at either end. The result was the complaint
 * this function answers: an EC2 instance and a database drawn beside the VPC
 * they are inside, with nothing saying which subnet they sit in.
 *
 * Three sources of truth, in descending order of certainty:
 *
 *   1. The output the wire reads, resolved to the frame it exposes. Exact.
 *   2. The module's only subnet, or its only VPC. Unambiguous by arithmetic.
 *   3. A security group it shares. Security groups cannot span VPCs, so the VPC
 *      is certain even though the subnet stays unknown — which is the difference
 *      between a database inside its VPC and one floating next to it.
 *
 * Nothing is invented: a box whose wiring says nothing about the network keeps
 * the placement it had, which is none.
 */
function placeAcrossModules(
  drawn: ArchitectureNode[],
  adopted: ArchitectureNode[],
  references: ArchitectureReference[],
  exposed: Map<string, ExposedFrames>,
): void {
  if (exposed.size === 0) return;

  const byId = new Map<string, ArchitectureNode>();
  for (const node of [...drawn, ...adopted]) byId.set(node.id, node);

  /**
   * Picks the frame a wire points at, and says whether it named one zone.
   *
   * Both answers are the same tier — the instances of one subnet block get folded
   * back into a single frame downstream — so the frame id is only ever the first
   * instance. What differs is the claim:
   *
   *   `subnet_id  = module.vpc.public_subnets[0]`  one zone, and we know which
   *   `subnet_ids = module.vpc.private_subnets`    the whole tier, all of them
   *
   * Sending the second case up to the VPC was tried and was worse. Every box in a
   * real project is wired that way — an ALB across the public subnets, Fargate
   * tasks across the private ones, RDS through a subnet group spanning all three —
   * so the VPC filled up with services and all four tiers stood empty. That threw
   * away the most useful fact on the diagram, which tier each service is in, to
   * avoid overstating a zone nobody had asked about. The tier is the container and
   * the zone is a detail inside it; `zoneIndex` carries the detail.
   */
  const pick = (
    instances: string[],
    index: number | undefined,
  ): { frameId: string; zoneIndex?: number } | undefined => {
    if (index !== undefined) {
      const frameId = instances[index];
      return frameId
        ? instances.length > 1
          ? { frameId, zoneIndex: index }
          : { frameId }
        : undefined;
    }

    const frameId = instances[0];
    return frameId ? { frameId } : undefined;
  };

  /** The frame a single containment wire points at, if any. */
  const frameFor = (
    ref: ArchitectureReference,
    relation: "vpc" | "subnet",
  ): Placement | null => {
    const target = exposed.get(ref.toAddress);
    if (!target) return null;

    for (const output of ref.outputs ?? []) {
      const instances = target.byOutput.get(output.name);
      if (!instances?.length) continue;

      const found = pick(instances, output.index);
      if (!found) continue;

      const type = byId.get(found.frameId)?.type;

      // The attribute states the relation; the output only says which frame.
      // A `vpc_id` resolving to a subnet is a mis-declared wire, not a subnet.
      if (relation === "subnet" && type === "subnet")
        return { ...found, rank: 2 };
      if (relation === "vpc" && type === "vpc") return { ...found, rank: 1 };
    }

    // No output named, so the only unambiguous answer is a module with a single
    // subnet block. Its index, if the wire carried one, still applies.
    const only =
      relation === "subnet" && target.subnets.length === 1
        ? target.subnets[0]
        : undefined;
    if (only?.length) {
      const found = pick(only, ref.outputs?.[0]?.index);
      if (found) return { ...found, rank: 2 };
    }

    // A subnet wire whose subnet cannot be pinned down still tells us the VPC.
    return target.vpc ? { frameId: target.vpc, rank: 1 } : null;
  };

  const placement = new Map<string, Placement>();

  /**
   * Keeps the most precise home, with ties broken by frame id so two equally
   * good answers cannot make the diagram depend on reference order.
   */
  const offer = (address: string, next: Placement) => {
    const current = placement.get(address);
    if (
      current &&
      (current.rank > next.rank ||
        (current.rank === next.rank && current.frameId <= next.frameId))
    ) {
      // Same frame, and this one names a zone the other did not: keep the home,
      // take the zone. Two wires into one tier, one of which subscripted it,
      // should not lose that depending on which arrived first.
      if (
        current.frameId === next.frameId &&
        next.zoneIndex !== undefined &&
        current.zoneIndex === undefined
      ) {
        placement.set(address, { ...current, zoneIndex: next.zoneIndex });
      }
      return;
    }
    placement.set(address, next);
  };

  for (const ref of references) {
    const relation = containmentRelation(ref);
    if (!relation) continue;

    const found = frameFor(ref, relation);
    if (found) offer(ref.fromAddress, found);
  }

  /** The VPC a frame sits in, which for a VPC frame is itself. */
  const vpcOf = (frameId: string): string | null => {
    let current = byId.get(frameId);
    const seen = new Set<string>();

    while (current && !seen.has(current.id)) {
      if (current.type === "vpc") return current.id;
      seen.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }

    return null;
  };

  // Source 3, relaxed to a fixpoint so `db -> db_sg -> vpc` resolves in the
  // order the references happen to arrive in.
  for (let hop = 0; hop < MAX_PLACEMENT_HOPS; hop++) {
    let changed = false;

    for (const ref of references) {
      if (placement.has(ref.fromAddress)) continue;
      if (
        !(ref.attributes ?? []).some((attribute) =>
          VPC_SCOPED_ATTRIBUTES.has(attribute),
        )
      ) {
        continue;
      }

      const via = placement.get(ref.toAddress) ?? null;
      const frameId = via
        ? vpcOf(via.frameId)
        : exposed.get(ref.toAddress)?.vpc;
      if (!frameId) continue;

      placement.set(ref.fromAddress, { frameId, rank: 1 });
      changed = true;
    }

    if (!changed) break;
  }

  for (const node of drawn) {
    // A box already inside one of this module's own frames is where it belongs;
    // that placement was read from resources, not inferred.
    if (node.parentId) continue;

    // Edge and global services stay outside the VPC however they are wired.
    if (entryForNode(node)?.global) continue;

    let best: Placement | null = null;
    for (const address of node.addresses) {
      const found = placement.get(address);
      if (!found) continue;
      if (
        !best ||
        found.rank > best.rank ||
        (found.rank === best.rank && found.frameId < best.frameId)
      ) {
        best = found;
      }
    }

    if (!best || !byId.has(best.frameId)) continue;
    // A module cannot go inside a frame it contains: the VPC module owns the
    // subnets, so a wire from it to one of them must not swallow the module.
    if (encloses(node.id, best.frameId, byId)) continue;

    node.parentId = best.frameId;

    // Read off the frame rather than recomputed: the frame already resolved its
    // own `availability_zone`, and asking twice is how two answers appear.
    if (best.zoneIndex !== undefined) {
      const zone = byId.get(best.frameId)?.availabilityZone;
      if (zone) node.zone = zone;
    }
  }
}

/** Whether `frameId` sits inside `nodeId`, reading placements as they stand. */
function encloses(
  nodeId: string,
  frameId: string,
  byId: Map<string, ArchitectureNode>,
): boolean {
  let current: ArchitectureNode | undefined = byId.get(frameId);
  const seen = new Set<string>();

  while (current && !seen.has(current.id)) {
    if (current.id === nodeId) return true;
    seen.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  return false;
}

/**
 * Orders the nodes so every frame precedes what it contains.
 *
 * React Flow requires it — a child listed before its parent is dropped with an
 * error — and it is also what makes frames paint underneath their contents. The
 * old comment claimed the order came out right on its own, which held only while
 * containment stayed inside one module: a resource list arrives in whatever
 * order the database returned it, so `aws_subnet.public` routinely preceded the
 * `aws_vpc.this` it belongs to.
 *
 * Sorting by nesting depth is enough, since a parent is always exactly one level
 * shallower than its child, and a stable sort keeps the meaningful order within
 * each level: services before the frames they sit above, module contents in the
 * order the callee produced them.
 */
function framesBeforeContents(nodes: ArchitectureNode[]): ArchitectureNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));

  const depthOf = (node: ArchitectureNode): number => {
    let current = node;
    const seen = new Set<string>([node.id]);
    let depth = 0;

    while (current.parentId) {
      const parent = byId.get(current.parentId);
      if (!parent || seen.has(parent.id)) break;
      seen.add(parent.id);
      current = parent;
      depth += 1;
    }

    return depth;
  };

  return nodes
    .map((node, index) => ({ node, index, depth: depthOf(node) }))
    .sort((a, b) => a.depth - b.depth || a.index - b.index)
    .map((entry) => entry.node);
}

/**
 * The containment a reference expresses, taking the most precise attribute when
 * it carries several.
 *
 * One reference stands for every argument connecting two blocks, and a module
 * call routinely takes both: `module "app_server"` is given
 * `subnet_id = module.vpc.public_subnets[0]` *and*
 * `security_group_vpc_id = module.vpc.vpc_id`. Both are containment, and being in
 * a subnet is the stronger statement — anything in a subnet is in that subnet's
 * VPC anyway.
 *
 * Returning the first match instead made the answer depend on the order the
 * arguments happened to arrive in, which put the EC2 instance in the VPC rather
 * than in its subnet as soon as the security-group argument came first. The same
 * ranking as `frameRank` uses, for the same reason.
 */
function containmentRelation(
  ref: ArchitectureReference,
): "vpc" | "subnet" | null {
  let found: "vpc" | "subnet" | null = null;

  for (const attribute of ref.attributes ?? []) {
    const relation = CONTAINMENT_ATTRIBUTES[attribute];
    if (relation === "subnet") return "subnet";
    if (relation) found = relation;
  }

  return found;
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
): Map<string, PublicRoute> {
  const typeOf = (address: string) => byAddress.get(address)?.resourceType;
  const guardOf = (address: string) =>
    byAddress.get(address)?.conditionalOn ?? null;

  /**
   * Route tables with a way out, and what the way out depends on.
   *
   * The guard travels with the table because the whole point is that the chain
   * can be present in the code and absent from the account: the upstream VPC
   * module writes its database route as
   * `count = var.create_database_internet_gateway_route ? 1 : 0`.
   */
  const internetRouteTables = new Map<string, string | null>();

  for (const ref of references) {
    if (typeOf(ref.fromAddress) !== "aws_route") continue;
    if (typeOf(ref.toAddress) !== "aws_internet_gateway") continue;

    for (const other of references) {
      if (other.fromAddress !== ref.fromAddress) continue;
      if (typeOf(other.toAddress) !== "aws_route_table") continue;

      // An unconditional route wins: a table reachable one way for certain is
      // public regardless of a second, optional route to the same gateway.
      const guard = guardOf(ref.fromAddress);
      const existing = internetRouteTables.get(other.toAddress);
      if (existing === null) continue;
      internetRouteTables.set(other.toAddress, guard);
    }
  }

  const publicSubnets = new Map<string, PublicRoute>();

  for (const ref of references) {
    if (typeOf(ref.fromAddress) !== "aws_route_table_association") continue;
    if (!internetRouteTables.has(ref.toAddress)) continue;

    for (const other of references) {
      if (other.fromAddress !== ref.fromAddress) continue;
      if (typeOf(other.toAddress) !== "aws_subnet") continue;

      // Either link may be optional, and either being optional makes the whole
      // path optional. The route's guard is reported because it is the one that
      // names the decision a reader would look up.
      const routeGuard = internetRouteTables.get(ref.toAddress) ?? null;
      const associationGuard = guardOf(ref.fromAddress);
      const guard = routeGuard ?? associationGuard;

      // Deterministic: an unconditional path wins, and between two conditional
      // ones the smaller expression is kept. A subnet routed out by both an IPv4
      // and an IPv6 route would otherwise report whichever row arrived last.
      const existing = publicSubnets.get(other.toAddress);
      if (existing) {
        if (existing.conditionalOn === null) continue;
        if (guard !== null && existing.conditionalOn <= guard) continue;
      }

      publicSubnets.set(other.toAddress, { conditionalOn: guard });
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
