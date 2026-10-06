import { ArrowLeft, ArrowRight, Pencil } from "lucide-react";
import Link from "next/link";

import { DocsToc } from "@/components/docs-toc";
import { type Doc, type DocMeta, docHref } from "@/lib/docs";
import { GITHUB_URL } from "@/lib/links";

/**
 * One documentation page: heading, prose, contents, and the way out to GitHub.
 *
 * Shared by `/docs` and `/docs/[slug]` so the overview is not a second layout that
 * drifts from the pages it introduces.
 *
 * The HTML is set directly because it was produced by our own pipeline at build
 * time, from Markdown committed to this repository and reviewed in the pull request
 * that changed it. There is no user input anywhere in this path, and raw HTML in a
 * Markdown file is dropped rather than passed through — see `remarkRehype` in
 * `lib/docs.ts`, which is not given `allowDangerousHtml`.
 */
export function DocsPage({
  doc,
  previous,
  next,
}: {
  doc: Doc;
  previous: DocMeta | null;
  next: DocMeta | null;
}) {
  return (
    <div className="flex min-w-0 flex-1 gap-8 px-4 py-8 lg:px-8">
      <article className="min-w-0 flex-1">
        <header className="mb-8">
          <h1 className="font-semibold text-2xl tracking-tight">{doc.title}</h1>
          {doc.description ? (
            <p className="mt-2 text-base text-muted-foreground">
              {doc.description}
            </p>
          ) : null}
        </header>

        <div
          className="docs-prose"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: build-time output of our own Markdown pipeline, from files in this repository; see the note above this component.
          dangerouslySetInnerHTML={{ __html: doc.html }}
        />

        <footer className="mt-12 space-y-6 border-t pt-6">
          {/* Before the neighbours, because it is the link that matters: a reader who
              found something wrong here is one click from fixing it, and the file is
              named so the fix does not need to be searched for. */}
          <a
            className="inline-flex items-center gap-1.5 text-muted-foreground text-sm transition-colors hover:text-foreground"
            href={`${GITHUB_URL}/edit/main/docs/${doc.slug}.md`}
            rel="noreferrer noopener"
            target="_blank"
          >
            <Pencil className="h-3.5 w-3.5" />
            Edit this page on GitHub
          </a>

          {previous || next ? (
            <nav
              aria-label="Neighbouring pages"
              className="flex flex-col gap-3 sm:flex-row sm:justify-between"
            >
              {previous ? (
                <Link
                  className="group flex min-w-0 flex-col rounded-lg border px-4 py-3 transition-colors hover:bg-muted/50"
                  href={docHref(previous.slug)}
                >
                  <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
                    <ArrowLeft className="h-3 w-3" />
                    Previous
                  </span>
                  <span className="truncate font-medium text-sm">
                    {previous.title}
                  </span>
                </Link>
              ) : (
                <span />
              )}

              {next ? (
                <Link
                  className="group flex min-w-0 flex-col rounded-lg border px-4 py-3 text-right transition-colors hover:bg-muted/50 sm:items-end"
                  href={docHref(next.slug)}
                >
                  <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
                    Next
                    <ArrowRight className="h-3 w-3" />
                  </span>
                  <span className="truncate font-medium text-sm">
                    {next.title}
                  </span>
                </Link>
              ) : null}
            </nav>
          ) : null}
        </footer>
      </article>

      <DocsToc headings={doc.headings} />
    </div>
  );
}
