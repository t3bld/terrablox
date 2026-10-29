/**
 * What the shipped catalogue *is*: which repositories, and what to call them.
 *
 * Extracted from `main.mts` when a second script needed the same answers — the
 * website's catalogue snapshot, which reads the same repositories and must show the
 * same names. `SERVICE_NAMES` in two places would be fifty entries that drift, and
 * the drift would show up as the library and the marketing page disagreeing about
 * what a module is called.
 *
 * No database and no Prisma import: this is the GitHub half, and the snapshot
 * generator has no database at all.
 */

import { pickLatest } from "@terrablox/terraform/versions";
import {
  DEFAULT_TERRABLOX_LIBRARY,
  findModuleLibrary,
  TERRABLOX_LIBRARY_ID,
} from "@/lib/module-library/libraries";
import {
  serviceSlug as catalogueServiceSlug,
  SERVICE_NAMES,
  terrabloxDisplayName,
} from "@/lib/module-library/terrablox-catalogue";

export { SERVICE_NAMES };

/**
 * Which repositories make up the catalogue: the `terrablox` entry of
 * TERRABLOX_MODULE_LIBRARIES, so the sync, the website snapshot and the
 * dashboard can never disagree. The default entry stands in where the list has
 * none — the website build has no reason to configure the dashboard.
 */
const library = findModuleLibrary(TERRABLOX_LIBRARY_ID);
export const ORG = library?.org ?? DEFAULT_TERRABLOX_LIBRARY.org;
export const PREFIX = library?.prefix ?? DEFAULT_TERRABLOX_LIBRARY.prefix;

/**
 * Where submodules live in these repositories.
 *
 * `terraform-aws-modules` repos put each submodule in its own folder under
 * `modules/`, and the pipeline treats a folder with no `.tf` of its own as a
 * container and imports each child. One value covers the whole catalogue.
 */
export const SUBMODULE_CONTAINER = "modules";

/**
 * The only tag on a shipped source, so the modules page can filter to the
 * catalogue in one click.
 *
 * One tag rather than several. `aws` said nothing when every module in the
 * catalogue is AWS, `built-in` duplicated a fact the row already carries in its
 * null owner, and a per-service tag repeated the name right next to the name.
 * Three tags on every card is three things to read past.
 */
export const CATALOGUE_TAGS = ["terrablox"];

export interface GithubRepo {
  name: string;
  full_name: string;
  description: string | null;
  archived: boolean;
  default_branch: string;
}

interface GithubTag {
  name: string;
}

export type CatalogueRefType = "branch" | "tag";

export interface CatalogueRef {
  refName: string;
  refType: CatalogueRefType;
}

export function resolveToken(command: string): string {
  const token =
    process.env.TERRABLOX_SEED_GITHUB_TOKEN ??
    process.env.GITHUB_TOKEN ??
    process.env.GH_TOKEN ??
    null;

  if (!token) {
    console.error(
      [
        "No GitHub token found.",
        "",
        "The catalogue reads ~50 public repos from GitHub. Public repos don't need",
        "any scopes, but without a token the rate limit (60 req/h) is too low.",
        "",
        `  GITHUB_TOKEN=$(gh auth token) ${command}`,
      ].join("\n"),
    );
    process.exit(1);
  }

  return token;
}

export async function github<T>(token: string, url: string): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const response = await fetch(url, { headers });

  if (!response.ok) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    const hint =
      remaining === "0"
        ? " (GitHub rate limit exhausted — wait for the window to reset)"
        : "";
    throw new Error(
      `GitHub ${response.status} ${response.statusText} for ${url}${hint}`,
    );
  }

  return (await response.json()) as T;
}

/** Every catalogue repository, following pagination. */
export async function listCatalogueRepos(token: string): Promise<GithubRepo[]> {
  const found: GithubRepo[] = [];

  for (let page = 1; page <= 10; page++) {
    const batch = await github<GithubRepo[]>(
      token,
      `https://api.github.com/orgs/${ORG}/repos?per_page=100&type=public&page=${page}`,
    );

    found.push(...batch);
    if (batch.length < 100) break;
  }

  return (
    found
      .filter((repo) => repo.name.startsWith(PREFIX))
      // An archived fork is no longer being kept in step with upstream, so
      // shipping it would hand every user a module that quietly went stale.
      .filter((repo) => !repo.archived)
      .sort((a, b) => a.name.localeCompare(b.name))
  );
}

/**
 * The refs to import for a repository: its default branch, and its newest tag.
 *
 * The branch is taken from the repository itself rather than assumed — these
 * forks default to `master`, not `main`, and hardcoding either would silently
 * skip every repository that disagreed.
 *
 * Both refs are worth having because they answer different questions. The branch
 * is what upstream currently says, so a user who wants fixes as they land follows
 * it. A tag never moves, so a user who wants a project to keep planning the same
 * way next month pins to it.
 *
 * A freshly forked repository with no tags yet still yields the branch rather
 * than being skipped.
 */
export async function listRefs(
  token: string,
  repo: GithubRepo,
): Promise<CatalogueRef[]> {
  const refs: CatalogueRef[] = [
    { refName: repo.default_branch, refType: "branch" },
  ];

  const tags = await github<GithubTag[]>(
    token,
    `https://api.github.com/repos/${repo.full_name}/tags?per_page=100`,
  );

  const latest = pickLatest(tags.map((tag) => ({ versionTag: tag.name })));

  // Guarded in case a repository tags its default branch under the same name,
  // which would otherwise import the same ref twice.
  if (latest?.versionTag && latest.versionTag !== repo.default_branch) {
    refs.push({ refName: latest.versionTag, refType: "tag" });
  }

  return refs;
}

/** `terrablox-aws-rds-aurora` -> `rds-aurora`. */
export function serviceSlug(repoName: string): string {
  return catalogueServiceSlug(repoName, PREFIX);
}

/** The name shown in the library; see `terrabloxDisplayName`. */
export function displayName(repoName: string): string {
  return terrabloxDisplayName(repoName, PREFIX);
}
