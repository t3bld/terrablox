"use client";

import dagre from "@dagrejs/dagre";
import {
  Background,
  type Connection,
  Controls,
  type Edge,
  Handle,
  MarkerType,
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
  useEffect,
  useMemo,
  useRef,
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

/**
 * The drag payload, as JSON.
 *
 * It used to be the bare module id. The name travels with it now so the canvas
 * can label the placeholder it draws on drop — without it the box would have to
 * read "module" until the commit came back and said what it was.
 */
export interface ProjectModuleDragPayload {
  moduleId: string;
  /** Display name, only used for the provisional label. */
  name?: string;
}

/** Tolerates the bare-id form, so an older payload still drops correctly. */
export function readModuleDragPayload(
  raw: string,
): ProjectModuleDragPayload | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      const payload = parsed as Record<string, unknown>;
      if (typeof payload.moduleId === "string") {
        return {
          moduleId: payload.moduleId,
          name: typeof payload.name === "string" ? payload.name : undefined,
        };
      }
    }
    return null;
  } catch {
    return { moduleId: raw };
  }
}

export interface ProjectCanvasPort {
  name: string;
  description?: string | null;
  required?: boolean;
  type?: string | null;
}

/**
 * A module on the canvas.
 *
 * Only modules are drawn. Values — Terraform `locals` — used to be nodes here,
 * and the canvas was worse for it: a value has no ports, so its box existed only
 * to anchor one wire, and a project with a dozen tags read as a system with a
 * dozen extra components. They now live on the input that reads them, where the
 * name and the value are visible without following anything.
 */
export interface ProjectCanvasNode {
  /** Unique across the canvas; a module's block label. */
  id: string;
  /** The Terraform name, i.e. the block label. Kept distinct from `id` so the
   * caller can namespace ids later without touching what is committed. */
  name: string;
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
  /**
   * Drawn but not committed yet.
   *
   * A dropped module only becomes real once the commit lands, which takes a few
   * seconds over the GitHub API. Waiting for that before drawing anything made
   * the canvas look like it had ignored the drop. Such a node is a placeholder:
   * it has no ports to wire, and its final name is the server's to decide.
   */
  pending?: boolean;
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
  onRemoveNode?: (node: { name: string }) => void;
  onNodeClick?: (node: ProjectCanvasNode) => void;
  /** Highlights the node the inspector is showing, selection being external. */
  selectedNodeId?: string | null;
  /** Fires on drag end only, so callers can persist without debouncing. */
  onPositionsChange?: (
    positions: Record<string, { x: number; y: number }>,
  ) => void;
  /**
   * A module dragged in from the library, with the drop point in graph space.
   * `name` is the library's display name, for labelling the placeholder while
   * the commit runs; the committed label is the server's decision.
   */
  onDropModule?: (
    moduleId: string,
    position: { x: number; y: number },
    name?: string,
  ) => void;
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

/**
 * A wire drawn between two nodes rather than between two ports: the reader
 * said "these two are related" and still has to say which values carry it.
 */
interface PendingConnection {
  source: string;
  target: string;
  sourceOutput: string | null;
  targetInput: string | null;
}

type ProjectModuleFlowNode = Node<ProjectFlowNodeData, "projectModule">;
type ProjectFlowNode = ProjectModuleFlowNode;

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
  const [pending, setPending] = useState<PendingConnection | null>(null);
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
  const nodesById = useMemo(
    () => new Map(nodes.map((node) => [node.id, node])),
    [nodes],
  );
  const autoLayout = useMemo(
    () => layoutProjectGraph(nodes, edges, expanded, wiring),
    [nodes, edges, expanded, wiring],
  );

  const flowNodes = useMemo<ProjectFlowNode[]>(
    () =>
      nodes.map((node): ProjectFlowNode => {
        const placed = dragged[node.id] ??
          node.position ??
          autoLayout[node.id] ?? { x: 0, y: 0 };

        const isExpanded = expanded.has(node.id);
        const connected = wiring.get(node.id) ?? emptyWiring;
        // Collapsed shows only what the reader has to act on: what is already
        // wired, and what Terraform will refuse to plan without. Everything
        // else is a variable with a value, and the inspector lists those.
        const visibleInputs = visiblePorts(node.inputs, isExpanded, (port) =>
          Boolean(
            connected.inputs.has(port.name) ||
              (port.required && !node.setArguments?.includes(port.name)),
          ),
        );
        const visibleOutputs = visiblePorts(node.outputs, isExpanded, (port) =>
          connected.outputs.has(port.name),
        );

        return {
          id: node.id,
          type: "projectModule" as const,
          position: placed,
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
          // A placeholder cannot be deleted or moved: there is no block to
          // remove yet, and its position is replaced by the committed graph.
          deletable: Boolean(onRemoveNode) && !node.pending,
          draggable: !node.pending,
          selectable: !node.pending,
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
          data: {
            target: target.name,
            targetInput: link.targetInput,
          },
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
      if (!connection.source || !connection.target) return;
      if (connection.source === connection.target) return;

      const sourceNode = nodesById.get(connection.source);
      const targetNode = nodesById.get(connection.target);
      if (!targetNode) return;

      const targetInput = portName(connection.targetHandle, "in:");

      if (!onConnect) return;

      const sourceOutput = portName(connection.sourceHandle, "out:");

      if (sourceOutput && targetInput) {
        onConnect({
          source: sourceNode?.name ?? connection.source,
          sourceOutput,
          target: targetNode.name,
          targetInput,
        });
        return;
      }

      // A wire dropped on a node rather than a port. Hiding the ports is what
      // keeps the canvas readable, so the missing end is asked for here instead
      // of the gesture being thrown away.
      setPending({
        source: connection.source,
        target: connection.target,
        sourceOutput,
        targetInput,
      });
    },
    [onConnect, nodesById],
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
      for (const node of deleted) {
        onRemoveNode({ name: node.data.node.name });
      }
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

      const payload = readModuleDragPayload(
        event.dataTransfer.getData(PROJECT_MODULE_DRAG_TYPE),
      );
      if (!payload) return;

      event.preventDefault();
      onDropModule(
        payload.moduleId,
        screenToFlowPosition({ x: event.clientX, y: event.clientY }),
        payload.name,
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
        {nodes.length === 0 ? (
          <Panel position="top-center">
            <div className="mt-16 max-w-sm rounded-lg border border-dashed bg-card px-6 py-5 text-center">
              <p className="text-sm font-medium">Nothing here yet</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Drag a module from the library onto the canvas, or ask the agent
                to build something.
              </p>
            </div>
          </Panel>
        ) : null}
        {pending ? (
          <Panel position="top-center">
            <ConnectionPicker
              pending={pending}
              source={nodesById.get(pending.source)}
              target={nodesById.get(pending.target)}
              wiring={wiring}
              onCancel={() => setPending(null)}
              onPick={(sourceOutput, targetInput) => {
                setPending(null);

                const source = nodesById.get(pending.source);
                const target = nodesById.get(pending.target);
                if (!target) return;

                onConnect?.({
                  source: source?.name ?? pending.source,
                  sourceOutput,
                  target: target.name,
                  targetInput,
                });
              }}
            />
          </Panel>
        ) : null}
      </ReactFlow>
    </div>
  );
}

function ProjectModuleNode({
  data,
  selected,
}: NodeProps<ProjectModuleFlowNode>) {
  const { node, visibleInputs, visibleOutputs, hiddenCount, expanded } = data;

  // A placeholder for a module whose commit is still in flight. No ports and no
  // handles: its ports are only known once the server has resolved the module,
  // and a wire drawn to a block that does not exist yet could not be committed.
  if (node.pending) {
    return (
      <div className="w-[280px] animate-pulse rounded-lg border border-dashed bg-card/60 text-card-foreground shadow-sm">
        <div className="space-y-1 px-3 py-2">
          <span className="truncate text-sm font-semibold text-muted-foreground">
            {node.label}
          </span>
          <p className="text-xs text-muted-foreground">
            Adding to the repository…
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "w-[280px] rounded-lg border bg-card text-card-foreground shadow-sm transition-shadow",
        selected ? "border-primary shadow-md" : "border-border",
        node.linked === false ? "border-dashed" : "",
      )}
    >
      {/* Node-level handles catch wires whose exact port is unknown, and are
          the way to wire two modules without unfolding either of them: the
          picker asks for the ports once the wire lands. */}
      <Handle
        type="target"
        id={`in:${ANY_PORT}`}
        position={Position.Left}
        className="!h-3 !w-3 !border-2 !border-background !bg-muted-foreground hover:!bg-primary"
        style={{ top: 24 }}
        title="Drop a wire here to connect this module"
      />
      <Handle
        type="source"
        id={`out:${ANY_PORT}`}
        position={Position.Right}
        className="!h-3 !w-3 !border-2 !border-background !bg-muted-foreground hover:!bg-primary"
        style={{ top: 24 }}
        title="Drag from here to connect this module"
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
        {visibleInputs.length + visibleOutputs.length === 0 ? (
          <p className="px-3 py-1 text-[0.7rem] text-muted-foreground">
            Nothing to fill in — drag from the dots to connect.
          </p>
        ) : null}
        {hiddenCount > 0 || expanded ? (
          <button
            type="button"
            onClick={data.onToggle}
            className="nodrag mt-1 w-full px-3 py-1 text-left text-[0.7rem] font-medium text-muted-foreground hover:text-foreground"
          >
            {expanded ? "Show less" : `Show all variables (+${hiddenCount})`}
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
  const missing = isInput && Boolean(port.required) && !wired && !set;

  return (
    <div
      className={cn(
        "relative flex h-6 items-center gap-1 px-3 text-xs",
        isInput ? "justify-start" : "justify-end",
        missing ? "text-destructive" : "",
      )}
      title={port.description ?? undefined}
    >
      <Handle
        type={side}
        id={`${isInput ? "in" : "out"}:${port.name}`}
        position={isInput ? Position.Left : Position.Right}
        className={cn(
          "!h-2.5 !w-2.5 !border-2 !border-background",
          wired
            ? "!bg-primary"
            : missing
              ? "!bg-destructive"
              : "!bg-muted-foreground",
        )}
      />
      <span className="truncate">{port.name}</span>
      {missing ? (
        <span className="shrink-0 font-medium text-[0.6rem] uppercase tracking-wide">
          required
        </span>
      ) : null}
    </div>
  );
}

const nodeTypes = {
  projectModule: ProjectModuleNode,
};

/**
 * Asks for the two ends of a wire that was drawn between whole modules.
 *
 * Picking here beats unfolding both nodes first: the reader states the intent
 * with one drag, and the ports — of which a module can have dozens — are
 * offered as a searchable list with the plausible ones on top.
 */
function ConnectionPicker({
  pending,
  source,
  target,
  wiring,
  onCancel,
  onPick,
}: {
  pending: PendingConnection;
  source?: ProjectCanvasNode;
  target?: ProjectCanvasNode;
  wiring: Wiring;
  onCancel: () => void;
  onPick: (sourceOutput: string, targetInput: string) => void;
}) {
  // A module with a single output has nothing to ask about, so it skips straight
  // to "which input receives this".
  const [output, setOutput] = useState<string | null>(
    () =>
      pending.sourceOutput ??
      (source?.outputs.length === 1 ? (source.outputs[0]?.name ?? null) : null),
  );
  const [filter, setFilter] = useState("");

  const pickingOutput = output === null;
  const chosenOutput = source?.outputs.find((port) => port.name === output);

  const options = useMemo(() => {
    const ports = pickingOutput
      ? (source?.outputs ?? [])
      : (target?.inputs ?? []);
    const needle = filter.trim().toLowerCase();
    const matched = needle
      ? ports.filter((port) => port.name.toLowerCase().includes(needle))
      : [...ports];

    if (pickingOutput) return matched;

    return matched
      .map((port) => ({ port, score: matchScore(port, chosenOutput) }))
      .sort((a, b) => b.score - a.score)
      .map((entry) => ({ ...entry.port, suggested: entry.score >= 2 }));
  }, [pickingOutput, source, target, filter, chosenOutput]);

  const choose = (name: string) => {
    if (pickingOutput) {
      if (pending.targetInput) onPick(name, pending.targetInput);
      else {
        setOutput(name);
        setFilter("");
      }
      return;
    }
    if (output) onPick(output, name);
  };

  const targetWiring = target ? wiring.get(target.id) : undefined;

  const filterRef = useRef<HTMLInputElement>(null);
  // Focus follows the step, so the second list is filterable without reaching
  // for the mouse again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the step change is the reason to refocus
  useEffect(() => filterRef.current?.focus(), [pickingOutput]);

  return (
    <div
      aria-label="Choose the ports to connect"
      className="nodrag nowheel mt-4 w-80 rounded-lg border bg-card text-card-foreground shadow-lg"
      onKeyDown={(event) => {
        if (event.key === "Escape") onCancel();
      }}
      role="dialog"
    >
      <div className="flex items-start justify-between gap-2 border-b px-3 py-2">
        <div className="min-w-0">
          <p className="truncate font-medium text-sm">
            {source?.label ?? pending.source} →{" "}
            {target?.label ?? pending.target}
          </p>
          <p className="truncate text-muted-foreground text-xs">
            {pickingOutput
              ? "Which output carries the value?"
              : `Which input receives ${output}?`}
          </p>
        </div>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Cancel connection"
          className="shrink-0 rounded px-1 text-muted-foreground text-sm hover:text-foreground"
        >
          ✕
        </button>
      </div>

      {options.length === 0 && filter.length === 0 ? (
        <p className="px-3 py-4 text-muted-foreground text-xs">
          {pickingOutput
            ? "This module exposes no outputs to wire from."
            : "This module declares no variables to wire into."}
        </p>
      ) : (
        <div className="p-2">
          <input
            ref={filterRef}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter"
            className="mb-2 h-8 w-full rounded-md border bg-background px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <ul className="max-h-56 space-y-0.5 overflow-y-auto">
            {options.map((port) => {
              const wired =
                !pickingOutput && targetWiring?.inputs.has(port.name);
              const set =
                !pickingOutput && target?.setArguments?.includes(port.name);

              return (
                <li key={port.name}>
                  <button
                    type="button"
                    onClick={() => choose(port.name)}
                    title={port.description ?? undefined}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-secondary"
                  >
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">
                      {port.name}
                    </span>
                    {"suggested" in port && port.suggested ? (
                      <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 font-medium text-[0.6rem] text-primary">
                        match
                      </span>
                    ) : null}
                    {port.required && !wired && !set ? (
                      <span className="shrink-0 font-medium text-[0.6rem] text-destructive uppercase">
                        required
                      </span>
                    ) : null}
                    {wired || set ? (
                      <span className="shrink-0 text-[0.6rem] text-muted-foreground">
                        {wired ? "wired" : "set"}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
            {options.length === 0 ? (
              <li className="px-2 py-3 text-muted-foreground text-xs">
                Nothing matches “{filter}”.
              </li>
            ) : null}
          </ul>
        </div>
      )}
    </div>
  );
}

/** How well an input fits the chosen output: same type, then same name. */
function matchScore(
  input: ProjectCanvasPort,
  output: ProjectCanvasPort | undefined,
): number {
  if (!output) return 0;

  let score = 0;
  const inputType = input.type?.replace(/\s+/g, "").toLowerCase();
  const outputType = output.type?.replace(/\s+/g, "").toLowerCase();
  if (inputType && outputType && inputType === outputType) score += 2;

  if (input.name === output.name) score += 3;
  else if (
    input.name.includes(output.name) ||
    output.name.includes(input.name)
  ) {
    score += 1;
  }

  if (input.required) score += 0.5;
  return score;
}

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
          connected.inputs.has(port.name) ||
          (port.required && !node.setArguments?.includes(port.name)),
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
