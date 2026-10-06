/**
 * Places the architecture nodes.
 *
 * dagre drives the Connections graph, but it is a poor fit here: its compound
 * support is limited, and an architecture diagram is not free-form anyway. The
 * shape is a convention — edge services on top, the VPC below, public subnets
 * above private ones — so the layout is written out rather than searched for.
 *
 * Sizing runs bottom-up: a subnet is as wide as the services inside it, and the
 * VPC is as wide as its widest row.
 */

import type { ArchitectureEdge, ArchitectureNode } from "./architecture-graph";

const SERVICE_WIDTH = 150;
const SERVICE_HEIGHT = 92;
const GAP = 24;

/**
 * Wider than `GAP` because this is the direction arrows travel: the space has
 * to read as a connection, not as a seam between two tiles.
 */
const LAYER_GAP = 76;

/** Room for the frame's own label above its contents. */
const FRAME_HEADER = 40;
const FRAME_PADDING = 18;

const MIN_FRAME_WIDTH = SERVICE_WIDTH + FRAME_PADDING * 2;
const EMPTY_FRAME_HEIGHT = FRAME_HEADER + 44;

/**
 * A frame must be wide enough for its own title, not just for its contents —
 * an empty subnet is only 186px wide but `PRIVATE SUBNET private_db_subnet`
 * needs far more, and would otherwise spill past the border.
 *
 * Approximated from the rendered styles: 16px icon plus gap, an 11px semibold
 * uppercase label, and a 10px monospace sublabel.
 */
function frameLabelWidth(node: ArchitectureNode): number {
  const label = node.label.length * 7.4;
  const sublabel = node.sublabel ? 6 + node.sublabel.length * 6.1 : 0;

  return Math.ceil(22 + label + sublabel + FRAME_PADDING * 2);
}

export interface PositionedNode extends ArchitectureNode {
  position: { x: number; y: number };
  width: number;
  height: number;
}

export function layoutArchitecture(
  nodes: ArchitectureNode[],
  edges: ArchitectureEdge[] = [],
): PositionedNode[] {
  const childrenOf = new Map<string | undefined, ArchitectureNode[]>();
  for (const node of nodes) {
    const key = node.parentId;
    const list = childrenOf.get(key) ?? [];
    list.push(node);
    childrenOf.set(key, list);
  }

  const sized = new Map<string, { width: number; height: number }>();

  const measure = (
    node: ArchitectureNode,
  ): { width: number; height: number } => {
    const cached = sized.get(node.id);
    if (cached) return cached;

    if (node.type === "service") {
      const size = { width: SERVICE_WIDTH, height: SERVICE_HEIGHT };
      sized.set(node.id, size);
      return size;
    }

    const children = childrenOf.get(node.id) ?? [];
    if (children.length === 0) {
      const size = {
        width: Math.max(MIN_FRAME_WIDTH, frameLabelWidth(node)),
        height: EMPTY_FRAME_HEIGHT,
      };
      sized.set(node.id, size);
      return size;
    }

    // Network frames stack in rows below the services, so a VPC shows its
    // gateway above its subnets rather than beside them.
    const { flowing, containers } = splitChildren(children);

    const rows: { width: number; height: number }[] = [];
    if (flowing.length > 0) {
      rows.push(arrange(flowing, edges, measure));
    }

    const packed = packSubnetRows(containers, measure);
    for (const row of packed.rows) {
      rows.push(rowSize(row, measure, packed.columnWidths));
    }

    const size = {
      width:
        Math.max(MIN_FRAME_WIDTH, ...rows.map((r) => r.width)) +
        FRAME_PADDING * 2,
      height:
        FRAME_HEADER +
        rows.reduce((sum, r) => sum + r.height, 0) +
        GAP * Math.max(0, rows.length - 1) +
        FRAME_PADDING,
    };

    size.width = Math.max(size.width, frameLabelWidth(node));

    sized.set(node.id, size);
    return size;
  };

  for (const node of nodes) measure(node);

  const positioned: PositionedNode[] = [];

  const place = (node: ArchitectureNode, x: number, y: number) => {
    const size = sized.get(node.id) ?? {
      width: SERVICE_WIDTH,
      height: SERVICE_HEIGHT,
    };
    positioned.push({
      ...node,
      position: { x, y },
      width: size.width,
      height: size.height,
    });

    const children = childrenOf.get(node.id) ?? [];
    if (children.length === 0) return;

    const { flowing, containers } = splitChildren(children);

    // Children are positioned relative to their parent, which is what React
    // Flow expects for nested nodes.
    let rowY = FRAME_HEADER;

    if (flowing.length > 0) {
      const block = arrange(flowing, edges, measure);
      placeColumns(block, FRAME_PADDING, rowY, place, measure);
      rowY += block.height + GAP;
    }

    const packed = packSubnetRows(containers, measure);
    for (const row of packed.rows) {
      let rowX = FRAME_PADDING;
      let height = 0;

      for (const [column, child] of row.entries()) {
        const size = measure(child);
        place(child, rowX, rowY);
        // In grid mode the step is the column's width rather than this frame's,
        // which is what makes one zone sit above another.
        rowX += (packed.columnWidths?.[column] ?? size.width) + GAP;
        height = Math.max(height, size.height);
      }

      rowY += height + GAP;
    }
  };

  const roots = childrenOf.get(undefined) ?? [];
  const { flowing, containers } = splitChildren(roots);

  let y = 0;
  if (flowing.length > 0) {
    // Laid out as columns along the direction of flow rather than one row:
    // with edges in the picture a single line of tiles reads as a toolbar, and
    // every arrow degenerates into a stub between neighbours.
    const block = arrange(flowing, edges, measure);
    placeColumns(block, 0, y, place, measure);
    y += block.height + GAP * 2;
  }

  for (const frame of containers) {
    place(frame, 0, y);
    y += measure(frame).height + GAP * 2;
  }

  return positioned;
}

type Size = { width: number; height: number };
type Measure = (node: ArchitectureNode) => Size;

interface Block extends Size {
  columns: ArchitectureNode[][];
  /** Widest node per column, so mixed tile and frame widths still line up. */
  columnWidths: number[];
}

/**
 * Separates children that take part in the left-to-right flow from the network
 * frames that form the classic stacked picture underneath.
 *
 * An expanded module call counts as flowing even though it is drawn as a frame:
 * it is a service that happens to show its insides, and other things point at
 * it. A VPC or subnet is genuinely a container and belongs below.
 */
function splitChildren(children: ArchitectureNode[]): {
  flowing: ArchitectureNode[];
  containers: ArchitectureNode[];
} {
  const flowing: ArchitectureNode[] = [];
  const containers: ArchitectureNode[] = [];

  for (const child of children) {
    if (child.type === "service" || child.type === "module")
      flowing.push(child);
    else containers.push(child);
  }

  return { flowing, containers };
}

/**
 * Works out the columns and the space they need. Measuring and placing both go
 * through here so a frame can never be sized from one arrangement and filled
 * with another.
 */
function arrange(
  nodes: ArchitectureNode[],
  edges: ArchitectureEdge[],
  measure: Measure,
): Block {
  const columns = wrapTallColumns(layerByFlow(nodes, edges), measure);

  const columnWidths = columns.map((column) =>
    Math.max(...column.map((node) => measure(node).width)),
  );

  const columnHeights = columns.map(
    (column) =>
      column.reduce((sum, node) => sum + measure(node).height, 0) +
      GAP * Math.max(0, column.length - 1),
  );

  return {
    columns,
    columnWidths,
    width:
      columnWidths.reduce((sum, width) => sum + width, 0) +
      LAYER_GAP * Math.max(0, columns.length - 1),
    height: Math.max(0, ...columnHeights),
  };
}

function placeColumns(
  block: Block,
  originX: number,
  originY: number,
  place: (node: ArchitectureNode, x: number, y: number) => void,
  measure: Measure,
): void {
  let x = originX;

  for (const [index, column] of block.columns.entries()) {
    const columnWidth = block.columnWidths[index] ?? SERVICE_WIDTH;
    const height =
      column.reduce((sum, node) => sum + measure(node).height, 0) +
      GAP * Math.max(0, column.length - 1);

    // Centring the short columns keeps arrows roughly horizontal instead of
    // fanning down from a common top edge.
    let y = originY + (block.height - height) / 2;

    for (const node of column) {
      const size = measure(node);
      // Centred within the column too, so a narrow tile beside a wide module
      // frame does not cling to the left edge.
      place(node, x + (columnWidth - size.width) / 2, y);
      y += size.height + GAP;
    }

    x += columnWidth + LAYER_GAP;
  }
}

/**
 * A canvas is wider than it is tall, so a picture that grows downwards is
 * capped by the window long before it runs out of width. Roughly the shape of
 * the diagram container.
 */
const TARGET_ASPECT = 2.1;

/**
 * Node area alone badly understates the space a diagram takes: frames carry
 * headers and padding, columns are centred, and gaps sit between everything.
 * Calibrated against the real modules so the wrapped result lands near
 * TARGET_ASPECT rather than overshooting into a long thin strip.
 */
const AREA_SLACK = 2.33;

/**
 * Breaks a column that has grown taller than the picture is wide into
 * sub-columns beside it.
 *
 * Without this, everything that nothing points at — three module frames in a
 * wrapper, say — ends up in one tall stack, and fitting that into a wide canvas
 * shrinks the whole diagram until the labels are unreadable.
 *
 * Splitting within a rank is safe: `layerByFlow` puts anything connected into
 * a *different* rank, so nodes sharing a column have no edges between them and
 * their relative order carries no meaning.
 */
function wrapTallColumns(
  columns: ArchitectureNode[][],
  measure: Measure,
): ArchitectureNode[][] {
  const sizes = columns.flat().map(measure);
  if (sizes.length === 0) return columns;

  const area = sizes.reduce((sum, s) => sum + s.width * s.height, 0);
  const tallest = Math.max(...sizes.map((s) => s.height));
  // Height of a rectangle with this area at the target shape. Never below the
  // tallest single node: a limit it cannot meet would put every node in its
  // own column.
  const limit = Math.max(
    tallest,
    Math.sqrt((area * AREA_SLACK) / TARGET_ASPECT),
  );

  const wrapped: ArchitectureNode[][] = [];

  for (const column of columns) {
    let current: ArchitectureNode[] = [];
    let height = 0;

    for (const node of column) {
      const nodeHeight = measure(node).height;
      if (current.length > 0 && height + GAP + nodeHeight > limit) {
        wrapped.push(current);
        current = [];
        height = 0;
      }
      if (current.length > 0) height += GAP;
      current.push(node);
      height += nodeHeight;
    }

    if (current.length > 0) wrapped.push(current);
  }

  return wrapped;
}

/**
 * Splits the free-standing services into columns so traffic reads left to
 * right: whatever nothing points at starts on the left, and every node sits one
 * column right of the last thing that reaches it.
 *
 * Ranks are relaxed iteratively rather than by topological sort because these
 * graphs may contain cycles — two services can legitimately reference each
 * other — and a sort would have to break them arbitrarily. The pass count is
 * bounded by the node count, after which any remaining cycle has settled.
 */
function layerByFlow(
  services: ArchitectureNode[],
  edges: ArchitectureEdge[],
): ArchitectureNode[][] {
  const ids = new Set(services.map((n) => n.id));
  const relevant = edges.filter(
    (e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target,
  );

  const rank = new Map(services.map((n) => [n.id, 0]));

  for (let pass = 0; pass < services.length; pass++) {
    let changed = false;
    for (const edge of relevant) {
      const wanted = (rank.get(edge.source) ?? 0) + 1;
      if (wanted > (rank.get(edge.target) ?? 0)) {
        rank.set(edge.target, wanted);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const columns: ArchitectureNode[][] = [];
  for (const node of services) {
    const index = rank.get(node.id) ?? 0;
    const column = columns[index] ?? [];
    column.push(node);
    columns[index] = column;
  }

  const filled = columns.filter((column) => column?.length);

  // One barycentre pass: placing each node level with the average of whatever
  // points at it removes most crossings, and the columns are far too short for
  // repeated sweeps to be worth their unpredictability.
  const offsetOf = new Map<string, number>();
  for (const column of filled) {
    for (const [index, node] of column.entries()) {
      const incoming = relevant.filter((e) => e.target === node.id);
      const positions = incoming
        .map((e) => offsetOf.get(e.source))
        .filter((value): value is number => value !== undefined);

      offsetOf.set(
        node.id,
        positions.length
          ? positions.reduce((sum, value) => sum + value, 0) / positions.length
          : index,
      );
    }
    column.sort(
      (a, b) => (offsetOf.get(a.id) ?? 0) - (offsetOf.get(b.id) ?? 0),
    );
    // Re-seed from the settled order so the next column averages real slots.
    for (const [index, node] of column.entries()) offsetOf.set(node.id, index);
  }

  return filled;
}

/**
 * The space one row of frames needs.
 *
 * `columnWidths`, when given, replaces each frame's own width with its column's,
 * so the row occupies the grid rather than only itself. Measuring has to agree
 * with placing about this or a frame would be sized for one arrangement and
 * filled with another.
 */
function rowSize(
  row: ArchitectureNode[],
  measure: Measure,
  columnWidths?: number[],
) {
  const widths = row.map(
    (node, column) => columnWidths?.[column] ?? measure(node).width,
  );

  return {
    width:
      widths.reduce((sum, width) => sum + width, 0) +
      GAP * Math.max(0, row.length - 1),
    height: Math.max(0, ...row.map((node) => measure(node).height)),
  };
}

/**
 * Public subnets come first, as they do in every hand-drawn diagram, and each
 * tier gets its own band of rows — so "first" means the top-left row.
 */
function publicFirst(a: ArchitectureNode, b: ArchitectureNode): number {
  const byRank = tierOf(a) - tierOf(b);

  return byRank !== 0
    ? byRank
    : (a.sublabel ?? a.label).localeCompare(b.sublabel ?? b.label);
}

function tierOf(node: ArchitectureNode): number {
  return node.icon === "subnet-public" ? 0 : 1;
}

/**
 * How a frame's network children are laid out beneath it.
 *
 * `columnWidths` is present only in the availability-zone grid, where a column
 * has to be as wide as the widest frame in it so columns line up between rows.
 *
 * Unused today: the zone grid that needed it is gone, because a tier of three
 * subnets is now one frame rather than three side by side. Kept because `place`
 * still honours it, so a future arrangement that does want aligned columns has
 * somewhere to say so without re-threading the geometry.
 */
interface ContainerRows {
  rows: ArchitectureNode[][];
  columnWidths?: number[];
}

/**
 * Arranges a frame's subnets into rows: public band on top, private below.
 *
 * One row was fine while a subnet was an empty 200px box, and stopped being
 * fine as soon as workloads were drawn inside them. A VPC module declares seven
 * subnets, one of which now holds an EC2 module frame, and side by side they came
 * to 2164px — a strip the canvas can only fit by zooming until the labels are
 * gone.
 *
 * Two things start a new row: exceeding the width budget, and crossing from the
 * public tier into the private one. The second is the reason this reads as an
 * AWS diagram rather than as a wrapped list.
 *
 * Both the measuring and the placing pass call this, so a frame can never be
 * sized from one arrangement and filled with another. It is a pure function of
 * the children and their sizes, which is what makes that safe.
 */
function packSubnetRows(
  containers: ArchitectureNode[],
  measure: Measure,
): ContainerRows {
  if (containers.length === 0) return { rows: [] };

  const ordered = [...containers].sort(publicFirst);
  const sizes = ordered.map(measure);

  const area = sizes.reduce((sum, size) => sum + size.width * size.height, 0);
  // Same reasoning as `wrapTallColumns`, in the other direction: the width a
  // rectangle of this area would have at the shape a canvas actually is. Never
  // below the widest child, since a limit it cannot meet would put every subnet
  // on a row of its own.
  const limit = Math.max(
    ...sizes.map((size) => size.width),
    Math.sqrt(area * AREA_SLACK * TARGET_ASPECT),
  );

  const rows: ArchitectureNode[][] = [];
  let current: ArchitectureNode[] = [];
  let width = 0;

  for (const [index, node] of ordered.entries()) {
    const size = sizes[index] ?? { width: SERVICE_WIDTH, height: 0 };
    const previous = current[current.length - 1];
    const newTier = previous !== undefined && tierOf(previous) !== tierOf(node);

    if (current.length > 0 && (newTier || width + GAP + size.width > limit)) {
      rows.push(current);
      current = [];
      width = 0;
    }

    current.push(node);
    width += (width > 0 ? GAP : 0) + size.width;
  }

  if (current.length > 0) rows.push(current);

  return { rows };
}
