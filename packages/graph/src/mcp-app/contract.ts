import type { ProjectCanvasEdge, ProjectCanvasNode } from "../project-canvas";

/**
 * What the MCP server and the graph view agree on.
 *
 * Its own file, with nothing but types and constants in it: the server imports this to
 * build a payload, and the view imports it to read one. Either side pulling in the other's
 * dependencies (React in a route handler, a Prisma client in an iframe) would be the first
 * step to the view no longer building on its own.
 */

/** The `ui://` resource the graph tools point at. */
export const GRAPH_APP_URI = "ui://terrablox/project-graph.html";

/**
 * The tool the view calls to load or refresh itself, hidden from the model.
 *
 * Separate from `show_graph` on purpose. `show_graph` is what a model calls to put the
 * graph in front of a person; this is a data endpoint, and a model that could call it
 * would fetch a payload it has no use for and the host could not display.
 */
export const GRAPH_VIEW_TOOL = "get_graph_view";

/** What the view renders: one project's graph, as the canvas draws it. */
export interface GraphViewPayload {
  project: {
    id: string;
    name: string;
    repo: string;
    branch: string;
  };
  /** Commit the graph was read from. */
  sha: string;
  nodes: ProjectCanvasNode[];
  edges: ProjectCanvasEdge[];
  /** Required inputs still without a value. */
  gaps: number;
  /** Files Terraform could not be read from, as `file: message`. */
  errors: string[];
}

/**
 * Whether something the host handed over is a graph view.
 *
 * Checked rather than cast: the payload crosses a process boundary and a host that
 * relays the wrong tool's result would otherwise surface as a crash inside React.
 */
export function isGraphViewPayload(value: unknown): value is GraphViewPayload {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const project = candidate.project as Record<string, unknown> | undefined;

  return (
    typeof project === "object" &&
    project !== null &&
    typeof project.id === "string" &&
    typeof project.name === "string" &&
    Array.isArray(candidate.nodes) &&
    Array.isArray(candidate.edges)
  );
}
