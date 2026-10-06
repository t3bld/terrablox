"use client";

import { ArchitectureDiagram } from "@terrablox/graph";

import type { CatalogueArchitecture } from "@/lib/catalogue";
import { toDiagramNodes } from "@/lib/catalogue";

/**
 * A module's architecture, drawn by the product's own diagram component.
 *
 * The one client component on these pages, and unavoidable: the diagram is React
 * Flow, which needs a browser to measure and pan. Everything it draws is decided at
 * build time — the projection, the layout, the icon names — so what ships is a
 * renderer over data that is already final rather than a page that computes itself.
 *
 * Read-only on purpose. The dashboard's version saves node positions, expands nested
 * modules and links boxes to their submodule pages; none of that has a home here,
 * and the handlers are left off rather than stubbed so the component cannot offer an
 * affordance that does nothing.
 *
 * `iconBasePath` is passed rather than defaulted, because the default is absolute and
 * a project page is served from a sub-path.
 */
export function ModuleArchitecture({
  architecture,
  iconBasePath,
}: {
  architecture: CatalogueArchitecture;
  iconBasePath: string;
}) {
  return (
    <div className="h-[28rem] overflow-hidden rounded-lg border bg-muted/20">
      <ArchitectureDiagram
        edges={architecture.edges}
        fill
        iconBasePath={iconBasePath}
        nodes={toDiagramNodes(architecture)}
      />
    </div>
  );
}
