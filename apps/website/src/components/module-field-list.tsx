import { Badge } from "@terrablox/ui/badge";
import { ChevronDown } from "lucide-react";

/**
 * A titled list that folds away, for the module pages.
 *
 * Deliberately a lookalike of the dashboard's `FieldList`
 * (`apps/dashboard/src/components/module-detail/field-primitives.tsx`) rather than the
 * same component, and the difference is the mechanism, not the styling. The dashboard's
 * is a `<button aria-expanded>` driven by React state, because there the open/closed
 * state has to answer to a search box — a section holding matches is forced open, and a
 * closed one advertises how many it hides. Nothing on this site searches these lists, so
 * the state has nothing to coordinate with, and `<details>` gives the same disclosure
 * with no client component, no hydration and correct keyboard and screen-reader
 * behaviour from the platform. It is also what the docs sidebar on this site already
 * uses, so the page has one way of folding things, not two.
 *
 * Kept visually identical on purpose: the two products are read as one, and a reader who
 * has seen the dashboard's module detail should not have to work out whether this is the
 * same kind of list. If the dashboard's header styling moves, this is the file that has
 * to follow it.
 */
export function ModuleFieldList({
  title,
  total,
  shown,
  defaultOpen = true,
  children,
}: {
  title: string;
  /** Everything the module declares, including whatever the snapshot left out. */
  total: number;
  /**
   * How many are actually rendered. Where this is below `total` the badge reads
   * `40 / 236`, which is the same notation the dashboard uses for a filtered list —
   * there because a filter hid rows, here because the committed snapshot caps them.
   * Both mean "you are not looking at all of them", so they are shown the same way.
   */
  shown: number;
  /**
   * Open unless told otherwise. A closed-by-default list makes a reader click before
   * they can see whether the page holds anything worth reading.
   */
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const truncated = shown !== total;

  return (
    // `group` is what lets the chevron respond to the parent's `open` attribute; in
    // Tailwind 3 the `open:` variant compiles to `[open]`, which is an attribute
    // `<details>` really carries, rather than the `:open` pseudo-class whose support is
    // newer than the browsers this site targets.
    <details className="group rounded-lg border bg-card" open={defaultOpen}>
      {/* `list-none` plus the WebKit pseudo-element removes the native disclosure
          triangle. Both are needed: Safari draws the marker through the pseudo-element
          and ignores `list-style` on a summary. The chevron replaces it so the affordance
          matches the dashboard's, and it is the only marker either place shows. */}
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-t-lg border-b bg-muted/30 px-4 py-2.5 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset group-[:not([open])]:rounded-b-lg [&::-webkit-details-marker]:hidden">
        <ChevronDown className="-rotate-90 h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-0" />

        {/* `h2` rather than a styled span: these are the sections of the page, and the
            summary is the only text naming them. A reader jumping by heading would
            otherwise find the tab panel unlabelled. */}
        <h2 className="font-semibold text-sm">{title}</h2>

        <Badge variant="secondary">
          {truncated ? `${shown} / ${total}` : total}
        </Badge>
      </summary>

      {children}
    </details>
  );
}

/** The message a folded list shows in place of rows it does not have. */
export function ModuleFieldEmpty({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-4 py-8 text-center text-muted-foreground text-sm">
      {children}
    </p>
  );
}

/**
 * A note under the rows, for what the rows do not say.
 *
 * Inside the list rather than after it, because it is about this list: a reader who
 * folds the section away has no reason to keep reading a caveat about its contents.
 */
export function ModuleFieldNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="border-t bg-muted/20 px-4 py-3 text-muted-foreground text-xs leading-relaxed">
      {children}
    </p>
  );
}
