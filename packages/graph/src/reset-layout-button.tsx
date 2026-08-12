"use client";

import { type FitViewOptions, useReactFlow } from "@xyflow/react";

/**
 * Returns a graph to its computed arrangement.
 *
 * Shared by both diagrams so that the one control a reader has to undo their
 * own rearranging looks and behaves the same wherever they meet it.
 */
export function ResetLayoutButton({
  onReset,
  refit,
  fitViewOptions,
}: {
  onReset: () => void;
  refit: boolean;
  fitViewOptions: FitViewOptions;
}) {
  const { fitView } = useReactFlow();

  return (
    <button
      className="rounded-md border bg-card px-2.5 py-1.5 font-medium text-card-foreground text-xs shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
      onClick={() => {
        onReset();
        if (!refit) return;

        // A frame later the restored positions are committed, so the viewport
        // fits the layout instead of the bounds the dragged nodes had.
        requestAnimationFrame(() => {
          void fitView(fitViewOptions);
        });
      }}
      type="button"
    >
      Reset layout
    </button>
  );
}
