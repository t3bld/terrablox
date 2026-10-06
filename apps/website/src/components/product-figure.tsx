import { ImageOff } from "lucide-react";

import { FIGURE_CHROME, FigureDots } from "@/components/figure-chrome";

/**
 * A framed screenshot of the dashboard.
 *
 * For a single screenshot. Where a reader should be able to switch between screens
 * of the same project, `ProjectViewFigure` draws the same frame around a set.
 *
 * Drawn as a window — a title bar with the route in it — because a bare PNG of a
 * dark UI on a light page reads as a rendering fault. The frame also gives the
 * image an aspect ratio before it loads, which is what stops the page from jumping
 * as each one arrives.
 *
 * `img` rather than `next/image`: the export is served by a static host with no
 * optimiser, so the component would emit the same file behind more machinery.
 * `loading="lazy"` and the explicit ratio do the part that matters here.
 *
 * `src` may be null, and that is not an oversight. Screenshots have to be captured
 * from a running dashboard with real data in it, so until one exists the figure
 * says so in place rather than rendering a broken image. Drop the file into
 * `public/screenshots/` and pass its path.
 */
export function ProductFigure({
  src,
  alt,
  route,
  caption,
  ratio = "16 / 10",
  objectPosition = "center top",
  priority = false,
}: {
  /** Path under `public`, or null while the screenshot has not been taken. */
  src: string | null;
  alt: string;
  /** Shown in the title bar, so the reader knows where in the product they are. */
  route: string;
  /** Omitted in the hero, where the surrounding copy is the caption. */
  caption?: string;
  ratio?: string;
  /**
   * Which part of the image survives the crop.
   *
   * `center top` for a figure in a column. The hero's copy bleeds past the right
   * edge of the page, so it pins to `left top` instead — otherwise centring throws
   * away the left of the screenshot, which is the half that is still on screen.
   */
  objectPosition?: string;
  /**
   * Load this one immediately instead of lazily.
   *
   * For the hero figure only, and not a micro-optimisation: it is the largest
   * element above the fold, which makes it the page's LCP. `loading="lazy"` defers
   * the request until layout has run, so lazy-loading the very image the metric is
   * measuring delays the metric — the browser cannot start the fetch until it knows
   * the image is in view, by which time it could already have been decoding.
   * Anything further down the page keeps the lazy default, where it does help.
   */
  priority?: boolean;
}) {
  return (
    <figure className={FIGURE_CHROME.figure}>
      <div className={FIGURE_CHROME.titleBar}>
        <FigureDots />
        <span className={FIGURE_CHROME.route}>{route}</span>
      </div>

      <div className="relative bg-muted/20" style={{ aspectRatio: ratio }}>
        {src ? (
          // `next/image` optimises through a server this site does not have: the
          // export sets `images.unoptimized`, so it would emit this same file and
          // add JavaScript to a page that currently ships none. The aspect ratio
          // and the lazy attribute are the parts of it that were doing any work.
          // biome-ignore lint/performance/noImgElement: reason above.
          <img
            alt={alt}
            className="absolute inset-0 h-full w-full object-cover"
            decoding={priority ? "sync" : "async"}
            fetchPriority={priority ? "high" : undefined}
            loading={priority ? "eager" : "lazy"}
            src={src}
            style={{ objectPosition }}
          />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center">
            <ImageOff className="h-5 w-5 text-muted-foreground" />
            <p className="text-muted-foreground text-xs leading-relaxed">
              {alt}
            </p>
          </div>
        )}
      </div>

      {caption ? (
        <figcaption className={FIGURE_CHROME.caption}>{caption}</figcaption>
      ) : null}
    </figure>
  );
}
