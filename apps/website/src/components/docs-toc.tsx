import type { DocHeading } from "@/lib/docs";

/**
 * The headings of the page being read.
 *
 * Plain links, with no highlighting of the section currently in view. That would
 * need a scroll listener, which would be the first JavaScript on a site that
 * deliberately has none — and it would buy a visual nicety on the one column a
 * reader is least likely to be looking at.
 *
 * Hidden below `xl` rather than collapsed into a menu: the headings are also in the
 * article, so on a narrow window this column is a duplicate rather than a loss.
 */
export function DocsToc({ headings }: { headings: DocHeading[] }) {
  // One or two headings is not a structure worth a column of its own.
  if (headings.length < 3) return null;

  return (
    <aside className="hidden w-56 shrink-0 xl:block">
      <div className="sticky top-16 max-h-[calc(100vh-4rem)] overflow-y-auto py-8 pr-4">
        <h2 className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-wide">
          On this page
        </h2>

        <nav aria-label="On this page">
          <ul className="space-y-1 border-l text-sm">
            {headings.map((heading) => (
              <li key={`${heading.depth}-${heading.id}`}>
                <a
                  className={`-ml-px block border-l border-transparent py-0.5 text-muted-foreground transition-colors hover:border-foreground hover:text-foreground ${
                    heading.depth === 3 ? "pl-6" : "pl-3"
                  }`}
                  href={`#${heading.id}`}
                >
                  {heading.text}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </aside>
  );
}
