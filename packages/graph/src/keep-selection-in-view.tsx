"use client";

import { type FitViewOptions, useReactFlow, useStore } from "@xyflow/react";
import { useEffect, useRef } from "react";

/** Gap left between a node pulled into view and the edge of the canvas. */
const MARGIN = 24;

/**
 * Keeps the diagram readable when the canvas changes size.
 *
 * Opening a detail panel takes width away from the canvas, and a diagram that
 * is wider than it is tall has no horizontal slack to give: boxes on the right
 * — including, in the worst case, the very box that was clicked — end up
 * outside the visible area, so the panel describes something the reader cannot
 * see.
 *
 * What to do about it depends on whose viewport it is:
 *
 * - Untouched, still showing the fit it was given: refit. The reader was
 *   looking at the whole diagram, and they should go on looking at the whole
 *   diagram, just in less width.
 * - Zoomed or panned by the reader: leave the scale alone and pan the minimum
 *   needed to bring the selected node back. Rescaling here would throw away the
 *   view they deliberately chose, which is a far bigger change than the problem.
 */
export function KeepSelectionInView({
  nodeId,
  fitViewOptions,
  /**
   * True once the reader has zoomed or panned. The caller tracks it because
   * React Flow reports viewport moves on the flow element, not from inside it.
   */
  viewportMoved,
}: {
  nodeId: string | null;
  fitViewOptions?: FitViewOptions;
  viewportMoved: boolean;
}) {
  const flow = useReactFlow();
  // Read from the store so a resize of the canvas re-runs this, which is what
  // opening and closing the panel amounts to.
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);

  const latest = useRef({ nodeId, fitViewOptions, viewportMoved });
  latest.current = { nodeId, fitViewOptions, viewportMoved };

  const previousSize = useRef({ width, height });

  useEffect(() => {
    if (width === 0 || height === 0) return;

    const resized =
      previousSize.current.width !== width ||
      previousSize.current.height !== height;
    previousSize.current = { width, height };

    const current = latest.current;
    // Nothing to do for a selection made while the canvas stayed put: the node
    // was already where the reader clicked it.
    if (!resized) return;

    // A frame late, so the resize has been laid out before anything is measured.
    const handle = requestAnimationFrame(() => {
      if (!current.viewportMoved) {
        void flow.fitView(current.fitViewOptions);
        return;
      }
      if (!current.nodeId) return;

      const node = flow.getInternalNode(current.nodeId);
      if (!node) return;

      const { x, y, zoom } = flow.getViewport();
      // Absolute, because a node inside a frame is positioned relative to it.
      const { x: nodeX, y: nodeY } = node.internals.positionAbsolute;

      /** How far to pan on one axis, in screen pixels. */
      const shift = (from: number, to: number, viewport: number): number => {
        // A node larger than the viewport cannot be framed by both edges at
        // once. Aligning its start avoids a correction that fights itself.
        if (to - from > viewport - 2 * MARGIN) return MARGIN - from;
        if (to > viewport - MARGIN) return viewport - MARGIN - to;
        if (from < MARGIN) return MARGIN - from;
        return 0;
      };

      // Flow coordinates to screen coordinates.
      const left = nodeX * zoom + x;
      const top = nodeY * zoom + y;

      const dx = shift(left, left + (node.measured.width ?? 0) * zoom, width);
      const dy = shift(top, top + (node.measured.height ?? 0) * zoom, height);
      if (dx === 0 && dy === 0) return;

      void flow.setViewport({ x: x + dx, y: y + dy, zoom }, { duration: 200 });
    });

    return () => cancelAnimationFrame(handle);
  }, [width, height, flow]);

  return null;
}
