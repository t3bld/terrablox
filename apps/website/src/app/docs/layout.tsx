import type { Metadata } from "next";

import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export const metadata: Metadata = {
  title: {
    // Every page under here appends its own title, so the tab says which page of
    // the documentation is open rather than only that it is the documentation.
    template: "%s — Terrablox docs",
    default: "Documentation — Terrablox",
  },
};

/**
 * The shell every documentation page shares.
 *
 * The sidebar is not here but in the page, because it needs to know which entry is
 * current — a layout in the App Router does not re-render per page and cannot be
 * given the slug. Keeping it in the page is what makes `aria-current` correct.
 */
export default function DocsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col lg:flex-row">
        {children}
      </div>
      <SiteFooter />
    </div>
  );
}
