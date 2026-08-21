/**
 * Finding the submodules of a repository from its file list.
 *
 * Lifted out of the company settings this used to be configurable through. The
 * folder was a per-organisation setting on a page of its own, which is a lot of
 * machinery for a convention every repository in this ecosystem already follows —
 * and the import wizard lets the folders be corrected by hand anyway.
 *
 * Client-safe: no database, no secrets. The import dialog runs it against a tree
 * it already fetched.
 */

/**
 * Where `terraform-aws-modules`-style repositories keep their submodules.
 *
 * The same value the catalogue sync uses (`SUBMODULE_CONTAINER` in
 * `scripts/seed-builtin-modules/main.mts`), so a repository imported by hand is
 * read the same way as one that ships with TerraBlox.
 */
export const DEFAULT_SUBMODULES_FOLDER = "modules";

/**
 * Normalises a repository-relative folder to the form the Git tree API returns:
 * no leading `./` or `/`, no trailing slash, no empty segments. Returns null for
 * anything that does not address a real subfolder, including `.` — a convention
 * pointing at the repository root would match every folder.
 */
export function normalizeSubmodulesPath(input: unknown): string | null {
  if (typeof input !== "string") {
    return null;
  }

  const normalized = input
    .trim()
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");

  return normalized === "" ? null : normalized;
}

/**
 * Picks the direct children of `parentPath` that look like Terraform modules,
 * i.e. folders holding at least one `.tf` file of their own. Nested folders are
 * ignored so `modules/vpc/examples` does not get imported as a submodule.
 */
export function findSubmoduleFolders(
  treePaths: readonly string[],
  parentPath: string | null = DEFAULT_SUBMODULES_FOLDER,
): string[] {
  const parent = normalizeSubmodulesPath(parentPath);
  if (!parent) {
    return [];
  }

  const prefix = `${parent}/`;
  const folders = new Set<string>();

  for (const path of treePaths) {
    if (!path.startsWith(prefix) || !path.toLowerCase().endsWith(".tf")) {
      continue;
    }

    const segments = path.slice(prefix.length).split("/");
    // A submodule's own file sits at `<parent>/<name>/<file>.tf`.
    if (segments.length !== 2) {
      continue;
    }

    const name = segments[0];
    if (name) {
      folders.add(`${prefix}${name}`);
    }
  }

  return [...folders].sort((left, right) => left.localeCompare(right));
}
