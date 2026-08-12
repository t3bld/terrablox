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

export interface GitTag {
  name: string;
  commitSha?: string;
}

export type GitTreeEntryType = "tree" | "blob";

export interface GitTreeEntry {
  path: string;
  type: GitTreeEntryType;
}

export interface IGitProvider {
  getRepos(token: string): Promise<GitRepo[]>;
  /**
   * Lists the repositories a GitHub App installation may access.
   *
   * Installation tokens are not tied to a user, so `/user/repos` returns
   * nothing for them; the installation has its own repository selection.
   */
  getInstallationRepos(token: string): Promise<GitRepo[]>;
  getBranches(token: string, repoFullName: string): Promise<GitBranch[]>;
  getReleases(token: string, repoFullName: string): Promise<GitRelease[]>;
  /**
   * Lists git tags. Many module repos publish versions as plain tags without
   * ever creating a GitHub Release, so tags are the more complete list.
   */
  getTags(token: string, repoFullName: string): Promise<GitTag[]>;
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
