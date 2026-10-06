import Link from "next/link";

import { type DocGroup, docHref } from "@/lib/docs";

/**
 * The section list, and on a narrow window a menu that opens without JavaScript.
 *
 * `<details>` rather than a toggle with state: this site has no client components,
 * and a disclosure widget is one of the few interactions the platform already
 * provides. It also stays open when the page it links to loads, which a
 * script-driven menu would have to be told to do.
 *
 * The current page is marked with `aria-current` rather than only with a colour, so
 * "where am I" survives being read out instead of looked at.
 */
export function DocsSidebar({
  nav,
  current,
}: {
  nav: DocGroup[];
  /** Slug of the page being shown. */
  current: string;
}) {
  return (
    <>
      {/* Narrow windows: collapsed by default, because the contents of a page
          matter more than the list of pages when there is room for one of them. */}
      <details className="border-b lg:hidden">
        <summary className="cursor-pointer px-4 py-3 font-medium text-sm">
          Documentation
        </summary>
        <div className="px-4 pb-4">
          <SidebarNav current={current} nav={nav} />
        </div>
      </details>

      {/* Wide windows: always there, and it scrolls independently of the article so
          a long page does not scroll the navigation out of reach. */}
      <aside className="hidden w-60 shrink-0 border-r lg:block">
        <div className="sticky top-16 max-h-[calc(100vh-4rem)] overflow-y-auto px-4 py-8">
          <SidebarNav current={current} nav={nav} />
        </div>
      </aside>
    </>
  );
}

function SidebarNav({ nav, current }: { nav: DocGroup[]; current: string }) {
  return (
    <nav aria-label="Documentation" className="space-y-6">
      {nav.map((group) => (
        <div className="space-y-2" key={group.label ?? "overview"}>
          {group.label ? (
            <h2 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
              {group.label}
            </h2>
          ) : null}

          <ul className="space-y-0.5">
            {group.pages.map((page) => {
              const active = page.slug === current;

              return (
                <li key={page.slug}>
                  <Link
                    aria-current={active ? "page" : undefined}
                    className={`block rounded-md px-2 py-1.5 text-sm transition-colors ${
                      active
                        ? "bg-muted font-medium text-foreground"
                        : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                    }`}
                    href={docHref(page.slug)}
                  >
                    {page.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
