export interface GitRepo {
  id: string | number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  description: string | null;
  updated_at: string;
}

export type GitProviderId = "github";

export interface IGitProvider {
  getRepos(token: string): Promise<GitRepo[]>;
}

export class GithubApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "GithubApiError";
  }
}
