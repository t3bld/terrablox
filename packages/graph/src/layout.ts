import dagre, {
  type EdgeLabel,
  type GraphLabel,
  type NodeLabel,
} from "@dagrejs/dagre";

export type DependencyGraphNodeKind =
  | "module"
  | "resource"
  | "data"
  | "external-module";

export type DependencyGraphLayoutDirection = "TB" | "BT" | "LR" | "RL";

export interface DependencyGraphNodeDimensions {
  width: number;
  height: number;
}

export interface DependencyGraphLayoutNode {
  id: string;
  label?: string;
  kind?: DependencyGraphNodeKind;
  group?: string;
  width?: number;
  height?: number;
}

export interface DependencyGraphLayoutEdge {
  id?: string;
  source: string;
  target: string;
}

export interface DependencyGraphLayoutOptions {
  direction?: DependencyGraphLayoutDirection;
  nodeSpacing?: number;
  rankSpacing?: number;
  marginX?: number;
  marginY?: number;
  /**
   * Fan-out size at which a node's leaf children stop being stacked into a
   * single rank and get arranged in a compact grid instead. A module that calls
   * 60 resources would otherwise become one column thousands of pixels long,
   * which fitView can only show at an unreadable zoom level.
   */
  leafFanoutThreshold?: number;
  /**
   * Maximum nodes dagre may stack into a single rank. Wider ranks are wrapped
   * into several sub-columns along the flow direction. A rank of 30 resource
   * nodes is ~4000px tall, so a graph with only six ranks still ends up with an
   * aspect ratio that fitView can only satisfy at an unreadable zoom level.
   * Set to 0 to keep dagre's ranks untouched.
   */
  maxNodesPerRank?: number;
}

export interface DependencyGraphPosition {
  x: number;
  y: number;
}

export type LayoutedDependencyGraphNode<
  TNode extends DependencyGraphLayoutNode = DependencyGraphLayoutNode,
> = TNode & {
  position: DependencyGraphPosition;
  width: number;
  height: number;
};

/**
 * Heights account for the node frame's full content: a group badge, the title,
 * three lines of description and one metadata row. Too little and the rows are
 * clipped instead of stacking, which silently swallows the description the node
 * exists to carry.
 */
export const defaultDependencyGraphNodeDimensions = {
  module: { width: 300, height: 148 },
  resource: { width: 260, height: 140 },
  data: { width: 260, height: 140 },
  "external-module": { width: 280, height: 144 },
} satisfies Record<DependencyGraphNodeKind, DependencyGraphNodeDimensions>;

const nodeKindSortOrder = {
  module: 0,
  "external-module": 1,
  resource: 2,
  data: 3,
} satisfies Record<DependencyGraphNodeKind, number>;

export function getDependencyGraphNodeDimensions(
  node: DependencyGraphLayoutNode,
): DependencyGraphNodeDimensions {
  const kind = node.kind ?? "resource";
  const fallback = defaultDependencyGraphNodeDimensions[kind];

  return {
    width: node.width ?? fallback.width,
    height: node.height ?? fallback.height,
  };
}

export function layoutDependencyGraph<TNode extends DependencyGraphLayoutNode>(
  nodes: readonly TNode[],
  edges: readonly DependencyGraphLayoutEdge[],
  options: DependencyGraphLayoutOptions = {},
): Array<LayoutedDependencyGraphNode<TNode>> {
  const direction = options.direction ?? "LR";
  const nodeSpacing = options.nodeSpacing ?? 48;
  const rankSpacing = options.rankSpacing ?? 120;
  const marginX = options.marginX ?? 24;
  const marginY = options.marginY ?? 24;

  const graph = new dagre.graphlib.Graph<GraphLabel, NodeLabel, EdgeLabel>({
    compound: false,
    multigraph: true,
  });

  graph.setGraph({
    rankdir: direction,
    nodesep: nodeSpacing,
    ranksep: rankSpacing,
    marginx: marginX,
    marginy: marginY,
  });
  graph.setDefaultEdgeLabel(() => ({}));

  const sortedNodes = [...nodes].sort(compareLayoutNodes);
  const nodeIds = new Set(sortedNodes.map((node) => node.id));

  // Leaf groups that dagre would stack into one endless rank are laid out by
  // hand afterwards, so they are kept out of the dagre graph entirely.
  const fanoutGroups = findFanoutLeafGroups(
    sortedNodes,
    edges,
    nodeIds,
    Math.max(2, options.leafFanoutThreshold ?? 12),
  );
  const gridded = new Set(fanoutGroups.flat());

  for (const node of sortedNodes) {
    if (gridded.has(node.id)) {
      continue;
    }

    const dimensions = getDependencyGraphNodeDimensions(node);
    graph.setNode(node.id, {
      width: dimensions.width,
      height: dimensions.height,
    });
  }

  edges.forEach((edge, index) => {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      return;
    }
    if (gridded.has(edge.source) || gridded.has(edge.target)) {
      return;
    }

    graph.setEdge(
      edge.source,
      edge.target,
      { minlen: 1, weight: 1 },
      edge.id ?? `${edge.source}->${edge.target}:${index}`,
    );
  });

  dagre.layout(graph);

  const positions = new Map<string, DependencyGraphPosition>();

  for (const node of sortedNodes) {
    if (gridded.has(node.id)) {
      continue;
    }

    const dimensions = getDependencyGraphNodeDimensions(node);
    const layoutNode = graph.node(node.id);
    const center = hasPosition(layoutNode)
      ? layoutNode
      : { x: dimensions.width / 2, y: dimensions.height / 2 };

    positions.set(node.id, {
      x: center.x - dimensions.width / 2,
      y: center.y - dimensions.height / 2,
    });
  }

  const maxNodesPerRank = options.maxNodesPerRank ?? 10;
  if (maxNodesPerRank > 0) {
    wrapWideRanks({
      nodesById: new Map(sortedNodes.map((node) => [node.id, node])),
      positions,
      direction,
      nodeSpacing,
      rankSpacing,
      maxNodesPerRank,
      marginX,
      marginY,
    });
  }

  if (fanoutGroups.length > 0) {
    placeFanoutGrids({
      groups: fanoutGroups,
      nodesById: new Map(sortedNodes.map((node) => [node.id, node])),
      positions,
      direction,
      nodeSpacing,
      rankSpacing,
    });
  }

  return nodes.map((node) => {
    const dimensions = getDependencyGraphNodeDimensions(node);

    return {
      ...node,
      width: dimensions.width,
      height: dimensions.height,
      position: positions.get(node.id) ?? { x: 0, y: 0 },
    };
  });
}

/**
 * Finds leaf groups (nodes with no outgoing edges and exactly one parent) whose
 * size would make dagre stack them into one very long rank. Returns each group
 * in the caller's sort order, so related nodes stay adjacent in the grid.
 */
interface WrapWideRanksInput {
  nodesById: ReadonlyMap<string, DependencyGraphLayoutNode>;
  positions: Map<string, DependencyGraphPosition>;
  direction: DependencyGraphLayoutDirection;
  nodeSpacing: number;
  rankSpacing: number;
  maxNodesPerRank: number;
  marginX: number;
  marginY: number;
}

interface RankPlan {
  ids: string[];
  columns: number;
  rows: number;
  /** Extent of one sub-column along the flow axis. */
  columnExtent: number;
  /** Extent of each row on the cross axis, indexed by row. */
  rowExtents: number[];
  alongExtent: number;
  acrossExtent: number;
}

/**
 * Re-flows dagre's ranks so none of them exceeds `maxNodesPerRank` nodes. Ranks
 * keep their order along the flow axis and their internal order on the cross
 * axis, so dagre's crossing minimisation is preserved; only the shape changes.
 */
function wrapWideRanks({
  nodesById,
  positions,
  direction,
  nodeSpacing,
  rankSpacing,
  maxNodesPerRank,
  marginX,
  marginY,
}: WrapWideRanksInput): void {
  const horizontal = direction === "LR" || direction === "RL";
  const alongOf = (id: string) =>
    centerOf(id, positions, nodesById, horizontal);
  const acrossOf = (id: string) =>
    centerOf(id, positions, nodesById, !horizontal);
  const sizeAlong = (id: string) => sizeOf(id, nodesById, horizontal);
  const sizeAcross = (id: string) => sizeOf(id, nodesById, !horizontal);

  const ranks = new Map<number, string[]>();
  for (const id of positions.keys()) {
    const key = Math.round(alongOf(id));
    const members = ranks.get(key);
    if (members) {
      members.push(id);
    } else {
      ranks.set(key, [id]);
    }
  }

  const ordered = [...ranks.entries()].sort(
    (left, right) => left[0] - right[0],
  );
  if (!ordered.some(([, ids]) => ids.length > maxNodesPerRank)) {
    return;
  }

  const plans: RankPlan[] = ordered.map(([, ids]) => {
    const sorted = [...ids].sort(
      (left, right) => acrossOf(left) - acrossOf(right),
    );
    const columns = Math.ceil(sorted.length / maxNodesPerRank);
    const rows = Math.ceil(sorted.length / columns);
    const columnExtent = Math.max(...sorted.map(sizeAlong));

    const rowExtents: number[] = [];
    sorted.forEach((id, index) => {
      const row = index % rows;
      rowExtents[row] = Math.max(rowExtents[row] ?? 0, sizeAcross(id));
    });

    const acrossExtent =
      rowExtents.reduce((total, extent) => total + extent, 0) +
      nodeSpacing * Math.max(0, rowExtents.length - 1);

    return {
      ids: sorted,
      columns,
      rows,
      columnExtent,
      rowExtents,
      alongExtent:
        columns * columnExtent + nodeSpacing * Math.max(0, columns - 1),
      acrossExtent,
    };
  });

  const acrossCenter = Math.max(...plans.map((plan) => plan.acrossExtent)) / 2;
  const alongMargin = horizontal ? marginX : marginY;
  const acrossMargin = horizontal ? marginY : marginX;
  let alongCursor = alongMargin;

  for (const plan of plans) {
    const acrossStart = acrossMargin + acrossCenter - plan.acrossExtent / 2;
    const rowOffsets: number[] = [];
    let offset = 0;
    plan.rowExtents.forEach((extent, row) => {
      rowOffsets[row] = offset;
      offset += extent + nodeSpacing;
    });

    plan.ids.forEach((id, index) => {
      const column = Math.floor(index / plan.rows);
      const row = index % plan.rows;
      const rowExtent = plan.rowExtents[row] ?? 0;
      const rowOffset = rowOffsets[row] ?? 0;

      const along =
        alongCursor +
        column * (plan.columnExtent + nodeSpacing) +
        (plan.columnExtent - sizeAlong(id)) / 2;
      const across = acrossStart + rowOffset + (rowExtent - sizeAcross(id)) / 2;

      positions.set(id, {
        x: horizontal ? along : across,
        y: horizontal ? across : along,
      });
    });

    alongCursor += plan.alongExtent + rankSpacing;
  }
}

function centerOf(
  id: string,
  positions: ReadonlyMap<string, DependencyGraphPosition>,
  nodesById: ReadonlyMap<string, DependencyGraphLayoutNode>,
  horizontal: boolean,
): number {
  const position = positions.get(id);
  if (!position) {
    return 0;
  }

  const start = horizontal ? position.x : position.y;

  return start + sizeOf(id, nodesById, horizontal) / 2;
}

function sizeOf(
  id: string,
  nodesById: ReadonlyMap<string, DependencyGraphLayoutNode>,
  horizontal: boolean,
): number {
  const node = nodesById.get(id);
  if (!node) {
    return 0;
  }

  const dimensions = getDependencyGraphNodeDimensions(node);

  return horizontal ? dimensions.width : dimensions.height;
}

function findFanoutLeafGroups(
  sortedNodes: readonly DependencyGraphLayoutNode[],
  edges: readonly DependencyGraphLayoutEdge[],
  nodeIds: ReadonlySet<string>,
  threshold: number,
): string[][] {
  const outDegree = new Map<string, number>();
  const parents = new Map<string, Set<string>>();

  for (const edge of edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      continue;
    }

    outDegree.set(edge.source, (outDegree.get(edge.source) ?? 0) + 1);

    const sources = parents.get(edge.target);
    if (sources) {
      sources.add(edge.source);
    } else {
      parents.set(edge.target, new Set([edge.source]));
    }
  }

  const leavesByParent = new Map<string, string[]>();

  for (const node of sortedNodes) {
    if ((outDegree.get(node.id) ?? 0) > 0) {
      continue;
    }

    const nodeParents = parents.get(node.id);
    if (nodeParents?.size !== 1) {
      continue;
    }

    const [parent] = nodeParents;
    if (parent === undefined) {
      continue;
    }

    const siblings = leavesByParent.get(parent);
    if (siblings) {
      siblings.push(node.id);
    } else {
      leavesByParent.set(parent, [node.id]);
    }
  }

  return [...leavesByParent.values()].filter(
    (group) => group.length >= threshold,
  );
}

interface FanoutGridInput {
  groups: readonly string[][];
  nodesById: ReadonlyMap<string, DependencyGraphLayoutNode>;
  positions: Map<string, DependencyGraphPosition>;
  direction: DependencyGraphLayoutDirection;
  nodeSpacing: number;
  rankSpacing: number;
}

/** Roughly matches the aspect ratio of a typical graph viewport. */
const targetGridAspectRatio = 1.8;

/**
 * Arranges each fan-out group in a compact grid placed past the dagre layout,
 * along the flow direction. Grids cannot overlap the dagre nodes because they
 * start beyond its bounding box, nor each other because they are stacked on the
 * cross axis.
 */
function placeFanoutGrids({
  groups,
  nodesById,
  positions,
  direction,
  nodeSpacing,
  rankSpacing,
}: FanoutGridInput): void {
  const horizontal = direction === "LR" || direction === "RL";
  const bounds = boundingBox(positions, nodesById);
  let stackOffset = 0;

  for (const group of groups) {
    const dimensions = group.map((id) => {
      const node = nodesById.get(id);
      return node
        ? getDependencyGraphNodeDimensions(node)
        : defaultDependencyGraphNodeDimensions.resource;
    });
    const cellWidth =
      Math.max(...dimensions.map((d) => d.width)) +
      (horizontal ? rankSpacing : nodeSpacing);
    const cellHeight =
      Math.max(...dimensions.map((d) => d.height)) +
      (horizontal ? nodeSpacing : rankSpacing);

    const columns = clamp(
      Math.round(
        Math.sqrt(
          (targetGridAspectRatio * group.length * cellHeight) / cellWidth,
        ),
      ),
      1,
      group.length,
    );
    const rows = Math.ceil(group.length / columns);
    const gridWidth = columns * cellWidth;
    const gridHeight = rows * cellHeight;

    const originX = horizontal
      ? direction === "LR"
        ? bounds.maxX + rankSpacing
        : bounds.minX - rankSpacing - gridWidth
      : bounds.minX + stackOffset;
    const originY = horizontal
      ? bounds.minY + stackOffset
      : direction === "TB"
        ? bounds.maxY + rankSpacing
        : bounds.minY - rankSpacing - gridHeight;

    group.forEach((id, index) => {
      // Fill column by column so sorted neighbours stay vertically adjacent.
      const column = Math.floor(index / rows);
      const row = index % rows;

      positions.set(id, {
        x: originX + column * cellWidth,
        y: originY + row * cellHeight,
      });
    });

    stackOffset += (horizontal ? gridHeight : gridWidth) + rankSpacing;
  }
}

function boundingBox(
  positions: ReadonlyMap<string, DependencyGraphPosition>,
  nodesById: ReadonlyMap<string, DependencyGraphLayoutNode>,
): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const [id, position] of positions) {
    const node = nodesById.get(id);
    const dimensions = node
      ? getDependencyGraphNodeDimensions(node)
      : defaultDependencyGraphNodeDimensions.resource;

    minX = Math.min(minX, position.x);
    minY = Math.min(minY, position.y);
    maxX = Math.max(maxX, position.x + dimensions.width);
    maxY = Math.max(maxY, position.y + dimensions.height);
  }

  if (!Number.isFinite(minX)) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }

  return { minX, minY, maxX, maxY };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function compareLayoutNodes(
  left: DependencyGraphLayoutNode,
  right: DependencyGraphLayoutNode,
) {
  const leftKind = nodeKindSortOrder[left.kind ?? "resource"];
  const rightKind = nodeKindSortOrder[right.kind ?? "resource"];

  if (leftKind !== rightKind) {
    return leftKind - rightKind;
  }

  const groupCompare = (left.group ?? "").localeCompare(right.group ?? "");

  if (groupCompare !== 0) {
    return groupCompare;
  }

  return (left.label ?? left.id).localeCompare(right.label ?? right.id);
}

function hasPosition(
  node: NodeLabel | undefined,
): node is NodeLabel & DependencyGraphPosition {
  return typeof node?.x === "number" && typeof node.y === "number";
}
