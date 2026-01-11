export interface GitRepo {
  id: string | number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  description: string | null;
  updated_at: string;
}

export interface GitBranch {
  name: string;
  commitSha?: string;
  isDefault?: boolean;
}

export interface GitRelease {
  id: string | number;
  name: string | null;
  tag_name: string;
  isDraft?: boolean;
  isPrerelease?: boolean;
  published_at?: string | null;
}

export type GitProviderId = "github";

export interface IGitProvider {
  getRepos(token: string): Promise<GitRepo[]>;
  getBranches(token: string, repoFullName: string): Promise<GitBranch[]>;
  getReleases(token: string, repoFullName: string): Promise<GitRelease[]>;
}

export class GithubApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly providerHeaders?: Record<string, string>,
  ) {
    super(message);
    this.name = "GithubApiError";
  }
}
