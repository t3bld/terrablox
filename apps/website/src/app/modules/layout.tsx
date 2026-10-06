import type { Metadata } from "next";

import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

/**
 * `default` is required alongside `template` by Next's own type, but no route reaches
 * it: there is no page at `/modules` since the catalogue became a section of the
 * landing page, and every module page sets its own title.
 */
export const metadata: Metadata = {
  title: {
    template: "%s — Terrablox modules",
    default: "Module library — Terrablox",
  },
};

export default function ModulesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-10">
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}
