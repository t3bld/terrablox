"use client";

import dagre from "@dagrejs/dagre";
import {
  Background,
  type Connection,
  Controls,
  type Edge,
  Handle,
  MarkerType,
  MiniMap,
  type Node,
  type NodeChange,
  type NodeProps,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import {
  type DragEvent as ReactDragEvent,
  useCallback,
  useMemo,
  useState,
} from "react";

/**
 * The editable project canvas.
 *
 * Unlike the read-only dependency graph, every gesture here is a change to the
 * Terraform configuration: dropping a module writes a `module` block, drawing a
 * wire sets an argument, deleting removes them again. The component itself is
 * stateless about the repository — it reports intent through callbacks and
 * re-renders from whatever graph comes back, so the file on disk stays the
 * single source of truth.
 */

/** Payload a draggable module list must put on the drag event. */
export const PROJECT_MODULE_DRAG_TYPE = "application/x-terrablox-module";

export interface ProjectCanvasPort {
  name: string;
  description?: string | null;
  required?: boolean;
  type?: string | null;
}

export interface ProjectCanvasNode {
  id: string;
  label: string;
  moduleName?: string | null;
  version?: string | null;
  source?: string | null;
  /** False when the block's source does not match any imported module. */
  linked?: boolean;
  inputs: ProjectCanvasPort[];
  outputs: ProjectCanvasPort[];
  /** Arguments already set in the block, wired or literal. */
  setArguments?: string[];
  position?: { x: number; y: number } | null;
}

export interface ProjectCanvasLink {
  targetInput: string;
  sourceOutput: string | null;
}

export interface ProjectCanvasEdge {
  id: string;
  source: string;
  target: string;
  links: ProjectCanvasLink[];
}

export interface ProjectCanvasConnection {
  source: string;
  sourceOutput: string;
  target: string;
  targetInput: string;
}

export interface ProjectCanvasProps {
  nodes: readonly ProjectCanvasNode[];
  edges: readonly ProjectCanvasEdge[];
  className?: string;
  /** Blocks edits while a commit is in flight. */
  busy?: boolean;
  onConnect?: (connection: ProjectCanvasConnection) => void;
  onDisconnect?: (link: { target: string; targetInput: string }) => void;
  onRemoveNode?: (name: string) => void;
  onNodeClick?: (node: ProjectCanvasNode) => void;
  /** Highlights the node the inspector is showing, selection being external. */
  selectedNodeId?: string | null;
  /** Fires on drag end only, so callers can persist without debouncing. */
  onPositionsChange?: (
    positions: Record<string, { x: number; y: number }>,
  ) => void;
  /** A module dragged in from the library, with the drop point in graph space. */
  onDropModule?: (moduleId: string, position: { x: number; y: number }) => void;
}

const NODE_WIDTH = 280;
const HEADER_HEIGHT = 74;
const PORT_HEIGHT = 24;
const FOOTER_HEIGHT = 16;

/** Handle used when a wire's exact port is unknown or hidden. */
const ANY_PORT = "*";

type ProjectFlowNodeData = Record<string, unknown> & {
  node: ProjectCanvasNode;
  visibleInputs: ProjectCanvasPort[];
  visibleOutputs: ProjectCanvasPort[];
  hiddenCount: number;
  expanded: boolean;
  connectedInputs: Set<string>;
  onToggle: () => void;
};

type ProjectFlowNode = Node<ProjectFlowNodeData, "projectModule">;

type ProjectFlowEdgeData = Record<string, unknown> & {
  target: string;
  targetInput: string;
};

export function ProjectCanvas(props: ProjectCanvasProps) {
  return (
    <ReactFlowProvider>
      <ProjectCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

function ProjectCanvasInner({
  nodes,
  edges,
  className,
  busy = false,
  onConnect,
  onDisconnect,
  onRemoveNode,
  onNodeClick,
  selectedNodeId = null,
  onPositionsChange,
  onDropModule,
}: ProjectCanvasProps) {
  const { screenToFlowPosition } = useReactFlow();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [dragged, setDragged] = useState<
    Record<string, { x: number; y: number }>
  >({});

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

  const wiring = useMemo(() => collectWiring(nodes, edges), [nodes, edges]);
  const autoLayout = useMemo(
    () => layoutProjectGraph(nodes, edges, expanded, wiring),
    [nodes, edges, expanded, wiring],
  );

  const flowNodes = useMemo<ProjectFlowNode[]>(
    () =>
      nodes.map((node) => {
        const isExpanded = expanded.has(node.id);
        const connected = wiring.get(node.id) ?? emptyWiring;
        const visibleInputs = visiblePorts(node.inputs, isExpanded, (port) =>
          Boolean(
            port.required ||
              connected.inputs.has(port.name) ||
              node.setArguments?.includes(port.name),
          ),
        );
        const visibleOutputs = visiblePorts(node.outputs, isExpanded, (port) =>
          connected.outputs.has(port.name),
        );

        return {
          id: node.id,
          type: "projectModule" as const,
          position: dragged[node.id] ??
            node.position ??
            autoLayout[node.id] ?? { x: 0, y: 0 },
          data: {
            node,
            visibleInputs,
            visibleOutputs,
            hiddenCount:
              node.inputs.length +
              node.outputs.length -
              visibleInputs.length -
              visibleOutputs.length,
            expanded: isExpanded,
            connectedInputs: connected.inputs,
            onToggle: () => toggleExpanded(node.id),
          },
          selected: node.id === selectedNodeId,
          deletable: Boolean(onRemoveNode),
        };
      }),
    [
      nodes,
      expanded,
      wiring,
      dragged,
      autoLayout,
      toggleExpanded,
      onRemoveNode,
      selectedNodeId,
    ],
  );

  const flowEdges = useMemo<Edge<ProjectFlowEdgeData>[]>(() => {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const result: Edge<ProjectFlowEdgeData>[] = [];

    for (const edge of edges) {
      const source = byId.get(edge.source);
      const target = byId.get(edge.target);
      if (!source || !target) continue;

      for (const link of edge.links) {
        const hasOutput =
          link.sourceOutput !== null &&
          source.outputs.some((port) => port.name === link.sourceOutput);
        const hasInput = target.inputs.some(
          (port) => port.name === link.targetInput,
        );

        result.push({
          id: `${edge.id}:${link.targetInput}`,
          source: edge.source,
          target: edge.target,
          sourceHandle: `out:${hasOutput ? link.sourceOutput : ANY_PORT}`,
          targetHandle: `in:${hasInput ? link.targetInput : ANY_PORT}`,
          label: hasInput ? undefined : link.targetInput,
          animated: false,
          deletable: Boolean(onDisconnect),
          markerEnd: { type: MarkerType.ArrowClosed },
          data: { target: edge.target, targetInput: link.targetInput },
        });
      }
    }

    return result;
  }, [nodes, edges, onDisconnect]);

  const handleNodesChange = useCallback(
    (changes: NodeChange<ProjectFlowNode>[]) => {
      const moves: Record<string, { x: number; y: number }> = {};

      for (const change of changes) {
        if (change.type === "position" && change.position) {
          moves[change.id] = change.position;
        }
      }

      if (Object.keys(moves).length > 0) {
        setDragged((current) => ({ ...current, ...moves }));
      }
    },
    [],
  );

  const handleDragStop = useCallback(() => {
    if (onPositionsChange && Object.keys(dragged).length > 0) {
      onPositionsChange(dragged);
    }
  }, [dragged, onPositionsChange]);

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!onConnect) return;

      const sourceOutput = portName(connection.sourceHandle, "out:");
      const targetInput = portName(connection.targetHandle, "in:");

      // The wildcard handle exists so wires with an unknown port still render;
      // it carries no name, so it cannot start a new connection.
      if (!sourceOutput || !targetInput) return;
      if (!connection.source || !connection.target) return;
      if (connection.source === connection.target) return;

      onConnect({
        source: connection.source,
        sourceOutput,
        target: connection.target,
        targetInput,
      });
    },
    [onConnect],
  );

  const handleEdgesDelete = useCallback(
    (deleted: Edge<ProjectFlowEdgeData>[]) => {
      if (!onDisconnect) return;
      for (const edge of deleted) {
        if (edge.data) {
          onDisconnect({
            target: edge.data.target,
            targetInput: edge.data.targetInput,
          });
        }
      }
    },
    [onDisconnect],
  );

  const handleNodesDelete = useCallback(
    (deleted: ProjectFlowNode[]) => {
      if (!onRemoveNode) return;
      for (const node of deleted) onRemoveNode(node.id);
    },
    [onRemoveNode],
  );

  const handleDragOver = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!event.dataTransfer.types.includes(PROJECT_MODULE_DRAG_TYPE)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    [],
  );

  const handleDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!onDropModule || busy) return;

      const moduleId = event.dataTransfer.getData(PROJECT_MODULE_DRAG_TYPE);
      if (!moduleId) return;

      event.preventDefault();
      onDropModule(
        moduleId,
        screenToFlowPosition({ x: event.clientX, y: event.clientY }),
      );
    },
    [onDropModule, busy, screenToFlowPosition],
  );

  return (
    <div
      className={cn(
        "tbx-project-canvas relative h-full w-full overflow-hidden rounded-lg border bg-background",
        className,
      )}
      // A graph editor is a composite widget with its own pointer and keyboard
      // handling, which is exactly what the application role describes.
      role="application"
      aria-label="Project graph"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        onNodesChange={handleNodesChange}
        onNodeDragStop={handleDragStop}
        onConnect={handleConnect}
        onEdgesDelete={handleEdgesDelete}
        onNodesDelete={handleNodesDelete}
        onNodeClick={(_, node) => onNodeClick?.(node.data.node)}
        nodesDraggable={!busy}
        nodesConnectable={!busy && Boolean(onConnect)}
        elementsSelectable
        deleteKeyCode={busy ? null : ["Backspace", "Delete"]}
        minZoom={0.2}
        maxZoom={1.5}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background className="bg-background" gap={24} />
        <Controls showInteractive={false} />
        {nodes.length > 12 ? (
          <MiniMap
            pannable
            zoomable
            maskColor="hsl(var(--background) / 0.72)"
          />
        ) : null}
        {nodes.length === 0 ? (
          <Panel position="top-center">
            <div className="mt-16 max-w-sm rounded-lg border border-dashed bg-card px-6 py-5 text-center">
              <p className="text-sm font-medium">No modules yet</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Drag a module from the library onto the canvas, or ask the agent
                to build something.
              </p>
            </div>
          </Panel>
        ) : null}
      </ReactFlow>
    </div>
  );
}

function ProjectModuleNode({ data, selected }: NodeProps<ProjectFlowNode>) {
  const { node, visibleInputs, visibleOutputs, hiddenCount, expanded } = data;

  return (
    <div
      className={cn(
        "w-[280px] rounded-lg border bg-card text-card-foreground shadow-sm transition-shadow",
        selected ? "border-primary shadow-md" : "border-border",
        node.linked === false ? "border-dashed" : "",
      )}
    >
      {/* Node-level handles catch wires whose exact port is unknown. */}
      <Handle
        type="target"
        id={`in:${ANY_PORT}`}
        position={Position.Left}
        className="!h-2 !w-2 !border-background !bg-muted-foreground"
        style={{ top: 24 }}
        isConnectable={false}
      />
      <Handle
        type="source"
        id={`out:${ANY_PORT}`}
        position={Position.Right}
        className="!h-2 !w-2 !border-background !bg-muted-foreground"
        style={{ top: 24 }}
        isConnectable={false}
      />

      <div className="space-y-1 border-b px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-semibold">{node.label}</span>
          {node.version ? (
            <span className="shrink-0 rounded-full border px-2 py-0.5 text-[0.65rem] font-medium text-muted-foreground">
              {node.version}
            </span>
          ) : null}
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {node.moduleName ?? node.source ?? "unknown source"}
        </p>
        {node.linked === false ? (
          <p className="text-[0.65rem] font-medium text-amber-600">
            Not in your module library
          </p>
        ) : null}
      </div>

      <div className="py-1">
        {visibleInputs.map((port) => (
          <PortRow
            key={`in-${port.name}`}
            port={port}
            side="target"
            wired={data.connectedInputs.has(port.name)}
            set={node.setArguments?.includes(port.name) ?? false}
          />
        ))}
        {visibleOutputs.map((port) => (
          <PortRow key={`out-${port.name}`} port={port} side="source" />
        ))}
        {hiddenCount > 0 || expanded ? (
          <button
            type="button"
            onClick={data.onToggle}
            className="nodrag mt-1 w-full px-3 py-1 text-left text-[0.7rem] font-medium text-muted-foreground hover:text-foreground"
          >
            {expanded ? "Show less" : `Show ${hiddenCount} more`}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function PortRow({
  port,
  side,
  wired,
  set,
}: {
  port: ProjectCanvasPort;
  side: "source" | "target";
  wired?: boolean;
  set?: boolean;
}) {
  const isInput = side === "target";

  return (
    <div
      className={cn(
        "relative flex h-6 items-center gap-1 px-3 text-xs",
        isInput ? "justify-start" : "justify-end",
      )}
      title={port.description ?? undefined}
    >
      <Handle
        type={side}
        id={`${isInput ? "in" : "out"}:${port.name}`}
        position={isInput ? Position.Left : Position.Right}
        className={cn(
          "!h-2.5 !w-2.5 !border-2 !border-background",
          wired ? "!bg-primary" : "!bg-muted-foreground",
        )}
      />
      {isInput && port.required && !wired && !set ? (
        <span className="text-destructive" title="Required">
          *
        </span>
      ) : null}
      <span className="truncate">{port.name}</span>
    </div>
  );
}

const nodeTypes = { projectModule: ProjectModuleNode };

const emptyWiring = {
  inputs: new Set<string>(),
  outputs: new Set<string>(),
};

type Wiring = Map<string, { inputs: Set<string>; outputs: Set<string> }>;

/** Ports touched by an edge, so they stay visible even when collapsed. */
function collectWiring(
  nodes: readonly ProjectCanvasNode[],
  edges: readonly ProjectCanvasEdge[],
): Wiring {
  const wiring: Wiring = new Map(
    nodes.map((node) => [
      node.id,
      { inputs: new Set<string>(), outputs: new Set<string>() },
    ]),
  );

  for (const edge of edges) {
    for (const link of edge.links) {
      wiring.get(edge.target)?.inputs.add(link.targetInput);
      if (link.sourceOutput) {
        wiring.get(edge.source)?.outputs.add(link.sourceOutput);
      }
    }
  }

  return wiring;
}

/**
 * Which ports a collapsed node shows. Modules routinely declare dozens of
 * variables; listing them all would turn every node into a wall of text, so a
 * collapsed node shows only what matters — wired, required, or already set.
 */
function visiblePorts(
  ports: readonly ProjectCanvasPort[],
  expanded: boolean,
  keep: (port: ProjectCanvasPort) => boolean,
): ProjectCanvasPort[] {
  if (expanded) return [...ports];
  return ports.filter(keep);
}

function portName(
  handle: string | null | undefined,
  prefix: string,
): string | null {
  if (!handle?.startsWith(prefix)) return null;
  const name = handle.slice(prefix.length);
  return name && name !== ANY_PORT ? name : null;
}

function estimateHeight(
  node: ProjectCanvasNode,
  expanded: ReadonlySet<string>,
  wiring: Wiring,
): number {
  const connected = wiring.get(node.id) ?? emptyWiring;
  const visible = expanded.has(node.id)
    ? node.inputs.length + node.outputs.length
    : node.inputs.filter(
        (port) =>
          port.required ||
          connected.inputs.has(port.name) ||
          node.setArguments?.includes(port.name),
      ).length +
      node.outputs.filter((port) => connected.outputs.has(port.name)).length;

  return HEADER_HEIGHT + visible * PORT_HEIGHT + FOOTER_HEIGHT;
}

/**
 * Positions for nodes that have never been placed. Runs left-to-right so the
 * layout reads like the data flow it represents.
 */
function layoutProjectGraph(
  nodes: readonly ProjectCanvasNode[],
  edges: readonly ProjectCanvasEdge[],
  expanded: ReadonlySet<string>,
  wiring: Wiring,
): Record<string, { x: number; y: number }> {
  if (nodes.length === 0) return {};

  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: "LR", nodesep: 48, ranksep: 140 });

  for (const node of nodes) {
    graph.setNode(node.id, {
      width: NODE_WIDTH,
      height: estimateHeight(node, expanded, wiring),
    });
  }

  const ids = new Set(nodes.map((node) => node.id));
  for (const edge of edges) {
    if (ids.has(edge.source) && ids.has(edge.target)) {
      graph.setEdge(edge.source, edge.target);
    }
  }

  dagre.layout(graph);

  const positions: Record<string, { x: number; y: number }> = {};
  for (const node of nodes) {
    const placed = graph.node(node.id);
    if (!placed) continue;
    positions[node.id] = {
      x: placed.x - placed.width / 2,
      y: placed.y - placed.height / 2,
    };
  }

  return positions;
}

function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}
