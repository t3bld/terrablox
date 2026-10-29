import "server-only";

import { GithubRequestError, githubRequest } from "@terrablox/git/client";
import {
  getBranchHeadSha,
  getRepositoryTopics,
  listVisibleOrganizationLogins,
} from "@terrablox/git/discovery";
import { githubProvider } from "@terrablox/git/github-provider";
import {
  listInstallationRepos,
  listUserInstallations,
} from "@terrablox/git/installations";
import type { GitRepo } from "@terrablox/git/types";
import { pickLatest } from "@terrablox/terraform/versions";
import { database } from "@/lib/database";
import {
  canonicalRepoUrl,
  type ImportModuleFromGitResult,
  importModuleFromGit,
} from "@/lib/module-library/import-from-git";
import {
  type ModuleLibraryDefinition,
  matchesLibrary,
  TERRABLOX_LIBRARY_ID,
} from "@/lib/module-library/libraries";
import { terrabloxDisplayName } from "@/lib/module-library/terrablox-catalogue";

/**
 * The one sync pipeline every module library runs through.
 *
 * Two halves, each independent of who triggers it (CLI, web request, later a
 * worker or a schedule):
 *
 * 1. **Discovery** — which repositories belong to the library right now. Global
 *    libraries list the organisation; per-user libraries list what the user's
 *    app installation grants, so the answer is "what *this* person may read".
 * 2. **Import** — per repository, the default branch plus the newest tag, through
 *    the same `importModuleFromGit` a hand import uses. Sequential on purpose:
 *    each repository is already a burst of parallel reads, and running
 *    repositories in parallel too trips GitHub's secondary rate limit.
 *
 * Plus pruning, which only ever runs on an authoritative discovery.
 */

const PER_PAGE = 100;
const MAX_PAGES = 10;

export type LibraryDiscovery =
  | {
      kind: "not-installed";
      /** GitHub admits the user belongs to the org (public membership). */
      memberDetected: boolean;
    }
  | {
      kind: "repos";
      /** The app installation that granted them; null for a global listing. */
      installationId: string | null;
      /** Repositories that belong, sorted by name. */
      matched: GitRepo[];
      /** Kept even though not imported: their topics could not be read. */
      uncertainUrls: string[];
    };

export interface RepoProgress {
  branch: string;
  branchSha: string | null;
  tag: string | null;
}

/** Topics only when the library filters on them, and only when absent. */
async function filterByLibrary(
  token: string | null,
  repos: GitRepo[],
  def: ModuleLibraryDefinition,
  log: LibraryLog,
): Promise<{ matched: GitRepo[]; uncertainUrls: string[] }> {
  const matched: GitRepo[] = [];
  const uncertainUrls: string[] = [];

  for (const repo of repos) {
    // Owner, archived, public and prefix first: cheap, and narrows the set
    // that might need a topics request.
    if (!matchesLibrary(repo, { ...def, topics: [] })) continue;

    let topics = repo.topics;
    if (def.topics.length > 0 && !Array.isArray(topics)) {
      if (!token) continue;
      try {
        topics = await getRepositoryTopics(token, repo.full_name);
      } catch (error) {
        log.warn("topics", error, repo.full_name);
        uncertainUrls.push(canonicalRepoUrl(repo.full_name));
        continue;
      }
    }

    if (matchesLibrary(repo, def, topics)) matched.push(repo);
  }

  matched.sort((a, b) => a.name.localeCompare(b.name));
  return { matched, uncertainUrls };
}

/** Every repository of an org (or, failing that, a user account). */
async function listOwnerRepos(
  token: string | null,
  def: ModuleLibraryDefinition,
): Promise<GitRepo[]> {
  const type = def.publicOnly ? "public" : "all";
  const owner = encodeURIComponent(def.org);

  const page = async (base: string) => {
    const repos: GitRepo[] = [];
    for (let index = 1; index <= MAX_PAGES; index++) {
      const res = await githubRequest(
        token,
        `${base}?per_page=${PER_PAGE}&type=${type}&page=${index}`,
      );
      const batch = (await res.json()) as GitRepo[];
      repos.push(...batch);
      if (batch.length < PER_PAGE) break;
    }
    return repos;
  };

  try {
    return await page(`/orgs/${owner}/repos`);
  } catch (error) {
    // A user account, not an organisation.
    if (error instanceof GithubRequestError && error.status === 404) {
      return page(`/users/${owner}/repos`);
    }
    throw error;
  }
}

/**
 * Which repositories belong to a library right now. Throws on a GitHub failure;
 * a thrown discovery is never authoritative and must not prune.
 */
export async function discoverLibrary(params: {
  token: string | null;
  library: ModuleLibraryDefinition;
  log?: LibraryLog;
}): Promise<LibraryDiscovery> {
  const { token, library: def } = params;
  const log = params.log ?? consoleLog(def.id);

  if (def.scope === "global") {
    const repos = await listOwnerRepos(token, def);
    return {
      kind: "repos",
      installationId: null,
      ...(await filterByLibrary(token, repos, def, log)),
    };
  }

  if (!token) throw new Error("A per-user library needs the user's token");

  const installations = await listUserInstallations(token);
  const installation = installations.find(
    (candidate) =>
      candidate.account.login.toLowerCase() === def.org.toLowerCase(),
  );

  if (!installation) {
    const orgs = await listVisibleOrganizationLogins(token);
    return {
      kind: "not-installed",
      memberDetected: orgs.some(
        (login) => login.toLowerCase() === def.org.toLowerCase(),
      ),
    };
  }

  const repos = await listInstallationRepos(token, installation.id);
  return {
    kind: "repos",
    installationId: String(installation.id),
    ...(await filterByLibrary(token, repos, def, log)),
  };
}

/**
 * Deletes a library's sources that discovery no longer returned. Cascades to
 * the module rows — and from there to canvas nodes, exactly as deleting an
 * import by hand does. Pass every URL to keep, including uncertain ones.
 */
export async function pruneLibrary(params: {
  library: ModuleLibraryDefinition;
  userId: string | null;
  keepUrls: string[];
  assertCurrent?: () => Promise<void>;
}): Promise<number> {
  await params.assertCurrent?.();
  const removed = await database.terraformModuleSource.deleteMany({
    where: {
      userId: params.userId,
      library: params.library.id,
      url: { notIn: params.keepUrls },
    },
  });
  return removed.count;
}

/** What a library calls a repository in the module list. */
export function libraryDisplayName(
  def: ModuleLibraryDefinition,
  repo: Pick<GitRepo, "name">,
): string {
  return def.id === TERRABLOX_LIBRARY_ID
    ? terrabloxDisplayName(repo.name, def.prefix ?? "")
    : repo.name;
}

export interface LibraryLog {
  warn(step: string, error: unknown, repo?: string): void;
}

/** Library, step, status. Never a token, never a response body. */
export function consoleLog(library: string): LibraryLog {
  return {
    warn(step, error, repo) {
      console.warn("[module-library] sync step failed", {
        library,
        step,
        ...(repo ? { repo } : {}),
        status: error instanceof GithubRequestError ? error.status : null,
        error: error instanceof Error ? error.name : typeof error,
      });
    },
  };
}

export interface RefEvent {
  repo: GitRepo;
  index: number;
  total: number;
  refName: string;
  refType: "branch" | "tag";
  result?: ImportModuleFromGitResult;
  error?: unknown;
}

export interface ImportRunResult {
  /** Refs imported or refreshed. */
  imported: number;
  failures: Array<{ repo: string; ref: string; message: string }>;
  /** The time budget ran out before every repository was visited. */
  more: boolean;
  progress: Record<string, RepoProgress>;
}

/**
 * Imports the discovered repositories of a library for one owner.
 *
 * `mode`:
 * - `changed` — only refs that are new, or a branch whose head moved since the
 *   recorded `progress`. Without recorded progress (a global CLI run) the branch
 *   is always refreshed and only known tags are skipped. What a frequent
 *   per-user refresh wants.
 * - `all` — re-import every ref, refreshing the analysis even when nothing
 *   upstream moved. What an operator re-sync after an analyzer upgrade wants.
 */
export async function importLibraryRepos(params: {
  library: ModuleLibraryDefinition;
  userId: string | null;
  token: string | null;
  repos: GitRepo[];
  progress?: Record<string, RepoProgress>;
  mode: "changed" | "all";
  budgetMs?: number;
  log?: LibraryLog;
  onRef?: (event: RefEvent) => void;
  onRepoDone?: (progress: Record<string, RepoProgress>) => Promise<void>;
  /** Fence checked before every database mutation in a per-user sync. */
  assertCurrent?: () => Promise<void>;
}): Promise<ImportRunResult> {
  const { library: def, userId, token, repos, mode } = params;
  const log = params.log ?? consoleLog(def.id);
  const startedAt = Date.now();
  const progress = { ...(params.progress ?? {}) };
  const failures: ImportRunResult["failures"] = [];
  let imported = 0;
  let more = false;

  const roots =
    mode === "changed"
      ? await database.terraformModule.findMany({
          where: { userId, library: def.id, isSubmodule: false },
          select: { versionTag: true, source: { select: { url: true } } },
        })
      : [];
  const have = new Set(
    roots.map((row) => `${row.source?.url ?? ""}@${row.versionTag ?? ""}`),
  );

  for (const [index, repo] of repos.entries()) {
    if (
      params.budgetMs !== undefined &&
      Date.now() - startedAt > params.budgetMs
    ) {
      more = true;
      break;
    }

    await params.assertCurrent?.();

    const url = canonicalRepoUrl(repo.full_name);
    const branch = repo.default_branch || "main";
    const previous = progress[repo.full_name];

    let tag: string | null;
    let branchSha: string | null = null;

    try {
      const [tags, sha] = await Promise.all([
        githubProvider.getTags(token ?? "", repo.full_name),
        mode === "changed" && token
          ? getBranchHeadSha(token, repo.full_name, branch)
          : Promise.resolve(null),
      ]);
      branchSha = sha;
      const latest = pickLatest(tags.map((t) => ({ versionTag: t.name })));
      // Guarded in case a repository tags its default branch under the same
      // name, which would otherwise import the same ref twice.
      tag =
        latest?.versionTag && latest.versionTag !== branch
          ? latest.versionTag
          : null;
    } catch (error) {
      log.warn("refs", error, repo.full_name);
      failures.push({
        repo: repo.full_name,
        ref: "(refs)",
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const refs: Array<{ refName: string; refType: "branch" | "tag" }> = [];
    if (
      mode === "all" ||
      !have.has(`${url}@${branch}`) ||
      !branchSha ||
      previous?.branchSha !== branchSha
    ) {
      refs.push({ refName: branch, refType: "branch" });
    }
    if (tag && (mode === "all" || !have.has(`${url}@${tag}`))) {
      refs.push({ refName: tag, refType: "tag" });
    }

    let branchFailed = false;

    for (const ref of refs) {
      try {
        const result = await importModuleFromGit({
          userId,
          library: def.id,
          token,
          repoFullName: repo.full_name,
          refType: ref.refType,
          refName: ref.refName,
          ...(def.submoduleContainer
            ? {
                terraformRootFolder: ".",
                terraformSubmodulesFolders: [def.submoduleContainer],
              }
            : {}),
          nameOverride: libraryDisplayName(def, repo),
          description: repo.description,
          tags: [def.id],
          // Already known from discovery; saves the icon lookup a request.
          defaultBranch: branch,
          ...(params.assertCurrent
            ? { assertCurrent: params.assertCurrent }
            : {}),
        });
        imported++;
        params.onRef?.({ repo, index, total: repos.length, ...ref, result });
      } catch (error) {
        // One unreadable ref must not cost the other hundred.
        if (ref.refType === "branch") branchFailed = true;
        log.warn("import", error, repo.full_name);
        failures.push({
          repo: repo.full_name,
          ref: ref.refName,
          message: error instanceof Error ? error.message : String(error),
        });
        params.onRef?.({ repo, index, total: repos.length, ...ref, error });
      }
    }

    // The default branch was renamed: its old rows would linger as a version
    // nothing tracks any more.
    if (previous?.branch && previous.branch !== branch) {
      await params.assertCurrent?.();
      await database.terraformModule.deleteMany({
        where: {
          userId,
          library: def.id,
          versionTag: previous.branch,
          source: { url },
        },
      });
    }

    progress[repo.full_name] = {
      branch,
      // Unknown after a failure, so the next run retries the branch.
      branchSha: branchFailed ? null : branchSha,
      tag: tag ?? previous?.tag ?? null,
    };
    await params.onRepoDone?.(progress);
  }

  return { imported, failures, more, progress };
}

/**
 * One full sync of a global library: discover, optionally prune, import.
 *
 * For operator-driven runs (CLI today, an admin action or a schedule later).
 * Pruning is opt-in: removing a shared module deletes it from every project
 * canvas of every user, which an operator should decide, not a listing that
 * happened to come back short.
 */
export async function syncGlobalLibrary(params: {
  library: ModuleLibraryDefinition;
  token: string | null;
  mode?: "changed" | "all";
  prune?: boolean;
  onDiscovered?: (repos: GitRepo[]) => void;
  onRef?: (event: RefEvent) => void;
}): Promise<ImportRunResult & { repos: GitRepo[]; pruned: number }> {
  const { library: def } = params;
  if (def.scope !== "global") {
    throw new Error(`Library '${def.id}' is per-user; sync it per user`);
  }

  const discovery = await discoverLibrary({
    token: params.token,
    library: def,
  });
  if (discovery.kind !== "repos") {
    throw new Error(`Library '${def.id}' could not be listed`);
  }
  params.onDiscovered?.(discovery.matched);

  const pruned = params.prune
    ? await pruneLibrary({
        library: def,
        userId: null,
        keepUrls: [
          ...discovery.matched.map((repo) => canonicalRepoUrl(repo.full_name)),
          ...discovery.uncertainUrls,
        ],
      })
    : 0;

  const result = await importLibraryRepos({
    library: def,
    userId: null,
    token: params.token,
    repos: discovery.matched,
    mode: params.mode ?? "all",
    ...(params.onRef ? { onRef: params.onRef } : {}),
  });

  return { ...result, repos: discovery.matched, pruned };
}
