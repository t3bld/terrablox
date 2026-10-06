import {
  ArrowRight,
  BookOpen,
  Cog,
  FileCode2,
  Gavel,
  GitBranch,
  GitCommitHorizontal,
  Library,
  type LucideIcon,
  MessageSquare,
  RotateCcw,
  ScrollText,
  ShieldCheck,
  Wallet,
  Wrench,
} from "lucide-react";
import { type CSSProperties, Fragment } from "react";

/**
 * One turn, drawn left to right: what goes in, what the harness does with it, what
 * comes out.
 *
 * ## Why it runs sideways
 *
 * There were two versions of this drawing on the page at once for a while, and this is
 * the one that was kept. The other stacked the three tiers vertically — sources,
 * harness, outcome, each a bordered box, the harness widest — which read well and cost
 * roughly seven hundred pixels of height, of which the harness, the only part anybody
 * needs to study, was under half. Side by side the whole thing is as tall as the
 * harness alone.
 *
 * The inside of the harness is turned too, and that is the part worth understanding
 * before changing anything. Putting the three tiers in a row would have left the
 * harness itself as tall as before, because the harness is what sets the height. So
 * requirements sits left of the loop rather than above it. That reads the same — first
 * this, then the loop — because a horizontal drawing already means "later is further
 * right".
 *
 * ## The cost, which is real
 *
 * Five columns need width. This is the one section on the page at `max-w-7xl` instead of
 * `max-w-6xl`, and below `lg` the row collapses to a stack — so the layout effectively
 * exists twice and both have to be checked after any change here. That was the argument
 * against this version and it did not win, but it did not go away either.
 *
 * ## What the drawing is allowed to say
 *
 * It replaced a version with twenty-four boxes — six inputs, two setup steps, four loop
 * steps, three namespaces, three exits, two teardown steps, four outputs — every one of
 * them true and none of them read. A diagram in a marketing section has one job, which
 * is to leave a shape in the reader's head after two seconds; the detail belongs in the
 * product, where the settings screen renders the same turn model in full.
 *
 * So the panels carry a title and nothing else, and the prose lives in the section copy
 * in `app/page.tsx`. The exceptions are the three connector labels, because "executes
 * operations", "access knowledge" and "enforces limits" are three different
 * relationships that would otherwise all look like an arrow — and the difference between
 * a rule the model is asked to follow and a limit the code enforces is the question
 * anybody evaluating this for production work is actually asking.
 *
 * Motion is CSS and additive: the loop's sequenced highlight says it repeats and the
 * connectors say which way data moves, and under `prefers-reduced-motion` what remains
 * is a complete static drawing. No JavaScript, so this stays a server component and the
 * section ships as markup.
 */

/** Length of one pass of the loop animation. Shared so the chips and legs agree. */
const LOOP_CYCLE_S = 6.4;

/** Everything a turn is allowed to read. */
const SOURCES = [
  { icon: FileCode2, label: "Application repository" },
  { icon: GitBranch, label: "Documentation" },
  { icon: MessageSquare, label: "Prompts" },
] as const;

/** The four steps that repeat, as chips. */
const LOOP = [
  { icon: MessageSquare, label: "Reads" },
  { icon: Wrench, label: "Calls operation" },
  { icon: ShieldCheck, label: "Verifies result" },
  { icon: RotateCcw, label: "Result goes back" },
] as const;

/** What the loop is given, over and above the sources. */
const ENRICHMENT = [
  "Context",
  "Tools",
  "Memory",
  "Guardrails",
  "Observability",
] as const;

/**
 * The three things the loop is bound to, and how each binding works.
 *
 * A list rather than three hand-written panels. They became identical once their bodies
 * were stripped to a title, and three copies of the same markup is three places to
 * forget. The label on each connector is the payload:
 * the library is *worked* through operations, the practices are *read*, the governance
 * rules are *enforced* — three different relationships that would otherwise all look
 * like an arrow.
 *
 * `Cost calculation` and the rest of the outcome stay hardcoded below, because those
 * rows differ in more than their label.
 */
const BOUND = [
  {
    icon: Cog,
    panelIcon: Library,
    label: "Module library",
    via: "executes operations",
  },
  {
    icon: BookOpen,
    panelIcon: BookOpen,
    label: "Best practices",
    via: "access knowledge",
  },
  {
    icon: Gavel,
    panelIcon: Gavel,
    label: "Governance rules",
    via: "enforces limits",
  },
] as const;

/**
 * What comes out.
 *
 * The second row closes a loop the drawing opens: recording the decision before
 * building is one of the operating rules the harness gives the agent, and without this
 * row a reader would see the rule go in and never see what it was for.
 *
 * Named "Architecture decisions" rather than the product's own word, which is
 * Decisions. Inside the product that word has a tab and a shape around it; on a landing
 * page it is a common noun that would read as "notes", and the qualifier is what stops
 * it. The schema comment for `project_decisions` calls them *shaped after an
 * architecture decision record*, which is where the phrase comes from.
 *
 * Where these land is deliberately not claimed here, because they do not land in the
 * same place: the Terraform is committed to your repository, the records are rows in the
 * project log. Every panel in this drawing is a label and nothing else, so the
 * distinction is made in the section copy in `app/page.tsx` instead. Putting "in your
 * repository" on one row and nothing on the others would be the worst of both — prose
 * where there is none, and an implication either way.
 *
 * ## Cost calculation is ahead of the product
 *
 * Read this before treating the third row as a description of what ships. Project cost
 * estimation is not built: the Costs tab in the project view is `locked: true`
 * unconditionally, with `COSTS_REASON = "Cost estimates are not available yet"`, and the
 * comment there explains that the tab is kept visible precisely so the gap is not
 * hidden. What does exist is per-*module* cost drivers, from
 * `@terrablox/terraform/aws-cost-drivers`, in the module library.
 *
 * The row is here as a deliberate call, made with that known — the landing page runs
 * slightly ahead of the build. Worth keeping in view for two reasons. The screenshots
 * further down the page show the tab bar with a padlock on Costs, so the page carries
 * both the claim and the evidence against it. And when the estimator lands, this row
 * stops being a promise and nobody has to remember it was one.
 */
const OUTPUTS = [
  { icon: GitCommitHorizontal, label: "Infrastructure" },
  { icon: ScrollText, label: "Architecture decisions" },
  { icon: Wallet, label: "Cost calculation" },
] as const;

/** CSS custom properties the flow rules read. Typed, so the cast stays in one place. */
function flowVars(vars: { delay?: number; duration?: number }): CSSProperties {
  const seconds = (value: number) => `${Math.round(value * 1000) / 1000}s`;

  return {
    ...(vars.delay === undefined
      ? {}
      : { "--flow-delay": seconds(vars.delay) }),
    ...(vars.duration === undefined
      ? {}
      : { "--flow-duration": seconds(vars.duration) }),
    "--loop-duration": seconds(LOOP_CYCLE_S),
  } as CSSProperties;
}

/**
 * The handover between two tiers. An arrow, and nothing else.
 *
 * It carried three animated tracks gathering into the arrow, which earned their place in
 * the stacked layout this replaced: there the tracks were as wide as the tier above and
 * converged, so they drew the narrowing. Sideways there is no narrowing to draw — the
 * tiers sit side by side at the same width — and three short dashes beside a list of
 * three rows only invited the reading that row one feeds track one. It does not.
 *
 * What is left says the whole of what this gap means, which is "and then". The
 * remaining motion in the drawing is inside the harness, where it is about the loop
 * repeating and is therefore about something.
 *
 * Rotates rather than swapping to a second icon: `ArrowRight` turned a quarter turn is
 * `ArrowDown`, and two imports for one glyph is two things to keep in step.
 */
function TierGap() {
  return (
    <div
      aria-hidden
      className="flex items-center justify-center py-2 lg:px-2 lg:py-0"
      role="none"
    >
      <ArrowRight className="h-4 w-4 rotate-90 text-muted-foreground/70 lg:rotate-0" />
    </div>
  );
}

/** One tier's worth of rows: the mouth and the spout are the same shape. */
function TierRows({
  label,
  rows,
  tone,
}: {
  label: string;
  // `LucideIcon` rather than a hand-written `ComponentType`: lucide's components are
  // `ForwardRefExoticComponent`s, which a narrower prop signature does not accept.
  rows: ReadonlyArray<{ icon: LucideIcon; label: string }>;
  tone: "neutral" | "outcome";
}) {
  return (
    <div className="min-w-0">
      <p className="mb-2 text-center font-mono text-[0.65rem] text-muted-foreground uppercase tracking-widest lg:text-left">
        {label}
      </p>

      <ul
        className={
          tone === "outcome"
            ? "stagger divide-y divide-emerald-600/20 rounded-lg border border-emerald-600/30 bg-emerald-500/[0.06]"
            : "stagger divide-y rounded-lg border bg-background"
        }
      >
        {rows.map((row) => (
          <li className="flex items-center gap-2.5 p-3" key={row.label}>
            <row.icon
              aria-hidden
              className={
                tone === "outcome"
                  ? "h-4 w-4 shrink-0 text-emerald-600"
                  : "h-4 w-4 shrink-0 text-muted-foreground"
              }
              strokeWidth={1.5}
            />
            <p className="min-w-0 font-medium text-sm leading-snug">
              {row.label}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function HarnessDiagram() {
  return (
    <figure className="reveal">
      <div className="p-4 sm:p-6">
        {/* Five columns: mouth, handover, harness, handover, spout.
        
            The harness gets the lion's share — `2.6fr` against `0.85fr` either side —
            because it is the only tier anybody needs to study, and the size of the
            element should say so. The ratio has to be stated explicitly: a row of boxes
            otherwise splits its width evenly, which would give the list of inputs the
            same weight as the thing this section is named after.
            
            `items-center` so the two short tiers sit against the middle of the harness
            rather than its top edge, which is what makes the row read as a flow through
            it instead of three things left-aligned at the ceiling. */}
        <div className="grid gap-2 lg:grid-cols-[minmax(0,0.85fr)_auto_minmax(0,2.6fr)_auto_minmax(0,0.85fr)] lg:items-center lg:gap-3">
          <TierRows label="What goes in" rows={SOURCES} tone="neutral" />

          <TierGap />

          {/* ---- The harness --------------------------------------------- */}
          <div className="relative min-w-0 overflow-hidden rounded-xl border border-primary/40 border-dashed bg-primary/[0.04] p-3 sm:p-4">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,hsl(var(--primary)/0.07),transparent_65%)]"
            />

            <div className="relative">
              <p className="text-center font-mono text-[0.65rem] text-primary/70 uppercase tracking-widest">
                Agent harness
              </p>

              {/* Requirements left of the loop, not above it.
              
                  This is the change that buys the height. As a strip across the top
                  with the loop under it — which is how the stacked version drew it —
                  the harness costs the loop plus a strip plus the arrow between them.
                  As a column it costs the loop, and the loop is what sets the height of
                  the whole section.
                  
                  Five columns, and the alignment is the grid's job rather than
                  anybody's arithmetic: requirements, its arrow and the loop each
                  span all three rows, so the three connector cells on the right share a
                  row with the panel they point at and the grid aligns them. Nothing is
                  positioned by hand, which is what stops a connector drifting when a
                  label wraps. */}
              {/* `auto` for the requirements column now that it is a vertical strip:
                  its width is one line of text on its side, so a fraction would only
                  pad it. The width it gives up goes to the loop and the three panels,
                  which are the ones with something to fit. */}
              <div className="mt-3 grid gap-2.5 lg:grid-cols-[auto_auto_minmax(0,1.6fr)_auto_minmax(0,1.05fr)] lg:grid-rows-[auto_auto_auto] lg:gap-x-0 lg:gap-y-2.5">
                {/* Requirements, set on its side.
                
                    `writing-mode: vertical-rl` rather than a `rotate-90` transform, and
                    the difference matters: a rotation leaves the element occupying its
                    original horizontal box, so the column would still be as wide as
                    "Requirements Engineering" is long and nothing would be saved. A
                    writing mode changes how the text is laid out, so the box really is
                    narrow and the grid can collapse the column to it.
                    
                    Top to bottom rather than bottom to top: it reads directly on from
                    the icon above it. The other convention — `rotate-180` on top of the
                    writing mode, the way a chart labels a y-axis — would put the first
                    word at the bottom and the icon at the far end of it.
                    
                    No icon. There was a checklist glyph above the text, kept upright
                    while the label turned; it has gone, and the box is better for it —
                    at this width the icon was the only thing making the strip wider
                    than one line of type, which was the whole reason for turning the
                    text in the first place.
                    
                    Horizontal again below `lg`, where the grid stacks and a sideways
                    label in a full-width row would be a tall thin box with one word in
                    it. */}
                <div className="min-w-0 rounded-lg border border-primary/25 bg-background/50 p-3 lg:row-span-3 lg:mr-1.5 lg:self-stretch lg:p-2.5">
                  {/* This wrapper looks redundant now that it holds one child, and it
                      is not. It was briefly removed, with `flex h-full` folded into the
                      paragraph, and the diagram grew from roughly 300px to 2445px:
                      measured, not guessed.

                      The reason is which element carries the vertical writing mode. Here
                      the wrapper lays out in the normal horizontal mode, so the turned
                      paragraph is an ordinary flex item on a vertical main axis — free
                      to shrink to its automatic minimum size, one word, and wrap into a
                      second column if the strip is shorter than the label. Fold the two
                      together and the flex container is itself in `vertical-rl` with
                      `height: 100%`, so its main axis is the same axis its height is
                      being resolved from, against a grid row that is sized by this very
                      box. Nothing bounds it and the strip stretches.

                      Keep the writing mode and the flex container on separate elements.
                      The `gap` utilities that spaced this from the old icon have gone
                      with the icon; the centring has not, because it is what holds one
                      short label in the middle of a full-height strip. */}
                  <div className="flex items-center lg:h-full lg:flex-col lg:justify-center">
                    <p className="min-w-0 font-medium text-sm leading-snug lg:[writing-mode:vertical-lr]">
                      Requirements Engineering
                    </p>
                  </div>
                </div>

                {/* Requirements into the loop. Hidden where the grid stacks, because a
                    sideways arrow between stacked boxes points at nothing. */}
                <div
                  aria-hidden
                  className="hidden items-center self-center lg:flex lg:row-span-3"
                  role="none"
                >
                  <span
                    className="flow flow-x h-px w-full min-w-6"
                    style={flowVars({ duration: 2.6 })}
                  />
                </div>

                {/* The loop. */}
                <div className="min-w-0 rounded-lg border border-primary/25 bg-background/50 p-3 lg:row-span-3 lg:mx-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-medium text-sm">Agent loop</p>
                    <span className="flex shrink-0 items-center gap-1 rounded-full border border-primary/30 bg-primary/5 px-1.5 py-0.5 font-mono text-[0.6rem] text-primary/80">
                      <RotateCcw aria-hidden className="h-2.5 w-2.5" />
                      repeats
                    </span>
                  </div>

                  <ol className="mt-2.5 space-y-1">
                    {LOOP.map((step, index) => (
                      <li
                        className="loop-step flex items-center gap-2 rounded-md border px-2 py-1.5"
                        key={step.label}
                        // A quarter of the cycle apart, so exactly one of the four is
                        // lit at any moment.
                        style={flowVars({
                          delay: (index * LOOP_CYCLE_S) / LOOP.length,
                        })}
                      >
                        <span className="font-mono text-[0.6rem] text-muted-foreground tabular-nums">
                          {index + 1}
                        </span>
                        <step.icon
                          aria-hidden
                          className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                          strokeWidth={1.5}
                        />
                        <span className="min-w-0 truncate text-xs">
                          {step.label}
                        </span>
                      </li>
                    ))}
                  </ol>

                  <ul className="mt-2.5 flex flex-wrap gap-1 border-t pt-2.5">
                    {ENRICHMENT.map((item) => (
                      <li
                        className="rounded border bg-background px-1.5 py-0.5 text-[0.65rem] text-muted-foreground"
                        key={item}
                      >
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>

                {/* The three bindings. Connector then panel, one pair per row, so the
                    grid keeps each label beside the box it describes. */}
                {BOUND.map((bound, index) => (
                  <Fragment key={bound.label}>
                    <div
                      aria-hidden
                      className="hidden flex-col items-center justify-center gap-1.5 lg:flex"
                      role="none"
                    >
                      <bound.icon
                        className="h-3.5 w-3.5 text-primary/70"
                        strokeWidth={1.75}
                      />
                      <span
                        className="flow flow-x h-px w-full min-w-10"
                        style={flowVars({
                          duration: LOOP_CYCLE_S / 3,
                          // Staggered so the three read as three relationships
                          // rather than one pulse across the whole panel.
                          delay: index * 0.9,
                        })}
                      />
                      <span className="text-center font-mono text-[0.55rem] text-primary/80 leading-tight">
                        {bound.via}
                      </span>
                    </div>

                    <div className="min-w-0 rounded-lg border border-primary/25 bg-background/50 p-3 lg:ml-1.5">
                      <div className="flex items-center gap-2">
                        <bound.panelIcon
                          aria-hidden
                          className="h-4 w-4 shrink-0 text-primary"
                          strokeWidth={1.5}
                        />
                        <p className="min-w-0 font-medium text-sm leading-snug">
                          {bound.label}
                        </p>
                      </div>
                    </div>
                  </Fragment>
                ))}
              </div>
            </div>
          </div>

          <TierGap />

          <TierRows label="What comes out" rows={OUTPUTS} tone="outcome" />
        </div>
      </div>
    </figure>
  );
}
