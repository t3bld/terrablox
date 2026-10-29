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
  /**
   * Part of a library Terrablox manages — the shipped catalogue or a per-user
   * library such as Porsche — so not removable.
   */
  isBuiltin: boolean;
  /** Which library this repository belongs to; null for the user's own import. */
  library: { id: string; name: string } | null;
  /** Which icon source to draw from: `repo`, `aws` or `none`. */
  iconMode: string;
  /** True when the repository ships its own icon. */
  hasIcon: boolean;
  /** A bundled AWS icon chosen at import, without the extension. */
  iconName: string | null;
  /**
   * The version this repository opens at: its tracked branch, or the newest
   * release when it has none. Never null in practice.
   */
  defaultVersion: RepositoryVersionDto | null;
  versionCount: number;
  totalSubmoduleCount: number;
  /** Sorted newest first. */
  versions: RepositoryVersionDto[];
  updatedAt: string;
}
