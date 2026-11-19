import { z } from "zod";

/** Pure module-library definitions shared by the app, CLI, and catalogue tools. */
export type LibraryScope = "global" | "user";

export interface ModuleLibraryDefinition {
  /** Stable slug stored on imported module rows. */
  id: string;
  /** Human-readable label. */
  name: string;
  scope: LibraryScope;
  /** Whether users may see and use the library. */
  visible: boolean;
  /** GitHub organisation or user that owns matching repositories. */
  org: string;
  /** Every topic must be present on a matching repository. */
  topics: string[];
  /** Optional repository-name prefix. */
  prefix: string | null;
  /** Global libraries only: reject private repositories when true. */
  publicOnly: boolean;
  /** Optional folder containing the repository's Terraform submodules. */
  submoduleContainer: string | null;
  /** Repository-secret name used by generated pipelines. */
  pipelineSecret: string;
}

export interface LibraryLabel {
  id: string;
  name: string;
}

export const TERRABLOX_LIBRARY_ID = "terrablox";

/** Static catalogue definition used by DB-free snapshot tooling. */
export const DEFAULT_TERRABLOX_LIBRARY = {
  id: TERRABLOX_LIBRARY_ID,
  name: "Terrablox",
  scope: "global",
  visible: true,
  org: "terrablox",
  prefix: "terrablox-aws-",
  submoduleContainer: "modules",
} as const;

export const LIBRARY_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

const ORG_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const PREFIX_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

// Strict because name, org, and secret names can end up in committed workflow YAML.
export const moduleLibraryDefinitionSchema = z
  .object({
    id: z
      .string()
      .regex(LIBRARY_ID_PATTERN, "id must match ^[a-z][a-z0-9-]{1,31}$"),
    name: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(/^[\p{L}\p{N} ._()-]+$/u, "name contains unsupported characters"),
    scope: z.enum(["global", "user"]),
    visible: z.boolean().default(true),
    org: z.string().regex(ORG_PATTERN, "org is not a valid GitHub login"),
    topics: z
      .array(
        z
          .string()
          .transform((topic) => topic.trim().toLowerCase())
          .pipe(z.string().regex(/^[a-z0-9][a-z0-9-]{0,49}$/, "invalid topic")),
      )
      .max(10)
      .default([]),
    prefix: z.string().regex(PREFIX_PATTERN, "invalid prefix").optional(),
    publicOnly: z.boolean().optional(),
    submoduleContainer: z
      .string()
      .regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/, "invalid folder")
      .refine((folder) => !folder.split("/").includes(".."), "invalid folder")
      .optional(),
    pipelineSecret: z
      .string()
      .regex(
        /^[A-Z][A-Z0-9_]{0,99}$/,
        "pipelineSecret must be UPPER_SNAKE_CASE",
      )
      .refine(
        (name) => !name.startsWith("GITHUB_"),
        "GITHUB_ secrets are reserved",
      )
      .optional(),
  })
  .refine((def) => def.topics.length > 0 || !!def.prefix, {
    message:
      "needs at least one topic or a prefix, otherwise it would match every repository in the org",
  });

export function defaultPipelineSecret(id: string): string {
  return `TERRABLOX_${id.toUpperCase().replace(/-/g, "_")}_MODULES_TOKEN`;
}

/** Validates and normalizes one definition from config or a database row. */
export function normalizeModuleLibraryDefinition(
  input: unknown,
): ModuleLibraryDefinition {
  const def = moduleLibraryDefinitionSchema.parse(input);
  return {
    id: def.id,
    name: def.name,
    scope: def.scope,
    visible: def.visible,
    org: def.org,
    topics: [...new Set(def.topics)],
    prefix: def.prefix ?? null,
    // Per-user discovery follows the user's own installation, so this switch is
    // meaningful only for a shared global library.
    publicOnly: def.scope === "global" ? (def.publicOnly ?? true) : false,
    submoduleContainer: def.submoduleContainer ?? null,
    pipelineSecret: def.pipelineSecret ?? defaultPipelineSecret(def.id),
  };
}

/** Whether generated project workflows need a repository token for this library. */
export function needsPipelineToken(def: ModuleLibraryDefinition): boolean {
  return def.scope === "user" || !def.publicOnly;
}

/** Resolves a row's library label from a previously loaded batch. */
export function libraryOf(
  row: { library?: string | null },
  labels: ReadonlyMap<string, LibraryLabel>,
): LibraryLabel | null {
  if (!row.library) return null;
  return labels.get(row.library) ?? { id: row.library, name: row.library };
}

export interface LibraryCandidateRepo {
  name: string;
  full_name: string;
  archived?: boolean;
  private?: boolean;
  topics?: string[];
  owner?: { login: string } | null;
}

/** Tests repository ownership, archival state, visibility, prefix, and topics. */
export function matchesLibrary(
  repo: LibraryCandidateRepo,
  def: Pick<
    ModuleLibraryDefinition,
    "org" | "prefix" | "topics" | "publicOnly"
  >,
  topics: string[] | undefined = repo.topics,
): boolean {
  const owner = repo.owner?.login ?? repo.full_name.split("/")[0] ?? "";
  if (owner.toLowerCase() !== def.org.toLowerCase()) return false;
  if (repo.archived === true) return false;
  if (def.publicOnly && repo.private === true) return false;
  if (def.prefix && !repo.name.startsWith(def.prefix)) return false;

  const have = new Set((topics ?? []).map((topic) => topic.toLowerCase()));
  return def.topics.every((topic) => have.has(topic));
}

export const LIBRARY_SYNC_TTL_MS = 15 * 60 * 1000;
export const LIBRARY_SYNC_ERROR_BACKOFF_MS = 2 * 60 * 1000;

export function isSyncLocked(
  row: { lockedUntil: Date | null } | null,
  now: Date,
): boolean {
  return !!row?.lockedUntil && row.lockedUntil > now;
}

export function isSyncStale(
  row: {
    state: string;
    pending: boolean;
    lockedUntil: Date | null;
    lastAttemptAt: Date | null;
  } | null,
  now: Date,
): boolean {
  if (!row) return true;
  if (isSyncLocked(row, now)) return false;
  if (row.state === "never" || row.pending || !row.lastAttemptAt) return true;

  const age = now.getTime() - row.lastAttemptAt.getTime();
  return row.state === "error"
    ? age > LIBRARY_SYNC_ERROR_BACKOFF_MS
    : age > LIBRARY_SYNC_TTL_MS;
}
