import {
  IGitProvider,
  GitRepo,
  GitBranch,
  GitRelease,
  GithubApiError,
} from "./types";

const REPOS_PER_PAGE = 100;
const MAX_PAGINATION_PAGES = 10;

class GithubProvider implements IGitProvider {
  private async githubFetch(token: string, url: string) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      cache: "no-store",
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "Could not read error body.");

      const providerHeaders: Record<string, string> = {};
      // Helpful for debugging missing scopes / rate limiting.
      for (const [k, v] of res.headers.entries()) providerHeaders[k] = v;

      const message = `GitHub API Error: ${res.status} ${res.statusText} - ${text.slice(0, 200)}`;
      throw new GithubApiError(message, res.status, providerHeaders);
    }

    return res;
  }

  public async getRepos(token: string): Promise<GitRepo[]> {
    const allRepos: GitRepo[] = [];
    let page = 1;

    while (page <= MAX_PAGINATION_PAGES) {
      const url = new URL(`https://api.github.com/user/repos`);
      url.searchParams.set("per_page", String(REPOS_PER_PAGE));
      url.searchParams.set("page", String(page));
      url.searchParams.set("visibility", "all");
      url.searchParams.set("affiliation", "owner,organization_member");
      url.searchParams.set("sort", "updated");

      const res = await this.githubFetch(token, url.toString());

      const pageData = (await res.json()) as GitRepo[];
      allRepos.push(...pageData);

      if (pageData.length < REPOS_PER_PAGE) {
        break;
      }
      page++;
    }

    return allRepos.map((repo) => ({
      id: repo.id,
      name: repo.name,
      full_name: repo.full_name,
      private: repo.private,
      html_url: repo.html_url,
      description: repo.description,
      updated_at: repo.updated_at,
    }));
  }

  public async getBranches(
    token: string,
    repoFullName: string,
  ): Promise<GitBranch[]> {
    const url = new URL(
      `https://api.github.com/repos/${repoFullName}/branches?per_page=100`,
    );

    const res = await this.githubFetch(token, url.toString());

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
    const url = new URL(
      `https://api.github.com/repos/${repoFullName}/releases?per_page=100`,
    );

    const res = await this.githubFetch(token, url.toString());

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
}

export const githubProvider = new GithubProvider();
