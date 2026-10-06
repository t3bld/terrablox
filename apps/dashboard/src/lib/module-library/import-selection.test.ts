import type { GitRepo } from "@terrablox/git/types";
import { describe, expect, it } from "vitest";

import {
  canContinue,
  filterRepos,
  importedVersionSet,
  isRefSelected,
  pruneImportedRefs,
  type RefChoice,
  toggleRefChoice,
} from "./import-selection";

/**
 * The import dialog's selection rules.
 *
 * The dialog reaches two endpoints that answer at different times — the refs of a
 * repository, and which of its versions are already in the library. Every rule here
 * exists because one of them landed second, and none of them could be reached from a
 * test while they lived inside the component.
 */

let nextId = 1;

function repo(fullName: string): GitRepo {
  return {
    id: nextId++,
    name: fullName.split("/")[1] ?? fullName,
    full_name: fullName,
    private: false,
    html_url: `https://github.com/${fullName}`,
    description: null,
    updated_at: "2026-01-01T00:00:00Z",
    default_branch: "main",
  };
}

describe("importedVersionSet", () => {
  it("is empty when nothing has been imported yet", () => {
    expect(importedVersionSet(undefined).size).toBe(0);
    expect(importedVersionSet([]).size).toBe(0);
  });

  it("trims, because a stray space would offer a duplicate import", () => {
    // These come out of a database column. Untrimmed, ` v1.2.0` looks like a version
    // nobody has imported, and the import then fails on a unique constraint.
    const set = importedVersionSet([" v1.2.0", "v1.3.0 "]);

    expect(set.has("v1.2.0")).toBe(true);
    expect(set.has("v1.3.0")).toBe(true);
  });
});

describe("filterRepos", () => {
  const repos = [
    repo("acme/terraform-aws-vpc"),
    repo("acme/terraform-aws-rds"),
    repo("other/VPC-Tools"),
  ];

  it("returns everything for an empty or blank query", () => {
    expect(filterRepos(repos, "")).toBe(repos);
    expect(filterRepos(repos, "   ")).toBe(repos);
  });

  it("matches anywhere in the full name, ignoring case", () => {
    expect(filterRepos(repos, "vpc").map((r) => r.full_name)).toEqual([
      "acme/terraform-aws-vpc",
      "other/VPC-Tools",
    ]);
  });

  it("matches on the owner too, since that is part of the full name", () => {
    expect(filterRepos(repos, "other/")).toHaveLength(1);
  });

  it("returns nothing rather than everything when nothing matches", () => {
    expect(filterRepos(repos, "nonesuch")).toEqual([]);
  });
});

describe("isRefSelected", () => {
  const choices: RefChoice[] = [
    { type: "tag", name: "v1.0.0" },
    { type: "branch", name: "main" },
  ];

  it("matches on type and name together", () => {
    expect(isRefSelected(choices, "tag", "v1.0.0")).toBe(true);
    expect(isRefSelected(choices, "branch", "main")).toBe(true);
  });

  it("does not confuse a branch with a tag of the same name", () => {
    // A repository can have both, and they are different things to import.
    expect(isRefSelected(choices, "branch", "v1.0.0")).toBe(false);
    expect(isRefSelected(choices, "tag", "main")).toBe(false);
  });

  it("is false against an empty selection", () => {
    expect(isRefSelected([], "tag", "v1.0.0")).toBe(false);
  });
});

describe("toggleRefChoice", () => {
  it("adds a ref that was not selected", () => {
    expect(toggleRefChoice([], "tag", "v1.0.0")).toEqual([
      { type: "tag", name: "v1.0.0" },
    ]);
  });

  it("removes one that was", () => {
    const choices: RefChoice[] = [{ type: "tag", name: "v1.0.0" }];

    expect(toggleRefChoice(choices, "tag", "v1.0.0")).toEqual([]);
  });

  it("appends, because the selection order is the import order", () => {
    const first = toggleRefChoice([], "branch", "main");
    const second = toggleRefChoice(first, "tag", "v2.0.0");

    expect(second.map((c) => c.name)).toEqual(["main", "v2.0.0"]);
  });

  it("keeps a branch and a tag of the same name apart", () => {
    const both = toggleRefChoice(
      toggleRefChoice([], "tag", "release"),
      "branch",
      "release",
    );
    expect(both).toHaveLength(2);

    // Taking the tag out must leave the branch behind.
    expect(toggleRefChoice(both, "tag", "release")).toEqual([
      { type: "branch", name: "release" },
    ]);
  });

  it("does not mutate what it was given", () => {
    const choices: RefChoice[] = [{ type: "tag", name: "v1.0.0" }];
    toggleRefChoice(choices, "branch", "main");

    expect(choices).toHaveLength(1);
  });
});

describe("pruneImportedRefs", () => {
  const choices: RefChoice[] = [
    { type: "tag", name: "v1.0.0" },
    { type: "branch", name: "main" },
  ];

  it("drops a selected ref that turns out to be imported already", () => {
    // The invariant this protects: an imported version's row is not clickable, so a
    // selection containing one could not be undone by the user.
    expect(pruneImportedRefs(choices, new Set(["v1.0.0"]))).toEqual([
      { type: "branch", name: "main" },
    ]);
  });

  it("returns the very same array when it drops nothing", () => {
    // Identity, not equality: this feeds a `setState` updater, and a fresh array with
    // equal contents would re-render the ref list every time the lookup lands.
    expect(pruneImportedRefs(choices, new Set(["v9.9.9"]))).toBe(choices);
    expect(pruneImportedRefs(choices, new Set())).toBe(choices);
  });

  it("can empty the selection entirely", () => {
    expect(pruneImportedRefs(choices, new Set(["v1.0.0", "main"]))).toEqual([]);
  });

  it("prunes by name, so an imported tag also rules out the branch of that name", () => {
    // Honest about a limitation rather than pretending: the imported versions arrive
    // as bare names with no type beside them, so this cannot tell the two apart.
    expect(pruneImportedRefs(choices, new Set(["main"]))).toEqual([
      { type: "tag", name: "v1.0.0" },
    ]);
  });
});

describe("canContinue", () => {
  it("needs a repository on step one", () => {
    expect(canContinue({ step: 1, hasRepo: false, refCount: 0 })).toBe(false);
    expect(canContinue({ step: 1, hasRepo: true, refCount: 0 })).toBe(true);
  });

  it("needs at least one ref on step two", () => {
    expect(canContinue({ step: 2, hasRepo: true, refCount: 0 })).toBe(false);
    expect(canContinue({ step: 2, hasRepo: true, refCount: 1 })).toBe(true);
  });

  it("is always satisfiable on step three", () => {
    // Its own fields are validated by the submit. A disabled Continue here would
    // leave the user with no way to find out why.
    expect(canContinue({ step: 3, hasRepo: false, refCount: 0 })).toBe(true);
  });
});
