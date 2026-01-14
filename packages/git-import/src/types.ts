export type GitProviderId = "github";

export interface GitRepo {
  id: number;
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
}

export interface GitRelease {
  id: number;
  name: string | null;
  tag_name: string;
  isDraft?: boolean;
  isPrerelease?: boolean;
  published_at?: string | null;
}

export type GitTreeEntryType = "tree" | "blob";

export interface GitTreeEntry {
  path: string;
  type: GitTreeEntryType;
}

export interface IGitProvider {
  getRepos(token: string): Promise<GitRepo[]>;
  getBranches(token: string, repoFullName: string): Promise<GitBranch[]>;
  getReleases(token: string, repoFullName: string): Promise<GitRelease[]>;
  getTree(
    token: string,
    repoFullName: string,
    ref: string,
  ): Promise<GitTreeEntry[]>;
}

export class GithubApiError extends Error {
  public status: number;
  public providerHeaders: Record<string, string>;

  constructor(
    message: string,
    status: number,
    providerHeaders: Record<string, string> = {},
  ) {
    super(message);
    this.name = "GithubApiError";
    this.status = status;
    this.providerHeaders = providerHeaders;
  }
}
