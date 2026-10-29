import {
  App,
  applyDocumentTheme,
  type McpUiDisplayMode,
} from "@modelcontextprotocol/ext-apps";
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ProjectCanvas } from "../project-canvas";
import {
  GRAPH_VIEW_TOOL,
  type GraphViewPayload,
  isGraphViewPayload,
} from "./contract";

/**
 * The project graph, as it runs inside the host's sandboxed iframe.
 *
 * The same `ProjectCanvas` the web app renders, with no callbacks: it can be panned,
 * zoomed and its modules expanded, and it cannot change a line of Terraform. Editing stays
 * with the agent, through the tools it already has, and with the web app. A second place
 * to wire modules, inside a chat, would be a second opinion about what a valid edit is.
 *
 * Data arrives as the tool result and is refreshed by calling an app-only tool, so the
 * host's connection is the only one there is: this document has no network of its own, and
 * its Content Security Policy allows none.
 */

const INLINE_HEIGHT = 520;

function setTheme(theme: "light" | "dark"): void {
  applyDocumentTheme(theme);
  // The design tokens key off a `dark` class, as in the web app; the SDK sets a data
  // attribute and `color-scheme`, which the tokens do not read.
  document.documentElement.classList.toggle("dark", theme === "dark");
}

const app = new App({ name: "terrablox-project-graph", version: "0.1.0" });

function GraphApp() {
  const [view, setView] = useState<GraphViewPayload | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [displayMode, setDisplayMode] = useState<McpUiDisplayMode>("inline");
  const [canFullscreen, setCanFullscreen] = useState(false);

  useEffect(() => {
    const syncHost = () => {
      const context = app.getHostContext();
      if (context?.theme) setTheme(context.theme);
      setDisplayMode(context?.displayMode ?? "inline");
      setCanFullscreen(
        context?.availableDisplayModes?.includes("fullscreen") ?? false,
      );
    };

    // Registered before `connect`, because the host may push the result the moment the
    // connection opens and a handler attached afterwards would miss the only message
    // that matters.
    const onResult = (params: { structuredContent?: unknown }) => {
      if (isGraphViewPayload(params.structuredContent)) {
        setView(params.structuredContent);
        setMessage(null);
      }
    };

    app.addEventListener("toolresult", onResult);
    app.addEventListener("hostcontextchanged", syncHost);

    app
      .connect()
      .then(syncHost)
      .catch(() =>
        setMessage(
          "Could not reach the host. This view is rendered by the MCP host and has nothing to show on its own.",
        ),
      );

    return () => {
      app.removeEventListener("toolresult", onResult);
      app.removeEventListener("hostcontextchanged", syncHost);
    };
  }, []);

  const projectId = view?.project.id;

  const refresh = useCallback(async () => {
    if (!projectId) return;
    setRefreshing(true);
    setMessage(null);

    try {
      const result = await app.callServerTool({
        name: GRAPH_VIEW_TOOL,
        arguments: { projectId },
      });

      if (result.isError || !isGraphViewPayload(result.structuredContent)) {
        const text = result.content?.find((block) => block.type === "text");
        setMessage(
          text && "text" in text ? text.text : "The graph could not be loaded.",
        );
        return;
      }
      setView(result.structuredContent);
    } catch {
      setMessage("The graph could not be loaded.");
    } finally {
      setRefreshing(false);
    }
  }, [projectId]);

  const toggleFullscreen = useCallback(async () => {
    const next: McpUiDisplayMode =
      displayMode === "fullscreen" ? "inline" : "fullscreen";
    try {
      const result = await app.requestDisplayMode({ mode: next });
      setDisplayMode(result.mode);
    } catch {
      // The host said no, and the view is exactly as it was.
    }
  }, [displayMode]);

  const fullscreen = displayMode === "fullscreen";

  return (
    <div
      className="flex flex-col bg-background text-foreground"
      style={{ height: fullscreen ? "100vh" : INLINE_HEIGHT }}
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-2 text-sm">
        {view ? (
          <>
            <strong className="font-medium">{view.project.name}</strong>
            <span className="text-muted-foreground text-xs">
              {view.project.repo}@{view.project.branch}
            </span>
            <span className="text-muted-foreground text-xs">
              {view.nodes.length} module{view.nodes.length === 1 ? "" : "s"},{" "}
              {view.edges.reduce((sum, edge) => sum + edge.links.length, 0)}{" "}
              wire
              {view.edges.reduce((sum, edge) => sum + edge.links.length, 0) ===
              1
                ? ""
                : "s"}
            </span>
            {view.gaps > 0 ? (
              <span className="rounded-full border border-amber-500/50 px-2 py-0.5 text-amber-700 text-xs dark:text-amber-400">
                {view.gaps} required input{view.gaps === 1 ? "" : "s"} unset
              </span>
            ) : null}
          </>
        ) : (
          <span className="text-muted-foreground text-xs">
            Waiting for the project graph…
          </span>
        )}

        <span className="ml-auto flex items-center gap-1.5">
          <button
            className="rounded-md border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
            disabled={!view || refreshing}
            onClick={() => void refresh()}
            type="button"
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
          {canFullscreen ? (
            <button
              className="rounded-md border px-2 py-1 text-xs hover:bg-accent"
              onClick={() => void toggleFullscreen()}
              type="button"
            >
              {fullscreen ? "Exit full screen" : "Full screen"}
            </button>
          ) : null}
        </span>
      </header>

      {message ? (
        <p className="border-b px-3 py-2 text-destructive text-xs" role="alert">
          {message}
        </p>
      ) : null}

      {view?.errors.length ? (
        <p className="border-b px-3 py-2 text-muted-foreground text-xs">
          Could not read: {view.errors.join("; ")}
        </p>
      ) : null}

      <div className="min-h-0 flex-1 p-2">
        {view ? <ProjectCanvas edges={view.edges} nodes={view.nodes} /> : null}
      </div>
    </div>
  );
}

const rootElement = document.getElementById("root");
if (rootElement) {
  // Before the host says anything, follow the browser's own preference.
  setTheme(
    window.matchMedia?.("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light",
  );
  createRoot(rootElement).render(<GraphApp />);
}
