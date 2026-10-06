import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { DocsPage } from "@/components/docs-page";
import { DocsSidebar } from "@/components/docs-sidebar";
import { docNav, docSlugs, listDocs, readDoc } from "@/lib/docs";

/**
 * One route per Markdown file, worked out at build time.
 *
 * This is what makes a new file a new page with no other edit: the export is a
 * static site, so the set of pages is fixed when it is built, and it is read from
 * the directory rather than from a list anybody maintains.
 */
export function generateStaticParams(): { slug: string }[] {
  return docSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: { slug: string };
}): Promise<Metadata> {
  const doc = await readDoc(params.slug);
  if (!doc) return {};

  return { title: doc.title, description: doc.description };
}

export default async function DocPage({
  params,
}: {
  params: { slug: string };
}) {
  const doc = await readDoc(params.slug);
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
