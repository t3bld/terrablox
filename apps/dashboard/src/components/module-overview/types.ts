/**
 * Shape of `/api/modules/list`, which groups module rows by repository.
 */

export interface RepositoryVersionDto {
  id: string;
  versionTag: string | null;
  url: string | null;
  terraformRootFolder: string | null;
  submoduleCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface RepositoryDto {
  key: string;
  sourceId: string | null;
  name: string;
  description: string | null;
  tags: string[];
  url: string | null;
  provider: string | null;
  /** Newest version by semver-aware ordering; never null in practice. */
  latestVersion: RepositoryVersionDto | null;
  versionCount: number;
  totalSubmoduleCount: number;
  /** Sorted newest first. */
  versions: RepositoryVersionDto[];
  updatedAt: string;
}
