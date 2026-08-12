"use client";

/**
 * Explains the two highlight colours while a node is selected.
 *
 * Shared by both graphs: the colours mean the same thing in each, so they are
 * spelled out in the same words and the same order.
 *
 * Renders nothing when the selected node has no visible edges. There would be
 * no colour left to explain, and both graphs put a detail panel beside the
 * canvas that already says so in full sentences — a second box repeating it is
 * noise sitting on top of the drawing.
 *
 * Deliberately carries no counts. The Connections view already lists the
 * neighbours beside the canvas, and the two would not agree: that list counts
 * distinct neighbours across the whole graph, while the canvas shows edges and
 * only the ones a filter has left visible.
 */
export function ConnectionLegend({
  label,
  hasOutgoing,
  hasIncoming,
  onClear,
}: {
  label: string;
  /** Only directions that occur are explained, so no swatch is ever a lie. */
  hasOutgoing: boolean;
  hasIncoming: boolean;
  /** Absent when the caller offers no way to clear; the ✕ is then omitted. */
  onClear?: () => void;
}) {
  if (!hasOutgoing && !hasIncoming) return null;

  return (
    <div className="max-w-[18rem] rounded-md border bg-card/95 px-3 py-2 shadow-sm backdrop-blur">
      <div className="flex items-center gap-2">
        <span
          className="truncate font-medium text-card-foreground text-xs"
          title={label}
        >
          {label}
        </span>
        {onClear ? (
          <button
            aria-label="Clear highlight"
            className="ml-auto shrink-0 rounded px-1 text-muted-foreground text-xs leading-none hover:bg-muted hover:text-foreground"
            onClick={onClear}
            type="button"
          >
            ✕
          </button>
        ) : null}
      </div>

      <dl className="mt-1.5 space-y-1">
        {hasOutgoing ? (
          <div className="flex items-center gap-2">
            {/* Dashed, matching the animated stroke on the canvas. */}
            <svg aria-hidden="true" className="shrink-0" height="8" width="26">
              <line
                stroke="hsl(var(--tbx-edge-out))"
                strokeDasharray="5 3"
                strokeWidth="2.5"
                x1="0"
                x2="26"
                y1="4"
                y2="4"
              />
            </svg>
            <dt className="text-[11px] text-muted-foreground">feeds</dt>
          </div>
        ) : null}

        {hasIncoming ? (
          <div className="flex items-center gap-2">
            <svg aria-hidden="true" className="shrink-0" height="8" width="26">
              <line
                stroke="hsl(var(--tbx-edge-in))"
                strokeWidth="2.5"
                x1="0"
                x2="26"
                y1="4"
                y2="4"
              />
            </svg>
            <dt className="text-[11px] text-muted-foreground">fed by</dt>
          </div>
        ) : null}
      </dl>
    </div>
  );
}
