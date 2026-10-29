import { z } from "zod";

/**
 * The module libraries this instance offers — all of them, in one list.
 *
 * `TERRABLOX_MODULE_LIBRARIES` is a JSON array; each entry is one library:
 * which repositories it reads, what it is called, who it is for, and whether it
 * is visible. Terrablox is an ordinary entry like any other. Two scopes:
 *
 * - **global**: one shared copy, rows with `userId = NULL`, read by every user.
 *   Imported by an operator with a token from the shell (`pnpm db:library:sync`).
 * - **user**: one copy per user, discovered with *that user's own* GitHub token
 *   and stored as rows they own. For private organisations such as Porsche,
 *   where access differs per person.
 *
 * Every library row carries `library = <id>`. `visible` is independent of the
 * rows: `false` hides the library from every read path without touching the
 * database, so switching it back is instant, and importing keeps working.
 *
 * No `server-only`: pure config, no secrets, no database — the CLI scripts and
 * ownership.ts import it too.
 */

export type LibraryScope = "global" | "user";

export interface ModuleLibraryDefinition {
  /** Stable slug, stored on rows. Never shown. */
  id: string;
  /** Display name, e.g. `Porsche`. */
  name: string;
  scope: LibraryScope;
  /** Whether users see and can use it. Independent of what is imported. */
  visible: boolean;
  /** GitHub organisation (or user) that owns the repositories. */
  org: string;
  /** Every one must be on a repository for it to belong (AND). Lower-case. */
  topics: string[];
  /** Optional repository name prefix, also required when set. */
  prefix: string | null;
  /** Global libraries only: list only public repositories of the org. */
  publicOnly: boolean;
  /**
   * Folder holding submodules, pinned (e.g. `modules`). Null means detect the
   * Terraform root and `<root>/modules/*` per repository.
   */
  submoduleContainer: string | null;
  /** Repository secret a generated pipeline reads to clone private modules. */
  pipelineSecret: string;
}

/**
 * The id the Terrablox catalogue's naming hangs off (terrablox-aws-vpc -> "VPC")
 * and the website snapshot reads. Otherwise an ordinary library.
 */
export const TERRABLOX_LIBRARY_ID = "terrablox";

export const LIBRARIES_ENV = "TERRABLOX_MODULE_LIBRARIES";

/** The Terrablox catalogue, as the default list writes it. */
export const DEFAULT_TERRABLOX_LIBRARY = {
  id: TERRABLOX_LIBRARY_ID,
  name: "Terrablox",
  scope: "global",
  visible: true,
  org: "terrablox",
  prefix: "terrablox-aws-",
  submoduleContainer: "modules",
} as const;

/** Used when the variable is unset or blank. `[]` means no libraries at all. */
export const DEFAULT_MODULE_LIBRARIES = [
  DEFAULT_TERRABLOX_LIBRARY,
  {
    id: "porsche",
    name: "Porsche",
    scope: "user",
    visible: true,
    org: "porsche-code",
    topics: ["aws", "cbbac"],
  },
] as const;

export const LIBRARY_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

const ORG_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const PREFIX_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

// Strict, because name, org and secret end up in committed workflow YAML.
const definitionSchema = z
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

function toDefinition(
  def: z.infer<typeof definitionSchema>,
): ModuleLibraryDefinition {
  return {
    id: def.id,
    name: def.name,
    scope: def.scope,
    visible: def.visible,
    org: def.org,
    topics: [...new Set(def.topics)],
    prefix: def.prefix ?? null,
    // A per-user library reads whatever the user's installation grants, so the
    // flag only means something for a global one. Global defaults to public: a
    // shared copy of private repositories would show every user what only some
    // may read.
    publicOnly: def.scope === "global" ? (def.publicOnly ?? true) : false,
    submoduleContainer: def.submoduleContainer ?? null,
    pipelineSecret: def.pipelineSecret ?? defaultPipelineSecret(def.id),
  };
}

/**
 * Parses the JSON variable. Pure, so it can be tested without touching
 * process.env.
 *
 * A bad element is skipped and reported, the rest are kept. Unparseable JSON
 * falls back to the public Terrablox catalogue alone: a typo must not empty
 * every user's library, and it must never be the reason a private library's
 * definition is guessed at.
 */
export function parseModuleLibraries(raw: string | undefined): {
  libraries: ModuleLibraryDefinition[];
  problems: string[];
  fatal: boolean;
} {
  let input: unknown = DEFAULT_MODULE_LIBRARIES;

  const fallback = (problem: string) => ({
    libraries: [
      toDefinition(definitionSchema.parse(DEFAULT_TERRABLOX_LIBRARY)),
    ],
    problems: [problem],
    fatal: true,
  });

  if (raw !== undefined && raw.trim() !== "") {
    try {
      input = JSON.parse(raw);
    } catch {
      return fallback(
        `${LIBRARIES_ENV} is not valid JSON; using only the default Terrablox library`,
      );
    }
  }

  if (!Array.isArray(input)) {
    return fallback(
      `${LIBRARIES_ENV} must be a JSON array; using only the default Terrablox library`,
    );
  }

  const problems: string[] = [];
  const libraries: ModuleLibraryDefinition[] = [];
  const ids = new Set<string>();
  // Per scope: the same org can feed a public global library and a private
  // per-user one, but two libraries of one scope over one org would fight
  // over the same repositories.
  const orgs = new Set<string>();

  input.forEach((element, index) => {
    const parsed = definitionSchema.safeParse(element);
    if (!parsed.success) {
      const reason = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "entry"}: ${issue.message}`)
        .join("; ");
      problems.push(`${LIBRARIES_ENV}[${index}] skipped: ${reason}`);
      return;
    }

    const def = parsed.data;
    const orgKey = `${def.scope}:${def.org.toLowerCase()}`;

    if (ids.has(def.id)) {
      problems.push(
        `${LIBRARIES_ENV}[${index}] skipped: duplicate id '${def.id}'`,
      );
      return;
    }
    if (orgs.has(orgKey)) {
      problems.push(
        `${LIBRARIES_ENV}[${index}] skipped: another ${def.scope} library already reads '${def.org}'`,
      );
      return;
    }

    ids.add(def.id);
    orgs.add(orgKey);
    libraries.push(toDefinition(def));
  });

  return { libraries, problems, fatal: false };
}

let cached: {
  raw: string | undefined;
  libraries: ModuleLibraryDefinition[];
} | null = null;

/**
 * Every configured library, visible or not, in configuration order.
 *
 * Parsed once per process and env value; problems are logged once.
 */
export function moduleLibraries(): ModuleLibraryDefinition[] {
  const raw = process.env[LIBRARIES_ENV];
  if (cached && cached.raw === raw) return cached.libraries;

  const { libraries, problems, fatal } = parseModuleLibraries(raw);
  for (const problem of problems) {
    if (fatal) console.error(`[module-library] ${problem}`);
    else console.warn(`[module-library] ${problem}`);
  }

  cached = { raw, libraries };
  return libraries;
}

export function findModuleLibrary(
  id: string,
): ModuleLibraryDefinition | undefined {
  return moduleLibraries().find((library) => library.id === id);
}

/** Configured and visible libraries of one scope. */
export function visibleLibraries(
  scope: LibraryScope,
): ModuleLibraryDefinition[] {
  return moduleLibraries().filter(
    (library) => library.scope === scope && library.visible,
  );
}

export function visibleLibraryIds(scope: LibraryScope): string[] {
  return visibleLibraries(scope).map((library) => library.id);
}

/**
 * Whether a project using this library needs its own token in the pipeline:
 * every per-user library (private by nature) and a global one over private repos.
 */
export function needsPipelineToken(def: ModuleLibraryDefinition): boolean {
  return def.scope === "user" || !def.publicOnly;
}

export interface LibraryLabel {
  id: string;
  name: string;
}

/** Which library a row belongs to, for labels, or null for an own import. */
export function libraryOf(row: {
  library?: string | null;
}): LibraryLabel | null {
  if (!row.library) return null;

  const def = findModuleLibrary(row.library);
  return { id: row.library, name: def?.name ?? row.library };
}

/** The fields of a GitHub repository payload that matching needs. */
export interface LibraryCandidateRepo {
  name: string;
  full_name: string;
  archived?: boolean;
  private?: boolean;
  topics?: string[];
  owner?: { login: string } | null;
}

/**
 * Owner is the org, not archived, public when required, carries every topic,
 * and has the prefix.
 */
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

/** How long a successful per-user sync is trusted before it runs again. */
export const LIBRARY_SYNC_TTL_MS = 15 * 60 * 1000;
/** Backoff after a failed sync. */
export const LIBRARY_SYNC_ERROR_BACKOFF_MS = 2 * 60 * 1000;

export function isSyncLocked(
  row: { lockedUntil: Date | null } | null,
  now: Date,
): boolean {
  return !!row?.lockedUntil && row.lockedUntil > now;
}

/** Whether a sync row should run again. A locked row is never stale. */
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
