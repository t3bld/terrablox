/**
 * The window drawn around a screenshot, in one place.
 *
 * Two components draw this frame: `ProductFigure` for a single screenshot and
 * `ProjectViewFigure` for a set a reader can switch between. They cannot share one
 * wrapper component without it growing a prop for every difference — the switcher
 * needs radio inputs inside the frame and a route that changes with the selection —
 * so what they share is the look, not the structure.
 *
 * Kept as class strings rather than a component because that is the part that would
 * drift: a rounding or border tweak applied to one frame and not the other gives a
 * page two subtly different windows, which reads as a mistake rather than a style.
 */
export const FIGURE_CHROME = {
  figure:
    "overflow-hidden rounded-xl border bg-card shadow-sm transition-shadow duration-300 hover:shadow-lg",
  titleBar: "flex items-center gap-2 border-b bg-muted/40 px-3 py-2",
  route: "truncate font-mono text-muted-foreground text-xs",
  caption: "border-t px-4 py-3 text-muted-foreground text-sm leading-relaxed",
} as const;

/**
 * The three dots that make the frame read as a window.
 *
 * `aria-hidden`, because they are the drawing of a title bar and not a control: a
 * screen reader announcing three blank bullets before every screenshot is noise.
 */
export function FigureDots() {
  return (
    <span aria-hidden className="flex gap-1.5">
      <span className="h-2.5 w-2.5 rounded-full bg-border" />
      <span className="h-2.5 w-2.5 rounded-full bg-border" />
      <span className="h-2.5 w-2.5 rounded-full bg-border" />
    </span>
  );
}
