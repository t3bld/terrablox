import { ImageOff, Network, ScrollText, Workflow } from "lucide-react";

import { FIGURE_CHROME, FigureDots } from "@/components/figure-chrome";

/**
 * Three screens of one project, with a switch between them.
 *
 * Detail and Architecture are the two levels of the Code tab's canvas — the module
 * blocks and their wires, then the AWS services those modules deploy. Logs is a
 * different tab: the operations that were applied, each under the decision that
 * produced it and the reason it was made.
 *
 * Which is worth stating, because it means this control is *not* a copy of any one
 * control in the product. The dashboard's own switch toggles the canvas level and
 * nothing else; Logs is reached from the tab bar above it. What this offers is three
 * views of a project, and the labels, icons, hints and routes are lifted from the
 * real screens so a visitor who signs in recognises where they have already been.
 *
 * ## No JavaScript
 *
 * Radio inputs and CSS, not `useState`. Native radios come with the keyboard and
 * screen reader behaviour for free — arrow keys move through the options and the
 * group is announced as a group — it works before hydration, and there is no state
 * to get out of sync because there is no state.
 *
 * The cost is that views cannot be a runtime list. Tailwind generates its classes by
 * reading the source, so `group-has-[.figure-view-logs:checked]:opacity-100` has to
 * appear literally somewhere it can find it. Hence `VIEWS` below: the loop over it
 * is ordinary, but every selector inside it is written out. Adding a fourth view is
 * one entry there, and the entry is mechanical.
 *
 * The switch sits *above* the frame rather than over the image, which is where the
 * real one sits. All three screenshots already contain the product's own controls in
 * their top-left corner, so drawing ours there would put a live control on top of a
 * picture of one.
 *
 * `:has()` carries the whole thing. Where it is unsupported the switch does nothing
 * and the Detail view stays on screen, which is what the section showed before any
 * of this existed.
 */
export function ProjectViewFigure({
  id,
  screenshots,
  ratio = "3 / 2",
}: {
  /**
   * Unique on the page, and required rather than generated.
   *
   * It becomes the radios' `name`, which is what makes them one group, and the stem
   * of their `id`, which is what lets a label click reach a visually hidden input.
   * `useId` would make this a client component, which is the thing being avoided.
   */
  id: string;
  /**
   * The picture for each view. Content, so it comes from the page — everything else
   * about a view is a fact about the product and lives in `VIEWS`.
   *
   * A `src` of null is not an oversight: screenshots have to be captured from a
   * running dashboard with real data in it, and until one exists the figure says so
   * in place rather than rendering a broken image.
   */
  screenshots: Record<ProjectViewKey, ProjectViewScreenshot>;
  /**
   * One ratio for all three, so switching cannot move the page.
   *
   * The captures are framed differently — 1.37 for the canvas-only Detail shot
   * against 1.54 for the full window — and giving each its own ratio would resize
   * the section under the reader's cursor. A shared box crops instead, and
   * `objectPosition` aims the crop.
   */
  ratio?: string;
}) {
  return (
    // The group is the fieldset, not the figure: the switch and the route in the
    // title bar both react to the selection and they sit in different subtrees.
    <fieldset className="group">
      <legend className="sr-only">
        Which view of the project to show: module detail, the AWS architecture,
        or the log of what was decided and applied
      </legend>

      {/* Visually hidden, still focusable and still in the accessibility tree; the
          labels below are what is drawn. `defaultChecked` puts a `checked`
          attribute in the exported HTML, so Detail is on screen in the markup
          itself rather than after a first paint. */}
      {VIEWS.map((view) => (
        <input
          className={`${view.markerClass} sr-only`}
          defaultChecked={view.key === "detail"}
          id={`${id}-${view.key}`}
          key={view.key}
          name={id}
          type="radio"
          value={view.key}
        />
      ))}

      {/* Same shape as the controls in the product: a bordered strip, the active
          one filled. `w-fit` stops it stretching across the column. */}
      <div className="mb-3 flex w-fit items-center rounded-lg border bg-background/95 p-0.5 shadow-sm backdrop-blur">
        {VIEWS.map((view) => (
          <label
            className={`${LABEL_BASE} ${view.labelClass}`}
            htmlFor={`${id}-${view.key}`}
            key={view.key}
            title={view.hint}
          >
            <view.icon aria-hidden className="h-3.5 w-3.5 shrink-0" />
            {view.label}
          </label>
        ))}
      </div>

      <figure className={FIGURE_CHROME.figure}>
        <div className={FIGURE_CHROME.titleBar}>
          <FigureDots />
          {/* One span per view, because picking between them is the only thing CSS
              can do here. Detail and Architecture carry the same route on purpose:
              they are two levels of one tab, and the level is component state in
              the product, not part of the URL. */}
          {VIEWS.map((view) => (
            <span
              className={`${FIGURE_CHROME.route} ${view.routeClass}`}
              key={view.key}
            >
              {view.route}
            </span>
          ))}
        </div>

        <div className="relative bg-muted/20" style={{ aspectRatio: ratio }}>
          {VIEWS.map((view) => (
            <ProjectViewImage
              className={view.mediaClass}
              key={view.key}
              screenshot={screenshots[view.key]}
            />
          ))}
        </div>
      </figure>
    </fieldset>
  );
}

export type ProjectViewKey = "detail" | "architecture" | "logs";

export type ProjectViewScreenshot = {
  /** Path under `public`, or null while the screenshot has not been taken. */
  src: string | null;
  alt: string;
  /** Which part of the image survives the shared crop. */
  objectPosition?: string;
};

/** Everything about a view that is a fact about the product rather than page content. */
const LABEL_BASE =
  "flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 font-medium text-muted-foreground text-xs transition-colors hover:text-foreground";

/**
 * The three views, in the order the product presents them.
 *
 * Every selector is spelled out rather than built from `key`, and that is the whole
 * constraint of doing this without JavaScript: Tailwind scans source text, so a
 * class name assembled at runtime is a class name it never emits. The repetition is
 * the price of the switch working before any script has loaded.
 *
 * Labels and hints are the product's own, from the level switch and the tab bar in
 * `apps/dashboard/.../projects/[projectId]/page.tsx`. Kept as "Detail" rather than
 * "Details" for the same reason: it is the word on the real button.
 *
 * Routes are the real fragments. `URL_TABS` there is
 * `["code", "deploy", "state", "costs", "log"]`, and the canvas level is not in the
 * URL at all — so Detail and Architecture are both `#code`, and an earlier
 * `#architecture` in this file was a URL that does not exist. `tabFromHash` would
 * have silently resolved it to `code`.
 */
const VIEWS = [
  {
    key: "detail" as const,
    label: "Detail",
    hint: "Module blocks, their inputs and the wires between them",
    route: "/projects/…#code",
    icon: Workflow,
    markerClass: "figure-view-detail",
    labelClass:
      "group-has-[.figure-view-detail:checked]:bg-secondary group-has-[.figure-view-detail:checked]:text-foreground group-has-[.figure-view-detail:focus-visible]:ring-2 group-has-[.figure-view-detail:focus-visible]:ring-ring",
    routeClass: "hidden group-has-[.figure-view-detail:checked]:inline",
    mediaClass: "opacity-0 group-has-[.figure-view-detail:checked]:opacity-100",
  },
  {
    key: "architecture" as const,
    label: "Architecture",
    hint: "The AWS services these modules deploy, and how they connect",
    route: "/projects/…#code",
    icon: Network,
    markerClass: "figure-view-architecture",
    labelClass:
      "group-has-[.figure-view-architecture:checked]:bg-secondary group-has-[.figure-view-architecture:checked]:text-foreground group-has-[.figure-view-architecture:focus-visible]:ring-2 group-has-[.figure-view-architecture:focus-visible]:ring-ring",
    routeClass: "hidden group-has-[.figure-view-architecture:checked]:inline",
    mediaClass:
      "opacity-0 group-has-[.figure-view-architecture:checked]:opacity-100",
  },
  {
    key: "logs" as const,
    label: "Logs",
    hint: "What was applied, under the decision that produced it",
    route: "/projects/…#log",
    icon: ScrollText,
    markerClass: "figure-view-logs",
    labelClass:
      "group-has-[.figure-view-logs:checked]:bg-secondary group-has-[.figure-view-logs:checked]:text-foreground group-has-[.figure-view-logs:focus-visible]:ring-2 group-has-[.figure-view-logs:focus-visible]:ring-ring",
    routeClass: "hidden group-has-[.figure-view-logs:checked]:inline",
    mediaClass: "opacity-0 group-has-[.figure-view-logs:checked]:opacity-100",
  },
];

/**
 * One of the stacked screenshots.
 *
 * All three stay mounted and all three keep their `alt`. Hiding the inactive ones
 * from assistive technology would need `aria-hidden` to change with the selection,
 * which CSS cannot do; leaving them described is the better failure, because those
 * descriptions are the three things this section is offering to show.
 *
 * `pointer-events-none`: they are stacked, so without it the topmost would swallow
 * a drag or a right-click meant for whichever is visible.
 */
function ProjectViewImage({
  screenshot,
  className,
}: {
  screenshot: ProjectViewScreenshot;
  className: string;
}) {
  if (!screenshot.src) {
    return (
      <div
        className={`absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center transition-opacity duration-200 ${className}`}
      >
        <ImageOff aria-hidden className="h-5 w-5 text-muted-foreground" />
        <p className="max-w-sm text-muted-foreground text-xs leading-relaxed">
          {screenshot.alt}
        </p>
      </div>
    );
  }

  return (
    // `next/image` optimises through a server this site does not have — the export
    // sets `images.unoptimized`, so it would emit this same file behind more
    // machinery. Same note as in `product-figure.tsx`.
    // biome-ignore lint/performance/noImgElement: reason above.
    <img
      alt={screenshot.alt}
      className={`pointer-events-none absolute inset-0 h-full w-full object-cover transition-opacity duration-200 ${className}`}
      decoding="async"
      loading="lazy"
      src={screenshot.src}
      style={{ objectPosition: screenshot.objectPosition ?? "center top" }}
    />
  );
}
