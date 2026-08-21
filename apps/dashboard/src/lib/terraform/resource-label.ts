/**
 * Which Terraform block labels are worth showing, and where a block lives.
 *
 * No `server-only`: this is naming and URL arithmetic with no secrets and no
 * database access, and the graph views run in the browser.
 */

/**
 * Block labels that say nothing about the block.
 *
 * `resource "aws_iam_role" "this"` is the community convention for "the one role
 * this module is about" — a module wrapping a single resource has nothing to
 * distinguish it from, so a descriptive label would only repeat the type.
 * `data "aws_region" "current"` is the same idea for the ambient context of a
 * run. Both are correct Terraform and both are noise to a reader browsing a
 * catalogue, which is where these labels were being shown.
 *
 * `main` and `default` are included for the same reason, and `default` doubly so:
 * it is what people write when they have not decided on a name.
 */
export const CONVENTIONAL_LABELS = new Set([
  "this",
  "current",
  "default",
  "main",
]);

/**
 * Whether a label was written to satisfy HCL rather than to name anything.
 *
 * Separate from {@link meaningfulResourceName} because the two questions have
 * different answers. Dropping such a label is right where one block stands
 * alone, and wrong where several blocks of a type are listed together: there
 * the labels are the only thing telling them apart, and a list shorter than the
 * count beside it reads as a page that lost something. Callers that fold blocks
 * by type need to ask "is this a convention?" without being handed a decision
 * to hide it.
 */
export function isConventionalResourceName(
  name: string | null | undefined,
): boolean {
  const trimmed = name?.trim();

  return trimmed ? CONVENTIONAL_LABELS.has(trimmed.toLowerCase()) : false;
}

/**
 * The block label, or undefined when it carries no information.
 *
 * Kept as a function rather than a filter at the call site so the list of
 * conventions lives in one place: the architecture graph, the resources tab and
 * the detail panel all ask the same question and must not disagree about it.
 */
export function meaningfulResourceName(
  name: string | null | undefined,
): string | undefined {
  const trimmed = name?.trim();
  if (!trimmed) return undefined;

  return isConventionalResourceName(trimmed) ? undefined : trimmed;
}

/**
 * A `https://github.com/owner/repo` base derived from a stored clone URL.
 *
 * Deliberately not built on `parseModuleSourceRef`: that one lowercases the
 * repository name and throws the owner away, because it exists to *match* two
 * descriptions of the same module. A URL has to survive being clicked, so it
 * needs the owner and the original case.
 *
 * Returns null for anything that is not a GitHub URL. GitLab and Bitbucket use
 * different blob paths, and a link built on a guess is worse than none.
 */
export function githubRepoBase(
  cloneUrl: string | null | undefined,
): string | null {
  const trimmed = cloneUrl?.trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    // `?ref=` rides along on some stored URLs; it is not part of the path.
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.hostname.toLowerCase() !== "github.com") return null;

  const segments = url.pathname.split("/").filter(Boolean);
  const owner = segments[0];
  const repo = segments[1]?.replace(/\.git$/i, "");
  if (!owner || !repo) return null;

  return `https://github.com/${owner}/${repo}`;
}

/**
 * Where a file of an imported module can be read on GitHub.
 *
 * `ref` is the imported version tag — a branch or a tag, which is what GitHub's
 * `blob/<ref>` accepts — and `rootFolder` is the folder the module was analysed
 * in, because `sourceFile` is recorded relative to that folder rather than to the
 * repository.
 *
 * Points at the file, not at the block. Storing a line number would mean the
 * analyser recording one, which it does not, and a link that claims to jump to a
 * resource and lands at the top of a 400-line file is worse than one that
 * promises only the file.
 */
export function githubFileUrl(params: {
  cloneUrl: string | null | undefined;
  ref: string | null | undefined;
  rootFolder: string | null | undefined;
  file: string | null | undefined;
}): string | null {
  const base = githubRepoBase(params.cloneUrl);
  const file = params.file?.trim();
  const ref = params.ref?.trim();
  if (!base || !file || !ref) return null;

  const folder = params.rootFolder
    ?.trim()
    .replace(/^\.?\/*/, "")
    .replace(/\/+$/, "");
  const path = folder && folder !== "." ? `${folder}/${file}` : file;

  return `${base}/blob/${encodeURIComponent(ref)}/${path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

/**
 * Block labels of one resource type, in the order a reader should meet them.
 *
 * The conventional label comes first because that is what it means: `this` is
 * the main resource of its type, and the descriptively named blocks beside it
 * are the exceptions. Alphabetical within each half, so a long list stays
 * scannable.
 */
export function sortResourceNames(names: readonly string[]): string[] {
  return [...names].sort(
    (a, b) =>
      Number(isConventionalResourceName(b)) -
        Number(isConventionalResourceName(a)) ||
      a.localeCompare(b, "en", { numeric: true }),
  );
}
