/**
 * Organisation-wide defaults shared by the settings page, its API route and the
 * import wizard. Kept free of server-only imports so the client can reuse the
 * normalisation instead of re-implementing it.
 */
export interface CompanySettingsDto {
  name: string;
  terraformSubmodulesPath: string | null;
  terraformRootFolder: string | null;
}

export const emptyCompanySettings: CompanySettingsDto = {
  name: "",
  terraformSubmodulesPath: null,
  terraformRootFolder: null,
};

/**
 * Normalises a repository-relative folder to the form the Git tree API returns:
 * no leading `./` or `/`, no trailing slash, no empty segments. Returns null for
 * anything that does not address a real subfolder, including `.` — a company
 * convention pointing at the repository root would match every folder.
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

/** Like `normalizeSubmodulesPath`, but `.` is a meaningful root folder value. */
export function normalizeRootFolder(input: unknown): string | null {
  if (typeof input !== "string") {
    return null;
  }

  const trimmed = input.trim();
  if (trimmed === "") {
    return null;
  }

  return normalizeSubmodulesPath(trimmed) ?? ".";
}

/**
 * Picks the direct children of `parentPath` that look like Terraform modules,
 * i.e. folders holding at least one `.tf` file of their own. Nested folders are
 * ignored so `modules/vpc/examples` does not get imported as a submodule.
 */
export function findSubmoduleFolders(
  treePaths: readonly string[],
  parentPath: string | null,
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
