import { Badge } from "@terrablox/ui/badge";
import {
  ArrowLeft,
  ArrowRightLeft,
  Box,
  Boxes,
  ExternalLink,
  GitBranch,
  LayoutGrid,
  Wallet,
} from "lucide-react";
import Link from "next/link";

import { asset } from "@/lib/assets";
import {
  type CatalogueEntry,
  repoHomeUrl,
  repoName,
  repoUrl,
} from "@/lib/catalogue";

/**
 * The header and tab strip every module tab shares.
 *
 * Shaped after the dashboard's module detail so the two read as one product: a card
 * carrying the description and the module's facts, then a tab strip under it. Two
 * differences are structural rather than cosmetic.
 *
 * The tabs here are links between routes, not state in a component. A static export has
 * nowhere to keep a selection, and routes buy something the dashboard's tabs cannot — a
 * tab is a URL, so it can be shared, bookmarked and linked to from the documentation.
 * That is also why this is not `TabsNav` from `@terrablox/ui` despite looking exactly
 * like it: that component is a real `role="tablist"` driven by `onChange`, and marking a
 * set of links as a tablist would promise arrow-key behaviour that navigation does not
 * have. The styling is matched line for line instead.
 *
 * And the name is a heading here. The dashboard leaves it out of the card because its
 * page header already shows it in the breadcrumbs; this page has a back link where that
 * header would be, so the card would otherwise sit under an unnamed page.
 *
 * Four tabs, in the order the questions get asked: what does it deploy, what do I have to
 * configure, what is in it, what will it cost. The dashboard has two more — a readme and
 * a dependency list — and both need data this snapshot does not carry, so they are absent
 * rather than stubbed.
 */

const TABS = [
  { icon: LayoutGrid, id: "architecture", label: "Architecture", path: "" },
  {
    icon: ArrowRightLeft,
    id: "variables",
    label: "Variables",
    path: "/variables",
  },
  { icon: Boxes, id: "resources", label: "Resources", path: "/resources" },
  { icon: Wallet, id: "costs", label: "Costs", path: "/costs" },
] as const;

export type ModuleTabId = (typeof TABS)[number]["id"];

/** One fact about the module, labelled. Mirrors the dashboard's own `InfoField`. */
function InfoField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="font-medium text-muted-foreground text-xs">{label}</div>
      <div className="text-sm">{children}</div>
    </div>
  );
}

export function ModuleDetail({
  entry,
  tab,
  children,
}: {
  entry: CatalogueEntry;
  tab: ModuleTabId;
  children: React.ReactNode;
}) {
  // Counts sit on the tabs, the way the dashboard puts them there, so the card is
  // facts about the module and the strip says how much is behind each label. They
  // include what the snapshot left out: a tab reading 40 over a module with 236
  // inputs would understate the module rather than the page.
  const totalVariables =
    entry.inputs.length +
    entry.omitted.inputs +
    entry.outputs.length +
    entry.omitted.outputs;

  return (
    <article className="max-w-5xl">
      {/* Into the landing page's library section rather than to a list page, which no
          longer exists: the catalogue is a section there, and the fragment lands the
          reader on the grid they came from rather than at the top of the page. */}
      <Link
        className="mb-6 inline-flex items-center gap-1.5 text-muted-foreground text-sm transition-colors hover:text-foreground"
        href="/#library"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Module library
      </Link>

      <h1 className="font-semibold text-2xl tracking-tight">{entry.name}</h1>

      <section className="mt-4 rounded-lg border bg-card p-4">
        {/* The icon belongs to the repository, and this is the first block on the page
            that is about the repository — so it sits with the description rather than
            beside the heading. */}
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg">
            {entry.icon ? (
              // biome-ignore lint/performance/noImgElement: a committed asset at a fixed size on a static host; there is no optimiser behind GitHub Pages.
              <img
                alt=""
                className="h-full w-full object-contain"
                src={asset(`/module-icons/${entry.icon}`)}
              />
            ) : (
              <span className="flex h-full w-full items-center justify-center rounded-lg border bg-muted/40">
                <Box className="h-5 w-5 text-muted-foreground" />
              </span>
            )}
          </span>

          <p className="min-w-0 flex-1 break-words text-sm leading-6">
            {entry.description?.trim()
              ? entry.description
              : "No description provided."}
          </p>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {/* The tag, not a branch. Every module in the catalogue is pinned, which is
              the claim the landing page makes about the library — so the fact is on
              the page rather than only in the prose. */}
          <InfoField label="Version">
            <a
              className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline"
              href={repoUrl(entry)}
              rel="noreferrer noopener"
              target="_blank"
            >
              <GitBranch className="h-3.5 w-3.5 shrink-0" />
              {entry.version}
            </a>
          </InfoField>

          <InfoField label="Repository">
            <a
              className="inline-flex max-w-full items-center gap-1 font-medium text-primary underline-offset-4 hover:underline"
              href={repoHomeUrl(entry)}
              rel="noreferrer noopener"
              target="_blank"
            >
              <ExternalLink className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{repoName(entry)}</span>
            </a>
          </InfoField>

          {/* Dropped entirely when there are none, the way the dashboard drops its tags
              field: a row reading "No submodules" spends a column saying nothing. */}
          {entry.submodules.length > 0 ? (
            <InfoField label="Submodules">
              <div className="flex flex-wrap gap-1.5">
                {entry.submodules.map((name) => (
                  <Badge key={name} variant="outline">
                    {name}
                  </Badge>
                ))}
              </div>
            </InfoField>
          ) : null}
        </div>
      </section>

      {/* A real tablist would own focus and arrow keys; this is navigation, so it is
          marked up as navigation.

          Scrolls rather than wraps: four labels with icons do not fit a 320px screen,
          and a wrapped second row of tabs under a border reads as a broken rule. */}
      <nav
        aria-label="Module sections"
        className="scrollbar-none mt-4 flex items-stretch gap-1 overflow-x-auto border-b"
      >
        {TABS.map((entryTab) => {
          const active = entryTab.id === tab;
          const Icon = entryTab.icon;
          const count =
            entryTab.id === "variables"
              ? totalVariables
              : entryTab.id === "resources"
                ? entry.resources.length
                : 0;

          return (
            <Link
              aria-current={active ? "page" : undefined}
              className={`-mb-px flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors ${
                active
                  ? "border-foreground font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
              href={`/modules/${entry.slug}${entryTab.path}`}
              key={entryTab.id}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {entryTab.label}
              {count > 0 ? (
                <span className="rounded bg-muted px-1.5 py-0.5 font-medium text-[11px] text-muted-foreground">
                  {count}
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>

      <div className="pt-6">{children}</div>
    </article>
  );
}
