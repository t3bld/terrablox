/**
 * The shipped module catalogue, and the questions worth asking of it.
 *
 * A package rather than a file inside one app because it now has two readers that
 * cannot see each other: the marketing site, which renders it as pages, and the MCP
 * server, which hands it to an agent running in somebody else's editor. A package may
 * not import from an app — the monorepo enforces that in `tsconfig` and in the Vitest
 * projects — so shared data has to live at this level or be duplicated, and duplicated
 * module interfaces would be the one kind of drift nobody notices until an agent wires
 * an output that no longer exists.
 *
 * What is here is the snapshot and the lookups over it. What is deliberately *not* here
 * is presentation: the site's bucket colours and its diagram-node translation stay in
 * the site, because a Tailwind class in a data package is how a data package stops being
 * one. The cost *classification* is likewise absent, and that is not an oversight — it
 * comes from a table in `@terrablox/terraform` that both readers consult at the moment
 * they need it, so a change to what AWS bills for reaches them without regenerating
 * anything.
 */

export type {
  CatalogueArchitecture,
  CatalogueEntry,
  CatalogueOutput,
  CataloguePort,
} from "./entries.generated";

import {
  CATALOGUE_ENTRIES,
  type CatalogueEntry,
  type CataloguePort,
} from "./entries.generated";

export { CATALOGUE_ENTRIES } from "./entries.generated";

export function findCatalogueEntry(slug: string): CatalogueEntry | null {
  return CATALOGUE_ENTRIES.find((entry) => entry.slug === slug) ?? null;
}

export function catalogueSlugs(): string[] {
  return CATALOGUE_ENTRIES.map((entry) => entry.slug);
}

/**
 * A module's inputs, required ones first.
 *
 * Required first because that is the reading order of the decision: those are the
 * arguments a caller cannot avoid supplying, and their number is a fair proxy for how
 * much work adopting the module is. Alphabetical within each half, since there is no
 * meaningful order among forty optional knobs.
 */
export function sortedInputs(entry: CatalogueEntry): CataloguePort[] {
  return [...entry.inputs].sort(
    (a, b) =>
      Number(b.required) - Number(a.required) || a.name.localeCompare(b.name),
  );
}

/** Where a module's source lives at the pinned tag, for the link out. */
export function repoUrl(entry: CatalogueEntry): string {
  return `https://github.com/${entry.repo}/tree/${entry.version}`;
}

/**
 * The repository itself, unpinned.
 *
 * Separate from {@link repoUrl} because the two answer different questions: a reader
 * following a variable back to its declaration wants the tag this page describes,
 * while one asking "who publishes this" wants the repository's front page. Both are
 * built here so the host and the owner/name split live in one place.
 */
export function repoHomeUrl(entry: CatalogueEntry): string {
  return `https://github.com/${entry.repo}`;
}

/**
 * The repository's own name, without the owner.
 *
 * Shown instead of the module's display name on the link to the source, for the
 * reason the dashboard's detail header gives: a link labelled "Certificate Manager"
 * pointing at `terrablox-aws-acm` hides the one fact that row exists to give.
 */
export function repoName(entry: CatalogueEntry): string {
  return entry.repo.split("/").at(-1) ?? entry.repo;
}

/**
 * The module a name most likely meant, or null when nothing is close.
 *
 * Agents name modules from memory and get them nearly right — `rds_aurora` for
 * `rds-aurora`, `vpc-module` for `vpc`. Matching the slug exactly and refusing
 * everything else spends a turn per typo, so a near miss is resolved and an outright
 * miss is still refused: the display name is checked too, because "Certificate
 * Manager" is what a human would say and `acm` is what the catalogue calls it.
 */
export function resolveCatalogueEntry(wanted: string): CatalogueEntry | null {
  const needle = wanted.trim().toLowerCase();
  if (!needle) return null;

  const exact = CATALOGUE_ENTRIES.find(
    (entry) =>
      entry.slug.toLowerCase() === needle ||
      entry.name.toLowerCase() === needle,
  );
  if (exact) return exact;

  // Separators are the most common near miss and carry no meaning of their own, so
  // they are compared away rather than scored.
  const flat = needle.replace(/[-_\s]/g, "");
  return (
    CATALOGUE_ENTRIES.find(
      (entry) =>
        entry.slug.replace(/[-_\s]/g, "") === flat ||
        entry.name.toLowerCase().replace(/[-_\s]/g, "") === flat,
    ) ?? null
  );
}
