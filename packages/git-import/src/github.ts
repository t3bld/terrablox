import type { IGitProvider, GitRepo } from "./types";

const REPOS_PER_PAGE = 100;
const MAX_PAGINATION_PAGES = 10;

export class GithubApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "GithubApiError";
  }
}

class GithubProvider implements IGitProvider {
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

      const res = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        cache: "no-store",
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "Could not read error body.");
        const message = `GitHub API Error: ${res.status} ${res.statusText} - ${text.slice(0, 200)}`;
        throw new GithubApiError(message, res.status);
      }

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
}

export const githubProvider = new GithubProvider();