import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import rehypeShiki from "@shikijs/rehype";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeSlug from "rehype-slug";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

/**
 * The documentation, read from Markdown at build time.
 *
 * The files live in `docs/` at the repository root rather than inside this app, and
 * that placement is the whole feature: they stay readable on GitHub, they are
 * reviewed in the same pull request as the change they document, and editing the
 * site means editing prose rather than JSX. The README and the site's own links
 * already pointed at that folder before it existed.
 *
 * Everything here runs during `next build` and nothing ships to the browser. The
 * site is a static export with no client components — see `next.config.mjs` — so a
 * runtime Markdown renderer would be the first JavaScript on it, and a search index
 * or a scroll-spy table of contents would be the second. Both are deliberately
 * absent rather than forgotten.
 *
 * Navigation is derived, never declared. A file's front matter says where it belongs
 * and in what order, so adding a page is adding a file — the promise that made this
 * worth building instead of writing the pages by hand.
 */

/**
 * Resolved from the working directory rather than from `import.meta.url`.
 *
 * Next compiles this module into `.next/`, and the depth of that path is an
 * implementation detail that has changed between versions. The working directory
 * during a build is the app's own directory, which Turbo and a bare `next build`
 * agree on.
 */
const DOCS_DIR = path.resolve(process.cwd(), "..", "..", "docs");

/** The page rendered at `/docs` itself. */
const INDEX_SLUG = "index";

export interface DocMeta {
  slug: string;
  title: string;
  /** One sentence, used as the page description and under the heading. */
  description: string;
  /** Sidebar section. Pages with no group are listed before every section. */
  group: string | null;
  /** Sort key inside a group; ties fall back to the title. */
  order: number;
}

export interface DocHeading {
  id: string;
  text: string;
  /** Only 2 and 3 are collected; a page has exactly one `h1`, its title. */
  depth: 2 | 3;
}

export interface Doc extends DocMeta {
  html: string;
  headings: DocHeading[];
}

/**
 * Reads the front matter block without a YAML parser.
 *
 * The shape is ours and it is four scalar keys, so a parser would be a dependency
 * bought for `key: value`. Anything it cannot understand is left to the caller's
 * defaults instead of throwing: a typo in a heading should not fail a build of
 * every other page.
 */
function splitFrontMatter(source: string): {
  data: Record<string, string>;
  body: string;
} {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { data: {}, body: source };

  const data: Record<string, string> = {};

  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    const value = line
      .slice(separator + 1)
      .trim()
      // Quotes are optional and stripped, so a description containing a colon can
      // be written the obvious way.
      .replace(/^["'](.*)["']$/, "$1");

    if (key) data[key] = value;
  }

  return { data, body: source.slice(match[0].length) };
}

/** Just enough of the rendered tree to walk it without pulling in hast types. */
interface TreeNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: { id?: unknown };
  children?: TreeNode[];
}

/** A heading's visible text, with its inline markup flattened away. */
function textOf(node: TreeNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(textOf).join("");
}

/**
 * Collects the `h2` and `h3` headings from the rendered tree.
 *
 * From the tree and not from the Markdown source, which is the second attempt: the
 * first reimplemented `rehype-slug`'s identifier from the heading text, and the two
 * disagreed on the first heading containing an underscore — `About
 * BETTER_AUTH_SECRET` became `about-betterauthsecret` here and
 * `about-better_auth_secret` in the document, so the contents entry linked to
 * nothing. Reading the attribute the document actually carries cannot drift, and it
 * gets duplicate-heading suffixes right for free because the slugger has already
 * assigned them.
 *
 * Ordered after `rehypeSlug` and `rehypeAutolinkHeadings` in the pipeline: the first
 * is what puts the `id` there, and the second wraps the text in a link, which is why
 * the text is gathered recursively rather than read off one child.
 */
function collectHeadings() {
  return (tree: TreeNode, file: { data: Record<string, unknown> }) => {
    const headings: DocHeading[] = [];

    const walk = (node: TreeNode) => {
      const heading =
        node.type === "element" &&
        (node.tagName === "h2" || node.tagName === "h3");

      if (heading) {
        const id = node.properties?.id;

        if (typeof id === "string") {
          headings.push({
            id,
            text: textOf(node).trim(),
            depth: node.tagName === "h2" ? 2 : 3,
          });
        }

        // Nothing inside a heading is another heading, so the subtree is skipped.
        return;
      }

      for (const child of node.children ?? []) walk(child);
    };

    walk(tree);

    // Through the vfile rather than a closure, so the processor below can stay a
    // module-level singleton. Rebuilding it per page would re-initialise Shiki's
    // highlighter each time, which is the expensive part of this pipeline.
    file.data.headings = headings;
  };
}

const processor = unified()
  .use(remarkParse)
  // Tables, task lists and strikethrough. Documentation is mostly tables.
  .use(remarkGfm)
  // `allowDangerousHtml` is not set: raw HTML in a Markdown file is dropped rather
  // than passed through, which keeps the pages to one authoring format.
  .use(remarkRehype)
  .use(rehypeSlug)
  // Wraps each heading in a link to itself, so any paragraph can be linked to.
  // `wrap` keeps the heading text as the link body instead of adding a visible
  // anchor character next to it.
  .use(rehypeAutolinkHeadings, {
    behavior: "wrap",
    properties: { className: "heading-anchor" },
  })
  // After the two above, so the `id` is already on the heading and the text is
  // already wrapped in its link.
  .use(collectHeadings)
  .use(rehypeShiki, {
    // Two themes rather than one, emitted as CSS variables, so the code blocks
    // follow the page instead of being a dark rectangle in a light design. The
    // stylesheet switches between them on `.dark`.
    themes: { light: "github-light", dark: "github-dark" },
    defaultColor: false,
  })
  .use(rehypeStringify);

async function render(
  body: string,
): Promise<{ html: string; headings: DocHeading[] }> {
  const file = await processor.process(body);

  return {
    html: String(file),
    headings: (file.data.headings as DocHeading[] | undefined) ?? [],
  };
}

function metaFrom(slug: string, data: Record<string, string>): DocMeta {
  const order = Number(data.order);

  return {
    slug,
    // Falling back to the slug rather than to "Untitled": a missing title is a
    // mistake, and one that names the file is the fastest to find.
    title: data.title || slug,
    description: data.description ?? "",
    group: data.group || null,
    order: Number.isFinite(order) ? order : Number.MAX_SAFE_INTEGER,
  };
}

/** Every page, in sidebar order. */
export function listDocs(): DocMeta[] {
  const files = readdirSync(DOCS_DIR).filter((name) => name.endsWith(".md"));

  const pages = files.map((name) => {
    const slug = name.replace(/\.md$/, "");
    const { data } = splitFrontMatter(
      readFileSync(path.join(DOCS_DIR, name), "utf8"),
    );

    return metaFrom(slug, data);
  });

  return pages.sort(
    (a, b) => a.order - b.order || a.title.localeCompare(b.title),
  );
}

/** The pages of one group, or null when the group has none. */
export interface DocGroup {
  /** Null for pages written before any section, e.g. the overview. */
  label: string | null;
  pages: DocMeta[];
}

/**
 * The sidebar, grouped in the order the groups first appear.
 *
 * First appearance rather than alphabetical, so the order of the sections is
 * controlled by the same `order` key that controls the pages — one thing to reason
 * about instead of two.
 */
export function docNav(): DocGroup[] {
  const groups: DocGroup[] = [];

  for (const page of listDocs()) {
    const existing = groups.find((group) => group.label === page.group);

    if (existing) existing.pages.push(page);
    else groups.push({ label: page.group, pages: [page] });
  }

  return groups;
}

/** One page, rendered. Null when there is no such file. */
export async function readDoc(slug: string): Promise<Doc | null> {
  let source: string;

  try {
    source = readFileSync(path.join(DOCS_DIR, `${slug}.md`), "utf8");
  } catch {
    return null;
  }

  const { data, body } = splitFrontMatter(source);
  const { html, headings } = await render(body);

  return { ...metaFrom(slug, data), html, headings };
}

export async function readIndexDoc(): Promise<Doc | null> {
  return readDoc(INDEX_SLUG);
}

/** The slugs `/docs/[slug]` is generated for: everything except the index. */
export function docSlugs(): string[] {
  return listDocs()
    .map((page) => page.slug)
    .filter((slug) => slug !== INDEX_SLUG);
}

/** Where a page lives on the site. The index is `/docs` itself. */
export function docHref(slug: string): string {
  return slug === INDEX_SLUG ? "/docs" : `/docs/${slug}`;
}
