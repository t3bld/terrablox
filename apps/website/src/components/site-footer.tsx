import Link from "next/link";

import { IMPRESSUM_URL, PRIVACY_URL } from "@/lib/links";

/**
 * The two links that have to be on every page.
 *
 * § 5 DDG wants the provider identification permanently available, and this footer is
 * what makes that true site-wide. The labels stay German — "Impressum" and
 * "Datenschutz" are the terms courts have accepted as recognisable, and a translated
 * label is the one thing about these pages worth not being creative with.
 *
 * These are the only links here on purpose. The footer used to also carry GitHub, the
 * documentation, the issue tracker and the licence; they were removed, and anything
 * added back belongs in its own group rather than in this array, so a reshuffle of
 * project links cannot take the legal ones with it.
 */
const LEGAL_LINKS = [
  { label: "Impressum", href: IMPRESSUM_URL },
  { label: "Datenschutz", href: PRIVACY_URL },
];

export function SiteFooter() {
  return (
    <footer className="border-t">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 text-sm sm:flex-row sm:items-center">
        <p className="text-muted-foreground">Terrablox</p>

        <nav
          aria-label="Footer"
          className="flex flex-wrap items-center gap-x-4 gap-y-2 sm:ml-auto"
        >
          {LEGAL_LINKS.map((link) => (
            <Link
              className="text-muted-foreground transition-colors hover:text-foreground"
              href={link.href}
              key={link.label}
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
    </footer>
  );
}
