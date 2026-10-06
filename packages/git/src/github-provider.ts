import { githubRequest } from "./client";
import { listAccessibleRepos } from "./installations";
import type {
  GitBranch,
  GitRelease,
  GitRepo,
  GitTag,
  GitTreeEntry,
  IGitProvider,
} from "./types";

const REPOS_PER_PAGE = 100;
const MAX_PAGINATION_PAGES = 10;

function mapRepo(repo: GitRepo): GitRepo {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.full_name,
    private: repo.private,
    html_url: repo.html_url,
    description: repo.description,
    updated_at: repo.updated_at,
    default_branch: repo.default_branch ?? null,
  };
}

/**
 * The GitHub implementation of {@link IGitProvider}.
 *
 * It used to carry a `githubFetch` of its own and build absolute URLs by hand, which
 * made it a second HTTP client for an API this repository already had one for — two
 * error types, two places to add a header, and no sign at a call site which of them it
 * would get. It now composes `githubRequest`, so a failure here and a failure anywhere
 * else in the package are the same object with the same message.
 */
class GithubProvider implements IGitProvider {
  /**
   * The repositories Terrablox may actually use.
   *
   * Answered from the app's installations, not from `/user/repos`. Those are
   * different sets, and the difference is the whole point of running as a GitHub
   * App: `/user/repos` lists what the *person* can see, which under the old OAuth
   * App happened to coincide with what the token could do. It no longer does. Left
   * as it was, this would offer repositories the app was never granted, and each
   * one would fail on first read with a 404 that reads like a deleted repository.
   *
   * Sorted newest-first here rather than by the API, because the installation
   * endpoints have no `sort` parameter and a picker with the least recently touched
   * repository at the top is a picker nobody scrolls to the bottom of.
   */
  public async getRepos(token: string): Promise<GitRepo[]> {
    const repos = await listAccessibleRepos(token);

    return repos
      .map(mapRepo)
      .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
  }

  public async getBranches(
    token: string,
    repoFullName: string,
  ): Promise<GitBranch[]> {
    const url = `/repos/${repoFullName}/branches?per_page=100`;

    const res = await githubRequest(token, url);

    const data = (await res.json()) as Array<{
      name: string;
      commit?: { sha?: string };
    }>;

    return data.map((b) => ({
      name: b.name,
      commitSha: b.commit?.sha,
    }));
  }

  public async getReleases(
    token: string,
    repoFullName: string,
  ): Promise<GitRelease[]> {
    const url = `/repos/${repoFullName}/releases?per_page=100`;

    const res = await githubRequest(token, url);

    const data = (await res.json()) as Array<{
      id: number;
      name: string | null;
      tag_name: string;
      draft?: boolean;
      prerelease?: boolean;
      published_at?: string | null;
    }>;

    return data
      .filter((r) => !!r.tag_name)
      .map((r) => ({
        id: r.id,
        name: r.name,
        tag_name: r.tag_name,
        isDraft: r.draft,
        isPrerelease: r.prerelease,
        published_at: r.published_at,
      }));
  }

  public async getTags(token: string, repoFullName: string): Promise<GitTag[]> {
    const all: GitTag[] = [];
    let page = 1;

    while (page <= MAX_PAGINATION_PAGES) {
      const query = new URLSearchParams({
        per_page: String(REPOS_PER_PAGE),
        page: String(page),
      });

      const res = await githubRequest(
        token,
        `/repos/${repoFullName}/tags?${query}`,
      );
      const pageData = (await res.json()) as Array<{
        name: string;
        commit?: { sha?: string };
      }>;

      for (const t of pageData) {
        if (t.name) all.push({ name: t.name, commitSha: t.commit?.sha });
      }

      if (pageData.length < REPOS_PER_PAGE) break;
      page++;
    }

    // GitHub returns tags in commit order; users expect the newest version
    // first. `numeric` keeps v6.10.0 ahead of v6.9.0.
    return all.sort((a, b) =>
      b.name.localeCompare(a.name, "en", { numeric: true }),
    );
  }

  public async getTree(
    token: string,
    repoFullName: string,
    ref: string,
  ): Promise<GitTreeEntry[]> {
    // 1) Resolve ref -> sha
    const refUrl = `/repos/${repoFullName}/git/ref/${encodeURIComponent(ref)}`;

    let sha: string | undefined;
    try {
      const refRes = await githubRequest(token, refUrl);
      const refData = (await refRes.json()) as { object?: { sha?: string } };
      sha = refData?.object?.sha;
    } catch {
      // If the direct ref lookup fails (e.g. tags vs heads), fall back to commits.
      const commitRes = await githubRequest(
        token,
        `/repos/${repoFullName}/commits/${encodeURIComponent(ref)}`,
      );
      const commitData = (await commitRes.json()) as { sha?: string };
      sha = commitData?.sha;
    }

    if (!sha) {
      throw new Error(`Unable to resolve ref ${ref}`);
    }

    // 2) Fetch the recursive tree
    const treeRes = await githubRequest(
      token,
      `/repos/${repoFullName}/git/trees/${sha}?recursive=1`,
    );

    const treeData = (await treeRes.json()) as {
      tree?: Array<{ path: string; type: "tree" | "blob" | "commit" }>;
    };

    return (treeData.tree ?? [])
      .filter((e) => e.type === "tree" || e.type === "blob")
      .map((e) => ({ path: e.path, type: e.type as "tree" | "blob" }));
  }
}

export const githubProvider = new GithubProvider();
