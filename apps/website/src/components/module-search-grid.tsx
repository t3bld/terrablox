"use client";

import { Input } from "@terrablox/ui/input";
import { Box, Search } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

/**
 * What a tile needs, and deliberately nothing more.
 *
 * The catalogue entries carry ports, resource types and a laid-out architecture
 * diagram — around 660 KB across fifty of them. This is a client component, so
 * whatever it is handed is serialised into the page for hydration: passing entries
 * would put the whole snapshot in the HTML to render fifty names. The server
 * component narrows them first.
 */
export interface ModuleTile {
  slug: string;
  name: string;
  /** File name under `/module-icons`, already prefixed for the deployment. */
  iconSrc: string | null;
}

/**
 * The catalogue as a browsable grid.
 *
 * Name and icon only. A description per tile is what turned the first version of
 * this into four screens of scrolling — at fifty modules the useful question is
 * "is the one I need in here", which a name answers and a paragraph delays. The
 * detail is one click away.
 *
 * The filter is client-side over a list that is already fully in the page, so it
 * costs no request and works while offline. It matches the slug as well as the
 * display name, because someone who knows Terraform is as likely to type
 * `rds-aurora` as "Aurora".
 */
export function ModuleSearchGrid({ modules }: { modules: ModuleTile[] }) {
  const [query, setQuery] = useState("");

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return modules;

    return modules.filter(
      (module) =>
        module.name.toLowerCase().includes(needle) ||
        module.slug.includes(needle),
    );
  }, [modules, query]);

  return (
    <div>
      {/* The count sits beside the field rather than inside it, and that is a
          constraint rather than a preference: `type="search"` makes Chrome and Safari
          draw their own clear button at the right inside edge as soon as there is
          text, so a badge there would fight it for the same few pixels exactly while
          someone is filtering. Beside it also reads correctly — a result summary is
          about the list, not a hint about what to type. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="relative min-w-[12rem] max-w-sm flex-1">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            aria-label="Search modules"
            className="pl-9"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search modules"
            type="search"
            value={query}
          />
        </div>

        {/* Announced rather than only shown, so a filter that empties the grid is
            not silence for someone using a screen reader.

            `tabular-nums` because this changes on every keystroke, and proportional
            digits make the whole line twitch sideways as it does. */}
        <p
          aria-live="polite"
          className="shrink-0 text-muted-foreground text-xs tabular-nums"
        >
          {matches.length === modules.length ? (
            `${modules.length} modules`
          ) : (
            // The matched number is the one that just changed, so it is the one
            // worth catching the eye; the total stays quiet beside it.
            <>
              <span className="font-medium text-foreground">
                {matches.length}
              </span>{" "}
              of {modules.length} modules
            </>
          )}
        </p>
      </div>

      {matches.length === 0 ? (
        <p className="mt-6 text-muted-foreground text-sm">
          Nothing matches &ldquo;{query.trim()}&rdquo;. You can import any
          module from a repository your GitHub account can read, so the library
          is not limited to this list.
        </p>
      ) : (
        <ul className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {matches.map((module) => (
            <li key={module.slug}>
              <Link
                className="flex items-center gap-2 rounded-md border bg-card px-2.5 py-2 transition-colors hover:border-foreground/30 hover:bg-muted/40"
                href={`/modules/${module.slug}`}
              >
                {module.iconSrc ? (
                  // biome-ignore lint/performance/noImgElement: a committed asset at a fixed size on a static host; there is no optimiser behind GitHub Pages.
                  <img
                    alt=""
                    className="h-6 w-6 shrink-0 object-contain"
                    loading="lazy"
                    src={module.iconSrc}
                  />
                ) : (
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded border bg-muted/40">
                    <Box className="h-3.5 w-3.5 text-muted-foreground" />
                  </span>
                )}

                <span className="truncate text-sm">{module.name}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
