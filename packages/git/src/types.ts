/**
 * What a git host has to be able to answer, and in what shape.
 *
 * One implementation today. The interface exists anyway, and this is the seam a second
 * host would be added at: every route asks a provider rather than GitHub, so adding
 * GitLab is implementing `IGitProvider` and widening `GitProviderId` rather than
 * hunting for `api.github.com` across the app.
 *
 * The field names follow GitHub's own JSON (`full_name`, `tag_name`) where the value is
 * passed straight through from it, and camelCase where this package derives it. Worth
 * knowing before adding a provider: those names are a promise to the callers, and a
 * second host maps onto them rather than the other way round.
 */

export type GitProviderId = "github";

export interface GitRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  description: string | null;
  updated_at: string;
  /**
   * The branch a repository-level question should be answered against — its icon,
   * for one, which belongs to the repository rather than to whichever ref is being
   * imported.
   */
  default_branch: string | null;
  /**
   * Present on GitHub's full repository objects (including installation
   * listings), kept optional because not every endpoint or host returns them.
   * Module library discovery filters on these.
   */
  archived?: boolean;
  topics?: string[];
  pushed_at?: string | null;
  owner?: { login: string } | null;
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
