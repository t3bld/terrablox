/**
 * The project graph as an MCP App: the contract both sides share, and the document the
 * host renders.
 *
 * No React, no DOM and nothing from the canvas at runtime. The document is a string
 * built ahead of time (`pnpm --filter @terrablox/graph build:app`), so a server importing
 * this gets HTML to hand to a host and not a component tree to render.
 */
export { GRAPH_APP_HTML } from "./app.generated";
export * from "./contract";
