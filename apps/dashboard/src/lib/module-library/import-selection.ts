/**
 * What the import dialog lets you pick, and what it refuses.
 *
 * Small on purpose: this is the part of a three-step wizard that has rules in it, and
 * everything else in that component is `fetch` and JSX. The rules are worth being able
 * to check on their own because the dialog reaches two endpoints that answer at
 * different times — the refs of a repository, and which of its versions are already in
 * the library — and every rule here exists because one of them landed second.
 *
 * The invariant that matters: **already imported means not selectable.** A row for an
 * imported version is not clickable, so a selection containing one cannot be undone by
 * the user. That has to be enforced where selections are made rather than where rows are
 * drawn, or the dialog gets into a state with no way out of it.
 */

import type { GitRepo } from "@terrablox/git/types";

/** A branch or a tag to import. Several can go in one run, in the order picked. */
export interface RefChoice {
  type: "branch" | "tag";
  name: string;
}

/** The dialog's three steps: pick a repository, pick refs, fill in the metadata. */
export type ImportStep = 1 | 2 | 3;

/**
 * The versions of a repository already in the library, as a set that can be asked.
 *
 * Trimmed, because these come back from a database column and a stray space would make
 * `v1.2.0` look like a version nobody has imported — which would offer a duplicate
 * import that then fails on a unique constraint.
 */
export function importedVersionSet(
  versions: readonly string[] | undefined,
): Set<string> {
  return new Set((versions ?? []).map((v) => v.trim()));
}

/** Repositories matching what was typed, by full name. Empty query means all. */
export function filterRepos(
  repos: readonly GitRepo[],
  query: string,
): readonly GitRepo[] {
  const q = query.trim().toLowerCase();
  if (!q) return repos;
  return repos.filter((repo) => repo.full_name.toLowerCase().includes(q));
}

/** Compares by type and name because the choices are recreated per render. */
export function isRefSelected(
  choices: readonly RefChoice[],
  type: RefChoice["type"],
  name: string,
): boolean {
  return choices.some((choice) => choice.type === type && choice.name === name);
}

/**
 * Adds a ref to the selection, or takes it out again.
 *
 * Appends rather than inserting in list order: the order of the selection is the order
 * the refs were picked, which is also the order they are imported in.
 */
export function toggleRefChoice(
  choices: readonly RefChoice[],
  type: RefChoice["type"],
  name: string,
): RefChoice[] {
  return isRefSelected(choices, type, name)
    ? choices.filter(
        (choice) => !(choice.type === type && choice.name === name),
      )
    : [...choices, { type, name }];
}

/**
 * Drops any selected ref that turns out to be imported already.
 *
 * The defaults are picked when the refs load, but which versions already exist arrives
 * from a separate lookup that can land afterwards. Without this, a pre-selected ref
 * could turn out to be imported already — and its row is then not clickable, so the
 * user could not take it out of a selection they never made.
 *
 * Returns the *same array* when nothing was dropped. That is not a micro-optimisation:
 * this feeds a `setState` updater, and a fresh array with equal contents would re-render
 * the ref list on every arrival of the lookup.
 */
export function pruneImportedRefs(
  choices: RefChoice[],
  imported: ReadonlySet<string>,
): RefChoice[] {
  if (imported.size === 0) return choices;

  const kept = choices.filter((choice) => !imported.has(choice.name));
  return kept.length === choices.length ? choices : kept;
}

/**
 * Whether the wizard may move on from this step.
 *
 * Step three is always satisfiable: its own fields are validated by the submit, and a
 * disabled Continue there would leave the user with no way to find out why.
 */
export function canContinue(input: {
  step: ImportStep;
  hasRepo: boolean;
  refCount: number;
}): boolean {
  const { step, hasRepo, refCount } = input;

  return (step === 1 && hasRepo) || (step === 2 && refCount > 0) || step === 3;
}
