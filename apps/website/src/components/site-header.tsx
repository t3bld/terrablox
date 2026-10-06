import { Button } from "@terrablox/ui/button";
import { Github } from "lucide-react";
import Link from "next/link";

import { DOCS_URL, GITHUB_URL } from "@/lib/links";

/**
 * The site's top navigation.
 *
 * Lives here rather than in @terrablox/ui on purpose: the dashboard navigates
 * through a sidebar, so a top bar would be a shared component with exactly one
 * consumer. It is built from the package's primitives, which is what keeps it
 * looking like the product without being part of it.
 *
 * No nav links at all now. There were six section anchors, which pointed into the page
 * the reader was already scrolling; those went, leaving a single "Docs" entry, and that
 * has gone too — the primary button beside it leads to the same place, so the bar was
 * offering the documentation twice and spending its only nav slot on the duplicate.
 *
 * What is left is the wordmark and two buttons: the source, and the way in. If a second
 * destination ever earns a place here it needs to be somewhere neither button goes.
 */
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4 sm:gap-6">
        <Link className="font-semibold tracking-tight" href="/">
          Terrablox
        </Link>

        <div className="ml-auto flex items-center gap-2">
          {/* Visible at every width again. It was `hidden sm:inline-flex`, because a
              375px bar holding the wordmark, a Docs link, this and "Get started" pushed
              the last one off the right edge and gave the whole document a horizontal
              scrollbar. The Docs link has since gone, so the crowding it solved is
              gone with it.

              Worth restoring rather than leaving hidden: this is now the only route to
              the repository from the landing page or the footer, and an open-source
              project whose source is unreachable on a phone — bar the Impressum — has
              hidden the wrong thing. If the bar gets crowded again, shrink this to its
              icon before hiding it. */}
          <Button asChild size="sm" variant="ghost">
            <a href={GITHUB_URL} rel="noreferrer noopener" target="_blank">
              <Github className="mr-1.5 h-4 w-4" />
              GitHub
            </a>
          </Button>
          {/* To the documentation on this site, not to the README's quick-start
              anchor. It sent the one visitor most likely to act off to a file listing
              on GitHub, where the first thing they met was the repository rather than
              the instructions. `Link` rather than `a`, now that it is an internal
              route: it prefetches and navigates on the client. */}
          <Button asChild size="sm">
            <Link href={DOCS_URL}>
              {/* "Start" on a 320px screen, where the full label was the last four
                  pixels of overflow. Two spans rather than a CSS truncation so the
                  short form is a chosen word instead of a clipped one. */}
              <span className="sm:hidden">Start</span>
              <span className="hidden sm:inline">Get started</span>
            </Link>
          </Button>
        </div>
      </div>
    </header>
  );
}
