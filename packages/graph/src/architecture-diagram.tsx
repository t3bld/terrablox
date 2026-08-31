"use client";

import {
  applyNodeChanges,
  Background,
  Controls,
  Handle,
  MarkerType,
  type Node,
  type NodeChange,
  type NodeMouseHandler,
  type NodeProps,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { KeepSelectionInView } from "./keep-selection-in-view";
import { ResetLayoutButton } from "./reset-layout-button";

/** Inlined rather than pulling lucide-react into this package for two glyphs. */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      className="h-3 w-3 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2.5"
      viewBox="0 0 24 24"
    >
      <title>{open ? "Collapse" : "Expand"}</title>
      <path d={open ? "M6 9l6 6 6-6" : "M9 18l6-6-6-6"} />
    </svg>
  );
}

/**
 * A node that contains other nodes (VPC, subnet). Drawn as a labelled frame
 * behind its contents.
 */
export type ArchitectureFrameKind =
  | "vpc"
  | "subnet-public"
  | "subnet-private"
  | "module";

export interface ArchitectureDiagramNode {
  id: string;
  /** `null` renders a service tile, anything else renders a frame. */
  frame: ArchitectureFrameKind | null;
  label: string;
  sublabel?: string;
  /** File name (without extension) under `iconBasePath`. */
  icon?: string;
  /** Number of underlying resources folded into this node. */
  count?: number;
  /**
   * The single availability zone this box is pinned to.
   *
   * Absent means it covers its whole tier, which is the ordinary case and needs no
   * marking — the frame around it already says how many subnets that is. Present
   * is the exception: one NAT gateway in a three-zone tier, and a reader has no
   * other way to see that the other two zones route through it.
   */
  zone?: string;
  /**
   * Resources that serve this box without being drawn themselves — an IAM role
   * and its policies, a KMS key, a security group. Shown as a badge rather than
   * as boxes, because they are properties of this thing rather than components
   * beside it. Largest group first, which is the order the badge shows them in
   * and the order it drops them from once there are more than it can name.
   */
  attachments?: { service: string; icon?: string; count: number }[];
  /**
   * Built by another repository rather than here. Marked so a reader can tell
   * at a glance which boxes they can open and which are defined in this module.
   */
  moduleCall?: boolean;
  /** Set when the called module has been imported, making the tile a link. */
  href?: string;
  /**
   * Identifies this box for expand and collapse. Present only on module calls
   * whose target has been imported and has something to show.
   */
  expandPath?: string;
  /** How many boxes appear on opening, so the click promises something real. */
  expandableCount?: number;
  expanded?: boolean;
  /**
   * The callee is pinned to a version other than the imported one, so what is
   * drawn inside is not exactly what this module would get.
   */
  versionMismatch?: string;
  parentId?: string;
  position: { x: number; y: number };
  width: number;
  height: number;
}

export interface ArchitectureDiagramEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

export interface ArchitectureDiagramProps {
  /**
   * Parents must appear before their children — React Flow renders in array
   * order and would otherwise paint frames over their contents.
   */
  nodes: ArchitectureDiagramNode[];
  edges: ArchitectureDiagramEdge[];
  iconBasePath?: string;
  className?: string;
  /**
   * Fills the parent instead of using the built-in canvas height. For callers
   * that already own a full-height pane, such as the project graph.
   */
  fill?: boolean;
  onToggleExpand?: (path: string) => void;
  /**
   * Positions the reader arranged themselves, keyed by node id. A node inside a
   * frame is stored relative to that frame, exactly as React Flow reports it.
   */
  nodePositions?: Readonly<Record<string, { x: number; y: number }>>;
  onNodePositionsChange?: (
    positions: Record<string, { x: number; y: number }>,
  ) => void;
  onResetLayout?: () => void;
  /** Called with the clicked node, so a caller can open a detail panel on it. */
  onNodeClick?: (node: ArchitectureDiagramNode) => void;
  /**
   * The node whose connections are picked out. Controlled from outside so the
   * highlight and the detail panel can never disagree about what is selected.
   */
  highlightedNodeId?: string | null;
  /** Called when the user clicks the empty canvas, to drop the selection. */
  onPaneClick?: () => void;
}

type FlowNode = Node<{
  label: string;
  sublabel?: string;
  icon?: string;
  count: number;
  zone?: string;
  attachments?: { service: string; icon?: string; count: number }[];
  moduleCall?: boolean;
  href?: string;
  iconBasePath: string;
  expandPath?: string;
  expandableCount?: number;
  expanded?: boolean;
  versionMismatch?: string;
  onToggleExpand?: (path: string) => void;
}>;

/**
 * Grabbing a frame anywhere would cost the reader the ability to pan: a VPC
 * covers most of the canvas, and its empty space is where one drags to move
 * the view. Only the label strip starts a frame drag.
 */
const FRAME_DRAG_HANDLE = "tbx-frame-grip";

const frameStyles: Record<ArchitectureFrameKind, string> = {
  vpc: "border-2 border-[#8c4fff]/60 bg-[#8c4fff]/[0.04]",
  "subnet-public": "border border-[#7aa116]/70 bg-[#7aa116]/[0.06]",
  "subnet-private": "border border-[#00a4a6]/70 bg-[#00a4a6]/[0.06]",
  // Dashed like a collapsed module call, because it is the same thing opened:
  // a box whose contents come from another repository.
  module: "border-2 border-dashed border-muted-foreground/40 bg-muted/30",
};

/**
 * The layout reserves room for this label, but a bad estimate must never let
 * text escape the frame — hence the clamp as well.
 */
function Frame({
  data,
  kind,
}: {
  data: FlowNode["data"];
  kind: ArchitectureFrameKind;
}) {
  return (
    <div
      className={`h-full w-full rounded-lg ${frameStyles[kind]}`}
      // The frame sits behind its children; without this it would swallow
      // hover and click events aimed at the services inside it, and dragging
      // over its empty space would no longer pan the canvas.
      style={{ pointerEvents: "none" }}
    >
      {/* `pointer-events` is re-enabled here alone, so the label is the one
          part of a frame that answers to the pointer. */}
      <div
        className={`${FRAME_DRAG_HANDLE} pointer-events-auto flex max-w-full cursor-grab items-center gap-1.5 overflow-hidden px-3 pt-2.5 active:cursor-grabbing`}
      >
        {data.icon ? (
          <img
            alt=""
            className="h-4 w-4 shrink-0"
            src={`${data.iconBasePath}/${data.icon}.svg`}
          />
        ) : null}
        <span className="shrink-0 font-semibold text-[11px] text-muted-foreground uppercase tracking-wide">
          {data.label}
        </span>
        {data.sublabel ? (
          <code className="truncate font-mono text-[10px] text-muted-foreground/70">
            {data.sublabel}
          </code>
        ) : null}
      </div>
    </div>
  );
}

function VpcFrame({ data }: NodeProps<FlowNode>) {
  return <Frame data={data} kind="vpc" />;
}

function PublicSubnetFrame({ data }: NodeProps<FlowNode>) {
  return <Frame data={data} kind="subnet-public" />;
}

function PrivateSubnetFrame({ data }: NodeProps<FlowNode>) {
  return <Frame data={data} kind="subnet-private" />;
}

/**
 * An opened module call. Unlike the network frames this one is a genuine edge
 * endpoint — things point at the module, not at the resources inside it — so it
 * carries the same handles a tile does, and its header stays clickable to close
 * it again.
 */
function ModuleFrame({ data }: NodeProps<FlowNode>) {
  const toggle = data.onToggleExpand;
  const path = data.expandPath;

  return (
    <div
      className={`h-full w-full rounded-lg ${frameStyles.module}`}
      // Same reasoning as the network frames: the body must stay transparent
      // to the pointer so the services inside it and the pan gesture both
      // still work.
      style={{ pointerEvents: "none" }}
    >
      {HANDLE_SIDES.map(([id, position]) => (
        <Fragment key={id}>
          <Handle
            className="!opacity-0"
            id={`s-${id}`}
            isConnectable={false}
            position={position}
            type="source"
          />
          <Handle
            className="!opacity-0"
            id={`t-${id}`}
            isConnectable={false}
            position={position}
            type="target"
          />
        </Fragment>
      ))}

      <div
        className={`${FRAME_DRAG_HANDLE} pointer-events-auto flex max-w-full cursor-grab items-center gap-1.5 px-2.5 pt-2 active:cursor-grabbing`}
      >
        {path && toggle ? (
          <button
            // `nodrag` keeps React Flow from reading the press that collapses
            // the module as the start of a drag.
            className="nodrag pointer-events-auto flex shrink-0 cursor-pointer items-center gap-1 rounded px-1 py-0.5 font-semibold text-[11px] text-muted-foreground uppercase tracking-wide hover:bg-muted hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation();
              toggle(path);
            }}
            title="Collapse this module"
            type="button"
          >
            <Chevron open={true} />
            {data.label}
          </button>
        ) : (
          <span className="shrink-0 font-semibold text-[11px] text-muted-foreground uppercase tracking-wide">
            {data.label}
          </span>
        )}
        {data.sublabel ? (
          <code className="truncate font-mono text-[10px] text-muted-foreground/70">
            {data.sublabel}
          </code>
        ) : null}
        {data.versionMismatch ? (
          <span
            className="shrink-0 rounded bg-amber-500/15 px-1.5 py-px font-medium text-[10px] text-amber-700 dark:text-amber-400"
            title={`This module call requests ${data.versionMismatch}, but the imported copy is a different version. The contents shown are from the imported one.`}
          >
            wants {data.versionMismatch}
          </span>
        ) : null}
      </div>
    </div>
  );
}

const HANDLE_SIDES = [
  ["t", Position.Top],
  ["r", Position.Right],
  ["b", Position.Bottom],
  ["l", Position.Left],
] as const;

/**
 * How many service icons the badge shows before it stops naming them.
 *
 * Four 16px icons overlapped by 6px come to 46px, which sits inside the 150px
 * tile width and so cannot reach the tile in the next column. A fifth would push
 * the row past the icon in the middle of the tile, and at that point the badge
 * has stopped being a marker and become a second row of content.
 */
const BADGE_ICON_LIMIT = 4;

/**
 * Which undrawn services serve a tile, and how many resources in total.
 *
 * Placed over the border rather than inside the tile's column on purpose: the
 * tile height is fixed by the layout and already carries an icon, a label, a
 * Terraform name and sometimes an expand button. A badge that took part in that
 * stack would either overflow or force every tile in the diagram to grow for the
 * sake of the few that have one.
 *
 * One icon per service rather than only the largest group's. A Transit Gateway
 * module hides EC2 route tables, RAM shares and a VPC route behind one box, and
 * showing the EC2 icon alone said the hidden resources were EC2 — a reader had no
 * way to know sharing was involved at all without opening the panel. The icons
 * overlap the way a group of avatars does, which is the established way to say
 * "several kinds of thing" in a space that only fits one.
 *
 * Deliberately not one count per service: four counts do not fit here, and they
 * are already listed per service, per resource and per file in the detail panel
 * one click away. The badge answers "which services, and how much" — the panel
 * answers "exactly what".
 *
 * Stacked horizontally rather than vertically because the vertical gap between
 * tiles is 24px while the horizontal one is 76px and carries the arrows: a column
 * of chips would either collide with the tile above or sit in the corridor the
 * edges travel down.
 */
function AttachmentBadge({
  attachments,
  iconBasePath,
}: {
  attachments: NonNullable<FlowNode["data"]["attachments"]>;
  iconBasePath: string;
}) {
  const total = attachments.reduce((sum, entry) => sum + entry.count, 0);

  // Services with no vendored icon would otherwise take a slot and draw nothing,
  // so they are counted in the overflow instead of shown as a gap.
  const withIcons = attachments.filter((entry) => entry.icon);
  const shown = withIcons.slice(0, BADGE_ICON_LIMIT);
  const hiddenServices = attachments.length - shown.length;

  return (
    <div
      className="absolute -top-2 -right-2 flex items-center gap-1 rounded-full border bg-background py-0.5 pr-1.5 pl-1 shadow-sm"
      title={`${total} supporting resource${total === 1 ? "" : "s"} not drawn: ${attachments
        .map((entry) => `${entry.service} ${entry.count}`)
        .join(", ")}`}
    >
      <span className="flex shrink-0 items-center">
        {shown.map((entry, index) => (
          <img
            alt=""
            // Ringed so overlapping icons stay separable, and the later ones sit
            // on top so the leftmost — the largest group — reads as the front.
            className={`h-4 w-4 shrink-0 rounded-full bg-background ring-1 ring-background ${
              index > 0 ? "-ml-1.5" : ""
            }`}
            key={entry.service}
            src={`${iconBasePath}/${entry.icon}.svg`}
            title={`${entry.service}: ${entry.count}`}
          />
        ))}
      </span>

      {hiddenServices > 0 ? (
        <span className="shrink-0 font-medium text-[10px] text-muted-foreground">
          +{hiddenServices}
        </span>
      ) : null}

      {/* Bigger than the rest of the tile's text on purpose: at 9px with a 12px
          icon this was the one element on the diagram people had to lean in for,
          and it is carrying the count of everything the box hides. */}
      <span className="font-medium text-[11px] text-muted-foreground tabular-nums">
        {total}
      </span>
    </div>
  );
}

function ServiceTile({ data }: NodeProps<FlowNode>) {
  return (
    <div
      className={`relative flex h-full w-full cursor-grab flex-col items-center justify-center gap-1 rounded-md bg-card px-2 py-2 shadow-sm active:cursor-grabbing ${
        // A dashed edge marks a box whose innards are defined elsewhere, the
        // same convention the Connections view uses for data sources.
        data.moduleCall ? "border-2 border-dashed" : "border"
      }`}
    >
      {data.attachments?.length ? (
        <AttachmentBadge
          attachments={data.attachments}
          iconBasePath={data.iconBasePath}
        />
      ) : null}
      {/* One pair per side so an edge can leave and enter on whichever side
          faces the other node — see pickHandles. */}
      {HANDLE_SIDES.map(([id, position]) => (
        <Fragment key={id}>
          <Handle
            className="!opacity-0"
            id={`s-${id}`}
            isConnectable={false}
            position={position}
            type="source"
          />
          <Handle
            className="!opacity-0"
            id={`t-${id}`}
            isConnectable={false}
            position={position}
            type="target"
          />
        </Fragment>
      ))}
      {data.icon ? (
        <img
          alt=""
          className="h-8 w-8 shrink-0"
          src={`${data.iconBasePath}/${data.icon}.svg`}
        />
      ) : null}
      {data.href ? (
        <a
          // `nodrag`: following the link is a click, and without it React Flow
          // would treat the press as the beginning of a drag.
          className="nodrag pointer-events-auto shrink-0 cursor-pointer text-center font-medium text-xs leading-tight underline-offset-2 hover:underline"
          href={data.href}
        >
          {data.label}
        </a>
      ) : (
        <span className="shrink-0 text-center font-medium text-xs leading-tight">
          {data.label}
        </span>
      )}
      {data.sublabel ? (
        <code className="max-w-full shrink-0 truncate font-mono text-[10px] text-muted-foreground">
          {data.sublabel}
        </code>
      ) : null}
      {data.count > 1 ? (
        <span className="shrink-0 text-[10px] text-muted-foreground">
          ×{data.count}
        </span>
      ) : null}
      {/* Only ever the exception. A box with no zone covers its whole tier, and
          the frame around it says how many subnets that is — marking every one of
          them "all zones" would be a label on the normal case. */}
      {data.zone ? (
        <span
          className="shrink-0 rounded bg-muted px-1.5 py-px font-mono text-[10px] text-muted-foreground"
          title={`Only in ${data.zone}. The tier around it spans more than one availability zone; this box is in that one.`}
        >
          {data.zone}
        </span>
      ) : null}
      {data.expandPath && data.onToggleExpand ? (
        <button
          className="nodrag pointer-events-auto mt-0.5 flex shrink-0 cursor-pointer items-center gap-0.5 rounded border bg-background px-1.5 py-px font-medium text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={(event) => {
            // Without this the click also reaches the label link behind it.
            event.stopPropagation();
            event.preventDefault();
            data.onToggleExpand?.(data.expandPath as string);
          }}
          title={`Show the ${data.expandableCount} boxes inside this module`}
          type="button"
        >
          <Chevron open={false} />+{data.expandableCount}
        </button>
      ) : null}
    </div>
  );
}

const nodeTypes = {
  vpc: VpcFrame,
  "subnet-public": PublicSubnetFrame,
  "subnet-private": PrivateSubnetFrame,
  module: ModuleFrame,
  service: ServiceTile,
};

const FIT_OPTIONS = { padding: 0.12, minZoom: 0.2, maxZoom: 1.2 };

/**
 * `fitView` on <ReactFlow> only runs at mount. Expanding a module replaces the
 * node set with a much larger one, and without this the viewport keeps showing
 * the old, smaller bounds — the diagram looks half empty and cropped.
 */
function FitOnLayoutChange({ signature }: { signature: string }) {
  const flow = useReactFlow();
  const previous = useRef(signature);

  useEffect(() => {
    if (previous.current === signature) return;
    previous.current = signature;

    // A frame lets React Flow measure the new nodes before the fit is computed.
    const handle = requestAnimationFrame(() => flow.fitView(FIT_OPTIONS));
    return () => cancelAnimationFrame(handle);
  }, [signature, flow]);

  return null;
}

export function ArchitectureDiagram({
  nodes,
  edges,
  iconBasePath = "/aws-icons",
  className,
  fill = false,
  onToggleExpand,
  nodePositions,
  onNodePositionsChange,
  onResetLayout,
  onNodeClick,
  highlightedNodeId,
  onPaneClick,
}: ArchitectureDiagramProps) {
  const layoutedNodes = useMemo<FlowNode[]>(
    () =>
      nodes.map((node) => ({
        id: node.id,
        type: node.frame ?? "service",
        position: node.position,
        parentId: node.parentId,
        // Deliberately no `extent: "parent"`: frames are measured to fit their
        // contents exactly, so confining a tile to its frame would leave it
        // almost no room and the dragging would look broken. Reset layout is
        // there for when the result gets untidy.
        draggable: true,
        // A frame is grabbed by its label only; see FRAME_DRAG_HANDLE.
        dragHandle: node.frame ? `.${FRAME_DRAG_HANDLE}` : undefined,
        selectable: false,
        connectable: false,
        // Frames paint under their contents, and both paint over the edges so
        // that a connection crossing the diagram runs behind the tiles instead
        // of over their labels.
        // A module frame sits above the network frames but still below the
        // tiles it contains, so its header stays clickable without covering
        // its own contents.
        zIndex: node.frame === "module" ? 5 : node.frame ? 1 : 10,
        style: {
          width: node.width,
          height: node.height,
          // React Flow gives a draggable node's wrapper `pointer-events: all`,
          // which for a frame covering half the canvas would mean the reader
          // could no longer drag the empty space to pan. Turning it off here
          // wins because the wrapper style is spread after that default; the
          // label strip switches it back on for itself, and events starting
          // there still bubble to the wrapper that runs the drag.
          ...(node.frame ? { pointerEvents: "none" as const } : {}),
        },
        data: {
          label: node.label,
          sublabel: node.sublabel,
          icon: node.icon,
          count: node.count ?? 1,
          zone: node.zone,
          attachments: node.attachments,
          moduleCall: node.moduleCall,
          href: node.href,
          iconBasePath,
          expandPath: node.expandPath,
          expandableCount: node.expandableCount,
          expanded: node.expanded,
          versionMismatch: node.versionMismatch,
          onToggleExpand,
        },
      })),
    [nodes, iconBasePath, onToggleExpand],
  );

  // Positions included: expanding a module moves the existing boxes as well as
  // adding new ones, and a count alone would miss that.
  const layoutSignature = useMemo(
    () =>
      nodes
        .map(
          (n) =>
            `${n.id}:${n.position.x},${n.position.y},${n.width}x${n.height}`,
        )
        .join("|"),
    [nodes],
  );

  const [flowNodes, setFlowNodes] = useState<FlowNode[]>(layoutedNodes);
  const [hasMovedNodes, setHasMovedNodes] = useState(false);

  const positionsSignature = useMemo(
    () => serializePositions(nodePositions),
    [nodePositions],
  );

  // Read through a ref so the effect below can depend on the two signatures
  // instead of the objects: a caller that builds them inline would otherwise
  // re-seed on every render and snap a node back mid-drag.
  const latest = useRef({ layoutedNodes, nodePositions });
  latest.current = { layoutedNodes, nodePositions };

  // Re-seed when the computed layout changes (expanding a module, new data) or
  // when stored positions arrive from outside, which happens once after the
  // caller has loaded them.
  // biome-ignore lint/correctness/useExhaustiveDependencies: signatures replace the objects read via ref
  useEffect(() => {
    setFlowNodes(
      applyStoredPositions(
        latest.current.layoutedNodes,
        latest.current.nodePositions,
      ),
    );
    setHasMovedNodes(false);
  }, [layoutSignature, positionsSignature]);

  const handleNodesChange = useCallback(
    (changes: Array<NodeChange<FlowNode>>) => {
      setFlowNodes((current) => {
        const next = applyNodeChanges(changes, current);

        // Drag end only: emitting per frame would make a persisting caller
        // write on every mouse move.
        if (
          changes.some(
            (change) => change.type === "position" && change.dragging === false,
          )
        ) {
          onNodePositionsChange?.(collectPositions(next));
        }

        return next;
      });

      if (
        changes.some((change) => change.type === "position" && change.dragging)
      ) {
        setHasMovedNodes(true);
      }
    },
    [onNodePositionsChange],
  );

  const resetLayout = useCallback(() => {
    setFlowNodes(latest.current.layoutedNodes);
    setHasMovedNodes(false);
    onResetLayout?.();
  }, [onResetLayout]);

  // Owned by the caller, which also renders the detail panel: two states for
  // one selection would eventually disagree about what is being inspected.
  const highlightedId = highlightedNodeId ?? null;

  // Only a move the reader made counts. React Flow passes an event for those
  // and nothing for its own fits, which is the distinction that matters here.
  const [viewportMoved, setViewportMoved] = useState(false);
  const handleMove = useCallback((event: MouseEvent | TouchEvent | null) => {
    if (event) setViewportMoved(true);
  }, []);

  const handleNodeClick = useCallback<NodeMouseHandler<FlowNode>>(
    (_event, node) => {
      const clicked = nodes.find((candidate) => candidate.id === node.id);
      if (clicked) onNodeClick?.(clicked);
    },
    [nodes, onNodeClick],
  );

  /**
   * Counted from the edges actually drawn, so the legend cannot promise a
   * connection that lives inside a collapsed module.
   */
  const highlight = useMemo(() => {
    if (!highlightedId) return null;

    let outgoing = 0;
    let incoming = 0;
    const neighbours = new Set<string>([highlightedId]);

    for (const edge of edges) {
      if (edge.source === highlightedId) {
        outgoing++;
        neighbours.add(edge.target);
      }
      if (edge.target === highlightedId) {
        incoming++;
        neighbours.add(edge.source);
      }
    }

    // Whatever sits inside the picked node stays lit. A frame *is* its
    // contents; grey them out and the selection would look switched off. This
    // is the same reasoning that keeps frames lit when a tile inside is picked,
    // applied downwards instead of upwards.
    const childrenOf = new Map<string, string[]>();
    for (const node of nodes) {
      if (!node.parentId) continue;
      const siblings = childrenOf.get(node.parentId);
      if (siblings) siblings.push(node.id);
      else childrenOf.set(node.parentId, [node.id]);
    }

    const queue = [highlightedId];
    while (queue.length > 0) {
      // biome-ignore lint/style/noNonNullAssertion: guarded by queue.length
      const id = queue.pop()!;
      for (const child of childrenOf.get(id) ?? []) {
        if (neighbours.has(child)) continue;
        neighbours.add(child);
        queue.push(child);
      }
    }

    return { outgoing, incoming, neighbours };
  }, [highlightedId, edges, nodes]);

  const flowEdges = useMemo(() => {
    // Read from the live nodes, not the computed layout: after a drag the
    // stored sides would be stale and edges would sprout from the wrong face.
    // Sizes come from the props, which dragging does not change.
    const sizeById = new Map(nodes.map((n) => [n.id, n]));
    const byId = new Map(flowNodes.map((n) => [n.id, n]));

    // Positions are relative to the parent frame, so a node's real location is
    // only known after walking the chain up to the root.
    const centre = (id: string): { x: number; y: number } | null => {
      const node = byId.get(id);
      const size = sizeById.get(id);
      if (!node || !size) return null;

      let x = node.position.x + size.width / 2;
      let y = node.position.y + size.height / 2;
      let parent = node.parentId ? byId.get(node.parentId) : undefined;
      const seen = new Set<string>([node.id]);

      while (parent && !seen.has(parent.id)) {
        seen.add(parent.id);
        x += parent.position.x;
        y += parent.position.y;
        parent = parent.parentId ? byId.get(parent.parentId) : undefined;
      }

      return { x, y };
    };

    return edges.map((edge) => {
      const [sourceHandle, targetHandle] = pickHandles(
        centre(edge.source),
        centre(edge.target),
      );

      // Outgoing edges animate as well as change colour; see styles.css for
      // why direction is not carried by colour alone.
      const outgoing = edge.source === highlightedId;
      const incoming = edge.target === highlightedId;

      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceHandle,
        targetHandle,
        label: edge.label,
        // Right angles read as an architecture diagram; a bezier between nodes
        // at different nesting depths sweeps across half the canvas.
        type: "smoothstep",
        markerEnd: { type: MarkerType.ArrowClosed },
        animated: outgoing,
        className: outgoing
          ? "tbx-edge-out"
          : incoming
            ? "tbx-edge-in"
            : highlightedId
              ? "tbx-edge-muted"
              : undefined,
        style: { strokeWidth: 1.5 },
      };
    });
  }, [edges, nodes, flowNodes, highlightedId]);

  /**
   * Emphasis is applied here rather than stored on the nodes: `flowNodes` is
   * the record of where things sit, and rewriting it on every click would risk
   * losing a position mid-drag.
   */
  const renderedNodes = useMemo(() => {
    if (!highlight) return flowNodes;

    return flowNodes.map((node) => {
      if (node.id === highlightedId)
        return { ...node, className: "tbx-node-picked" };

      // Frames are never faded: they are the context a highlighted box sits
      // in, and dimming the VPC around it would take that context away.
      return node.type === "service" && !highlight.neighbours.has(node.id)
        ? { ...node, className: "tbx-node-muted" }
        : node;
    });
  }, [flowNodes, highlight, highlightedId]);

  return (
    <ReactFlowProvider>
      <div
        // Nesting makes these diagrams roughly square, so a short canvas is what
        // caps the zoom, not the layout. Grows with the window, with a floor so
        // a laptop still gets a usable picture — unless the caller already has a
        // pane of its own to fill.
        className={`tbx-dependency-graph w-full overflow-hidden rounded-lg border bg-background ${
          fill ? "h-full" : "h-[calc(100vh-25rem)] min-h-[24rem]"
        } ${className ?? ""}`}
      >
        <ReactFlow
          edges={flowEdges}
          fitView
          fitViewOptions={FIT_OPTIONS}
          maxZoom={1.5}
          // Must not exceed fitViewOptions.minZoom, which the instance clamps.
          minZoom={0.1}
          nodes={renderedNodes}
          nodesConnectable={false}
          nodesDraggable
          nodeTypes={nodeTypes}
          proOptions={{ hideAttribution: true }}
          onMove={handleMove}
          onNodeClick={handleNodeClick}
          onNodesChange={handleNodesChange}
          onPaneClick={onPaneClick}
        >
          <FitOnLayoutChange signature={layoutSignature} />
          <KeepSelectionInView
            fitViewOptions={FIT_OPTIONS}
            nodeId={highlightedId}
            viewportMoved={viewportMoved}
          />
          <Background className="bg-background" gap={24} />
          <Controls showInteractive={false} />
          {hasMovedNodes || Object.keys(nodePositions ?? {}).length > 0 ? (
            <Panel position="top-right">
              <ResetLayoutButton
                fitViewOptions={FIT_OPTIONS}
                onReset={resetLayout}
                refit
              />
            </Panel>
          ) : null}
        </ReactFlow>
      </div>
    </ReactFlowProvider>
  );
}

/**
 * Overlays stored positions onto the computed layout. Nodes without an entry
 * keep their computed spot, so a layout saved before a module was expanded
 * still places the boxes it knows about.
 *
 * A stored position is dropped when it would put a box completely outside the
 * frame it belongs to. Positions are relative to the parent, so they only mean
 * anything against a particular frame size — and a frame is measured to fit its
 * contents, which change. A VPC drawn as one wide row of seven subnets was 1676px
 * across; the same VPC drawn as wrapped rows is 729px, and every position saved
 * from the first is off the edge of the second. The result read as a bug in the
 * diagram: subnets sitting outside their own VPC.
 */
function applyStoredPositions(
  layouted: FlowNode[],
  stored: Readonly<Record<string, { x: number; y: number }>> | undefined,
): FlowNode[] {
  if (!stored || Object.keys(stored).length === 0) return layouted;

  const sizeOf = (node: FlowNode) => ({
    width: Number(node.style?.width) || 0,
    height: Number(node.style?.height) || 0,
  });

  const parents = new Map<string, { width: number; height: number }>();
  for (const node of layouted) parents.set(node.id, sizeOf(node));

  return layouted.map((node) => {
    const position = stored[node.id];
    if (!position) return node;

    // A root box may sit anywhere; there is no frame for it to be outside of.
    const frame = node.parentId ? parents.get(node.parentId) : undefined;
    if (!frame) return { ...node, position };

    /**
     * Overlap, not containment. Dragging a box a little past its frame's edge is
     * allowed by design — see the note on `extent` above — so requiring it to fit
     * entirely would undo deliberate arrangements. A position left over from a
     * different frame size does not merely overhang, it misses the frame
     * altogether, and that is what this rejects.
     */
    const size = sizeOf(node);
    const overlaps =
      position.x < frame.width &&
      position.y < frame.height &&
      position.x + size.width > 0 &&
      position.y + size.height > 0;

    return overlaps ? { ...node, position } : node;
  });
}

function collectPositions(
  flowNodes: FlowNode[],
): Record<string, { x: number; y: number }> {
  const positions: Record<string, { x: number; y: number }> = {};
  for (const node of flowNodes) {
    positions[node.id] = { x: node.position.x, y: node.position.y };
  }
  return positions;
}

/** Order-independent so two equal layouts always produce the same string. */
function serializePositions(
  positions: Readonly<Record<string, { x: number; y: number }>> | undefined,
): string {
  if (!positions) return "";

  return Object.keys(positions)
    .sort()
    .map((key) => {
      const position = positions[key];
      return `${key}:${position?.x},${position?.y}`;
    })
    .join("|");
}

/**
 * Picks the sides an edge should leave and enter on, so a connection takes the
 * short way round instead of always leaving the bottom and looping back up.
 *
 * The dominant axis wins: nodes mostly side by side connect left/right, nodes
 * mostly stacked connect top/bottom.
 */
function pickHandles(
  source: { x: number; y: number } | null,
  target: { x: number; y: number } | null,
): [string, string] {
  if (!source || !target) return ["s-b", "t-t"];

  const dx = target.x - source.x;
  const dy = target.y - source.y;

  if (Math.abs(dx) > Math.abs(dy)) {
    return dx >= 0 ? ["s-r", "t-l"] : ["s-l", "t-r"];
  }

  return dy >= 0 ? ["s-b", "t-t"] : ["s-t", "t-b"];
}
