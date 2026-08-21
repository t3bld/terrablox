"use client";

import { Box } from "lucide-react";
import { useState } from "react";

import { type IconMode, isIconMode } from "@/lib/modules/icon";
import { AWS_ICON_NAMES } from "@/lib/terraform/aws-icon-manifest";

export interface ModuleIconRef {
  /** Source id, needed to reach the repository's own icon through our proxy. */
  sourceId: string | null;
  /** Which source to draw from. Anything unrecognised is treated as `repo`. */
  iconMode: IconMode | string | null;
  /** True when the import found an `icon.png` in the repository. */
  hasIcon: boolean;
  /** A bundled AWS icon name chosen by hand, without the extension. */
  iconName: string | null;
}

/**
 * A module's icon: whichever source its row names, or a neutral mark.
 *
 * The mode picks exactly one source. It does not fall through to the other one,
 * even when that other one is available — a module whose picture silently becomes
 * a different picture because a file was deleted upstream is harder to explain
 * than one that goes plain.
 *
 * It does fall back to the neutral mark, including on a load error rather than
 * only on missing data. An `icon.png` deleted upstream since the last import would
 * otherwise leave a broken image in a list, which reads as a bug in the product
 * rather than a change in the repository.
 */
export function ModuleIcon({
  icon,
  className = "h-8 w-8",
}: {
  icon: ModuleIconRef;
  className?: string;
}) {
  // The failure is remembered against the address that produced it, so switching
  // the icon on a mounted component gets a fresh attempt instead of inheriting
  // the previous one's verdict.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  const mode: IconMode = isIconMode(icon.iconMode) ? icon.iconMode : "repo";

  const bundled =
    icon.iconName && AWS_ICON_NAMES.includes(icon.iconName)
      ? icon.iconName
      : null;

  // No border and no fill: the AWS marks are already framed artwork, so a second
  // frame around them read as a box that had failed to load something. The
  // rounding stays, matched to the card's own corners, and clips anything square.
  const frame = `flex shrink-0 items-center justify-center overflow-hidden rounded-lg ${className}`;

  const src =
    mode === "repo" && icon.hasIcon && icon.sourceId
      ? `/api/modules/source/${icon.sourceId}/icon`
      : mode === "aws" && bundled
        ? `/aws-icons/${bundled}.svg`
        : null;

  if (src && failedSrc !== src) {
    return (
      <span className={frame}>
        {/* biome-ignore lint/performance/noImgElement: next/image needs a known
            width and a remote-pattern allowlist; the repository case is bytes
            from a repository we do not control, through our own proxy, and the
            bundled case is an SVG from our own `public` that next/image passes
            through untouched. There is nothing for it to optimise. */}
        <img
          alt=""
          className="h-full w-full object-contain"
          loading="lazy"
          onError={() => setFailedSrc(src)}
          src={src}
        />
      </span>
    );
  }

  // The placeholder keeps a frame, unlike a real icon: a lone outline glyph
  // floating in the layout reads as an image that failed, whereas a bordered
  // square reads as "this module has no icon", which is what it means.
  return (
    <span className={`${frame} border bg-muted/40`}>
      <Box className="h-1/2 w-1/2 text-muted-foreground" />
    </span>
  );
}
