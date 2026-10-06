import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { DocsPage } from "@/components/docs-page";
import { DocsSidebar } from "@/components/docs-sidebar";
import { docNav, listDocs, readIndexDoc } from "@/lib/docs";

export async function generateMetadata(): Promise<Metadata> {
  const doc = await readIndexDoc();
  if (!doc) return {};

  return { title: doc.title, description: doc.description };
}

/** `/docs`, rendered from `docs/index.md`. */
export default async function DocsIndexPage() {
  const doc = await readIndexDoc();

  // A build with no `docs/index.md` should fail loudly on the page rather than
  // publish an empty section, so this is a 404 rather than a placeholder.
  if (!doc) notFound();

  const pages = listDocs();
  const position = pages.findIndex((page) => page.slug === doc.slug);

  return (
    <>
      <DocsSidebar current={doc.slug} nav={docNav()} />
      <DocsPage
        doc={doc}
        next={pages[position + 1] ?? null}
        previous={position > 0 ? (pages[position - 1] ?? null) : null}
      />
    </>
  );
}
