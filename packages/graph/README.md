# @terrablox/graph

The graph **rendering** layer: React Flow canvases, plus dagre auto-layout for the
dependency graph.

## What is deliberately not here

Building a graph out of Terraform is domain work, not rendering, so it lives with
the Terraform code in the dashboard:

| File | Concern |
| --- | --- |
| `@terrablox/terraform/architecture-graph` | Turns parsed Terraform into nodes and edges |
| `@terrablox/terraform/architecture-layout` | Positions that graph |
| `apps/dashboard/src/lib/graph-layout.ts` | Validates and prunes layouts saved by the user |

Three modules in this repo have "layout" in the name and they do three different
things: `src/layout.ts` here is a dagre run over an abstract node set,
`architecture-layout.ts` positions a Terraform-shaped graph, and `graph-layout.ts`
is persistence for hand-adjusted positions. They are not variants of each other.

## Styles

React Flow ships its own stylesheet and renders unstyled without it, so a
consuming app must import it alongside its own:

```ts
import "@terrablox/graph/styles.css";
```
