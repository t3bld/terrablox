import type {
  ProjectCanvasEdge,
  ProjectCanvasNode,
  ProjectCanvasPort,
} from "./project-canvas";

/**
 * From a project graph to what the canvas draws.
 *
 * One function for both deliveries of the same picture: the web app's project page and
 * the MCP App that shows the graph inside an editor. Each used to be able to grow its own
 * idea of which nodes are drawn and which wires count, and the two views of one project
 * would then disagree about what the project is.
 *
 * Structural types rather than the dashboard's `ProjectGraph`: this package cannot import
 * from an app, and a graph from anywhere that has these fields draws the same.
 */

/** The fields of a graph node the canvas needs. */
export interface CanvasSourceNode {
  id: string;
  label: string;
  /** `module` is drawn; anything else (a local) lives on the input that reads it. */
  kind: string;
  source: string | null;
  version: string | null;
  /** Null when the block's source matches no imported module. */
  moduleId: string | null;
  moduleName: string | null;
  inputs: readonly ProjectCanvasPort[];
  outputs: readonly ProjectCanvasPort[];
  setArguments: readonly string[];
  position: { x: number; y: number } | null;
}

/** The fields of a graph edge the canvas needs. */
export interface CanvasSourceEdge {
  id: string;
  source: string;
  target: string;
  sourceKind: string;
  targetKind: string;
  links: ReadonlyArray<{ targetInput: string; sourceOutput: string | null }>;
}

export interface CanvasModelOptions {
  /**
   * Keep port descriptions. On by default; off for a payload that travels, since a
   * module can declare hundreds of ports and the canvas shows the text only as a tooltip.
   */
  descriptions?: boolean;
}

export interface CanvasModel {
  nodes: ProjectCanvasNode[];
  edges: ProjectCanvasEdge[];
}

function ports(
  source: readonly ProjectCanvasPort[],
  descriptions: boolean,
): ProjectCanvasPort[] {
  return descriptions
    ? [...source]
    : source.map(({ name, required, type }) => ({
        name,
        ...(required !== undefined ? { required } : {}),
        ...(type !== undefined ? { type } : {}),
      }));
}

/**
 * Modules only.
 *
 * Values are deliberately absent: they are drawn nowhere and reached from the input that
 * reads them. A value as a node cost a box and two handles to say something the input row
 * says better, and it made a six-module project read as a twenty-node system. The graph
 * still knows about them; every input picker is built from the same nodes.
 *
 * Edges follow: module to module only, since an edge with a value at either end would
 * point at a node that is not on the canvas.
 */
export function toCanvasModel(
  graph: {
    nodes: readonly CanvasSourceNode[];
    edges: readonly CanvasSourceEdge[];
  },
  options: CanvasModelOptions = {},
): CanvasModel {
  const descriptions = options.descriptions ?? true;

  return {
    nodes: graph.nodes
      .filter((node) => node.kind === "module")
      .map((node) => ({
        id: node.id,
        name: node.id,
        label: node.label,
        moduleName: node.moduleName,
        version: node.version,
        source: node.source,
        linked: node.moduleId !== null,
        inputs: ports(node.inputs, descriptions),
        outputs: ports(node.outputs, descriptions),
        setArguments: [...node.setArguments],
        position: node.position,
      })),
    edges: graph.edges
      .filter(
        (edge) => edge.sourceKind === "module" && edge.targetKind === "module",
      )
      .map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        links: edge.links.map(({ targetInput, sourceOutput }) => ({
          targetInput,
          sourceOutput,
        })),
      })),
  };
}
