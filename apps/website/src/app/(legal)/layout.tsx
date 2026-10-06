import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

/**
 * The shell the Impressum and the privacy policy share.
 *
 * A route group, so the URLs stay `/impressum` and `/datenschutz` — a legal notice
 * has to be reachable at an address a reader would guess, and `/legal/impressum`
 * makes it one click deeper for no benefit.
 *
 * Narrower than the marketing pages on purpose: this is long-form prose that is read
 * rather than scanned, and `docs-prose` already styles bare elements against the
 * shared tokens, so both pages can be written as plain HTML.
 */
export default function LegalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />

      <main className="flex-1">
        <div className="mx-auto max-w-3xl px-4 py-12 md:py-16">
          {/*
            A banner used to sit here while any operator detail was still a
            placeholder. It is gone by request. The protection it stood for is not:
            `filled()` still omits a whole block rather than printing the marker
            text, so an incomplete page states less than the truth instead of
            something untrue — which is the failure mode that matters, since a
            legal notice with invented details is a false declaration rather than
            merely a missing one.
          */}
          <div className="docs-prose">{children}</div>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
