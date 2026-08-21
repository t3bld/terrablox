import "server-only";

import type {
  Prisma,
  TerraformModule,
  TerraformModuleSource,
} from "@terrablox/database";

import { database } from "@/lib/database";
import {
  findRepoIconPath,
  type IconChoiceValue,
  REPO_ICON_FILES,
} from "@/lib/modules/icon";
import { analyzeTerraformFiles } from "@/lib/terraform/analyze";
import { persistAnalysis } from "@/lib/terraform/persist";
import type { TerraformAnalysisError } from "@/lib/terraform/types";

/**
 * Turning a GitHub repository into module rows.
 *
 * Lifted out of the route handler that used to hold it so that the same pipeline
 * can run for two callers with different notions of an owner: a signed-in user
 * importing a repository, and the installation importing the catalogue TerraBlox
 * ships with. The alternative — a second pipeline for the catalogue — would mean
 * two parsing paths that drift, and the whole point of shipping the catalogue as
 * ordinary module rows is that nothing downstream can tell the difference.
 *
 * `userId` is therefore `string | null` throughout: null writes a builtin. That
 * is the only concession this file makes to the distinction.
 */

// A release is identified by its tag, so all three resolve to a git ref name.
export type GitRefType = "release" | "branch" | "tag";

export interface ImportModuleFromGitInput {
  /** The owner of the resulting rows, or null for the shipped catalogue. */
  userId: string | null;
  /** GitHub token. Optional for public repos — omitting it uses the 60 req/h unauthenticated limit. */
  token: string | null;
  repoFullName: string;
  refType: GitRefType;
  refName: string;
  terraformRootFolder?: string | null;
  terraformSubmodulesFolders?: string[] | null;
  nameOverride?: string | null;
  description?: string | null;
  tags?: string[] | null;
  /**
   * What the module should show as its icon. Omit to leave whatever is already
   * stored: the catalogue re-sync sends nothing and must not overwrite a choice
   * somebody made by hand in the import dialog.
   */
  icon?: IconChoiceValue | null;
  /**
   * The repository's default branch, if the caller already knows it.
   *
   * Only saves a request — {@link resolveIconUrl} looks it up otherwise. Worth
   * passing from the catalogue sync, which read it while listing the org and does
   * a hundred imports in a row against a shared rate limit.
   */
  defaultBranch?: string | null;
}

/**
 * The icon file a repository ships, if it ships one.
 *
 * Read from the tree that was fetched anyway, so this costs no request. The
 * matching itself lives in `lib/modules/icon` because the import dialog has to
 * answer the same question from the same tree.
 */
function findIconPath(treeEntries: TreeEntry[]): string | null {
  return findRepoIconPath(
    treeEntries
      .filter((entry) => entry.type === "blob")
      .map((entry) => entry.path),
  );
}

/**
 * The same question for a ref whose tree we did not fetch.
 *
 * One request per candidate name, and the first name is the common one, so this
 * is normally a single call. Cheaper than pulling a whole recursive tree just to
 * look at its root.
 */
async function probeIconPath(params: {
  token: string | null;
  repoFullName: string;
  ref: string;
}): Promise<string | null> {
  for (const candidate of REPO_ICON_FILES) {
    const url = new URL(
      `https://api.github.com/repos/${params.repoFullName}/contents/${candidate}`,
    );
    url.searchParams.set("ref", params.ref);

    try {
      const res = await fetch(url, {
        headers: GITHUB_HEADERS(params.token),
        cache: "no-store",
      });

      if (res.ok) return candidate;
    } catch {
      // Treated as absent: an icon is decoration, and a network blip here must
      // not fail an import that has everything else it needs.
    }
  }

  return null;
}

/**
 * The repository's default branch, or null if it cannot be read.
 *
 * Needed because the icon is a fact about the repository rather than about the
 * ref being imported — see {@link resolveIconUrl}.
 */
async function fetchDefaultBranch(params: {
  token: string | null;
  repoFullName: string;
}): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${params.repoFullName}`,
      { headers: GITHUB_HEADERS(params.token), cache: "no-store" },
    );

    if (!res.ok) return null;

    const body = (await res.json()) as { default_branch?: string };
    return body.default_branch ?? null;
  } catch {
    return null;
  }
}

/**
 * Where to fetch the repository's own icon from, or null if it has none.
 *
 * Resolved against the default branch, not against the ref being imported. An
 * icon belongs to the repository: reading it per ref made the stored value depend
 * on import order, because syncing `master` and then an older tag would find the
 * icon and then unfind it. Every repository in the catalogue ended up without one
 * despite all fifty shipping the file.
 *
 * The URL is left pointing at the branch rather than at a commit, so replacing the
 * icon upstream shows up without a re-import.
 */
async function resolveIconUrl(params: {
  token: string | null;
  repoFullName: string;
  refName: string;
  defaultBranch: string | null;
  treeEntries: TreeEntry[];
}): Promise<string | null> {
  // Falling back to the imported ref keeps a repository whose metadata could not
  // be read no worse off than before this existed.
  const iconRef =
    params.defaultBranch ??
    (await fetchDefaultBranch({
      token: params.token,
      repoFullName: params.repoFullName,
    })) ??
    params.refName;

  const iconPath =
    iconRef === params.refName
      ? findIconPath(params.treeEntries)
      : await probeIconPath({
          token: params.token,
          repoFullName: params.repoFullName,
          ref: iconRef,
        });

  if (!iconPath) return null;

  return `https://raw.githubusercontent.com/${params.repoFullName}/${encodeURIComponent(
    iconRef,
  )}/${iconPath}`;
}

export interface ImportModuleFromGitResult {
  module: TerraformModule;
  submodules: Array<{ id: string; terraformRootFolder: string }>;
  source: TerraformModuleSource;
  /** Per-file parse failures. An import can succeed with some files unread. */
  warnings: TerraformAnalysisError[];
  timings: ImportTimings;
}

/**
 * Where the wall clock went, so a slow import can be diagnosed rather than
 * guessed at.
 *
 * Syncing ~50 repositories took about two hours, which is far more than the
 * shape of the work suggests: files within a folder are fetched in parallel and
 * folders are analysed in parallel, so one repository should be two or three
 * round trips deep. Before optimising the fetching — the obvious suspect — it is
 * worth knowing whether the time is actually spent in GitHub, in the HCL parser,
 * or in Postgres. `fetchMs` and `parseMs` overlap with each other because the
 * folders run concurrently, so they are sums of work, not slices of a timeline;
 * `totalMs` is the only figure that is wall clock.
 */
export interface ImportTimings {
  totalMs: number;
  /** Resolving the ref and pulling the recursive tree: one or two requests. */
  treeMs: number;
  /** Summed time inside file content requests. */
  fetchMs: number;
  /** Summed time inside `analyzeTerraformFiles`, i.e. the HCL/WASM parse. */
  parseMs: number;
  /** The single write transaction, including every child-table rewrite. */
  dbMs: number;
  fileCount: number;
  /** Root plus submodules, i.e. how many times the analyser ran. */
  folderCount: number;
}

/** Accumulates {@link ImportTimings} while one import runs. */
interface TimingSink {
  fetchMs: number;
  parseMs: number;
  fileCount: number;
}

async function timed<T>(
  run: () => Promise<T>,
): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await run();
  return { value, ms: performance.now() - started };
}

export function normalizeFolderPath(input?: string | null) {
  const raw = (input ?? "").trim();
  if (!raw) return null;
  const normalized = raw.replace(/^\/+/, "").replace(/\/+$/, "");
  return normalized === "" ? null : normalized;
}

export function normalizeTags(tags?: string[] | null) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tags ?? []) {
    const n = t.trim().replace(/\s+/g, "-").toLowerCase();
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/** The canonical repository URL, which is what identifies a source row. */
export function canonicalRepoUrl(repoFullName: string): string {
  return `https://github.com/${repoFullName}.git`;
}

type TreeEntry = { path: string; type: "tree" | "blob" };

const GITHUB_HEADERS = (token: string | null): Record<string, string> => {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
};

async function fetchRepoTree(params: {
  token: string | null;
  repoFullName: string;
  ref: string;
}): Promise<TreeEntry[]> {
  // Resolve ref -> sha (best-effort). Uses GitHub API directly so we don't rely on internal route calls.
  const refUrl = `https://api.github.com/repos/${params.repoFullName}/git/ref/${encodeURIComponent(params.ref)}`;

  let sha: string | undefined;
  try {
    const refRes = await fetch(refUrl, {
      headers: GITHUB_HEADERS(params.token),
      cache: "no-store",
    });

    if (refRes.ok) {
      const refData = (await refRes.json()) as { object?: { sha?: string } };
      sha = refData?.object?.sha;
    }
  } catch {
    // ignore
  }

  if (!sha) {
    const commitRes = await fetch(
      `https://api.github.com/repos/${params.repoFullName}/commits/${encodeURIComponent(params.ref)}`,
      { headers: GITHUB_HEADERS(params.token), cache: "no-store" },
    );

    if (!commitRes.ok) return [];
    const commitData = (await commitRes.json()) as { sha?: string };
    sha = commitData?.sha;
  }

  if (!sha) return [];

  const treeRes = await fetch(
    `https://api.github.com/repos/${params.repoFullName}/git/trees/${sha}?recursive=1`,
    { headers: GITHUB_HEADERS(params.token), cache: "no-store" },
  );

  if (!treeRes.ok) return [];

  const treeData = (await treeRes.json()) as {
    tree?: Array<{ path: string; type: "tree" | "blob" | "commit" }>;
  };

  return (treeData.tree ?? [])
    .filter((e) => e.type === "tree" || e.type === "blob")
    .map((e) => ({ path: e.path, type: e.type as "tree" | "blob" }));
}

/**
 * One file's text, at any size GitHub will serve.
 *
 * `Accept: application/vnd.github.raw` rather than the JSON form, and that is a
 * bug fix rather than a tidy-up. The JSON response only carries `content` for
 * files up to 1 MB; above that it answers with `encoding: "none"` and an empty
 * string. This function returned null for those, `analyzeFolder` dropped the null
 * with the ones that genuinely 404, and the module was stored as though the file
 * did not exist.
 *
 * The WAF module is what exposed it: a 1.2 MB `main.tf` holding every resource in
 * the module, so the root was imported with 23 variables, 12 outputs and zero
 * resources — no architecture diagram, nothing on the Resources tab, and no error
 * anywhere. The raw media type is documented up to 100 MB.
 */
async function fetchTextFile(params: {
  token: string | null;
  repoFullName: string;
  ref: string;
  path: string;
}): Promise<string | null> {
  const apiUrl = new URL(
    `https://api.github.com/repos/${params.repoFullName}/contents/${params.path.replace(/^\/+/, "")}`,
  );
  apiUrl.searchParams.set("ref", params.ref);

  const res = await fetch(apiUrl.toString(), {
    headers: {
      ...GITHUB_HEADERS(params.token),
      Accept: "application/vnd.github.raw",
    },
    cache: "no-store",
  });

  if (!res.ok) return null;

  // The raw media type answers with the bytes themselves. A server that ignored
  // the header still sends JSON, so the old path is kept as a fallback rather
  // than assumed away.
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return await res.text();
  }

  const body = (await res.json()) as {
    type?: string;
    encoding?: string;
    content?: string;
  };
  if (body.type !== "file") return null;
  if (!body.content) return null;
  const encoding = body.encoding ?? "base64";
  if (encoding !== "base64") return null;
  return Buffer.from(body.content, "base64").toString("utf8");
}

function listTfFilesForFolder(params: {
  treeEntries: TreeEntry[];
  folder: string;
}) {
  const root = normalizeFolderPath(params.folder) ?? ".";
  const prefix = root === "." ? "" : `${root}/`;

  return (
    params.treeEntries
      .filter((e) => e.type === "blob")
      .map((e) => e.path)
      .filter((p) => (prefix ? p.startsWith(prefix) : true))
      .filter((p) => p.endsWith(".tf"))
      // only direct folder contents
      .filter((p) => {
        const rel = prefix ? p.slice(prefix.length) : p;
        return !rel.includes("/");
      })
      .slice(0, 50)
  );
}

function listDirectChildFolders(params: {
  treeEntries: TreeEntry[];
  folder: string;
}) {
  const root = normalizeFolderPath(params.folder) ?? ".";
  const prefix = root === "." ? "" : `${root}/`;

  const children = new Set<string>();

  for (const e of params.treeEntries) {
    if (e.type !== "tree") continue;
    if (prefix && !e.path.startsWith(prefix)) continue;

    const rel = prefix ? e.path.slice(prefix.length) : e.path;
    if (!rel) continue;
    const segs = rel.split("/").filter(Boolean);
    if (segs.length >= 1 && segs[0]) {
      const child = prefix ? `${prefix}${segs[0]}` : segs[0];
      children.add(child);
    }
  }

  return [...children].sort();
}

async function analyzeFolder(params: {
  token: string | null;
  repoFullName: string;
  refName: string;
  treeEntries: TreeEntry[];
  folder: string;
  timing: TimingSink;
}) {
  const files = listTfFilesForFolder({
    treeEntries: params.treeEntries,
    folder: params.folder,
  });

  // Fetched in parallel; a module with 50 files would otherwise serialise 50
  // round trips to GitHub.
  const fetched = await timed(() =>
    Promise.all(
      files.map(async (path) => {
        const content = await fetchTextFile({
          token: params.token,
          repoFullName: params.repoFullName,
          ref: params.refName,
          path,
        });

        return content === null ? null : { path, content };
      }),
    ),
  );

  const present = fetched.value.filter(
    (f): f is { path: string; content: string } => f !== null,
  );

  const analysed = await timed(() => analyzeTerraformFiles(present));

  /**
   * A file we listed but could not read is reported, not dropped.
   *
   * This is the other half of the 1 MB bug: the read failed, the null was
   * filtered out beside the ones that legitimately 404, and a module missing
   * every resource looked exactly like a module that declares none. Silence was
   * what made it take a person noticing an empty diagram to find.
   */
  const unreadable = files.filter(
    (path) => !present.some((file) => file.path === path),
  );

  for (const path of unreadable) {
    analysed.value.errors.push({
      file: path,
      message:
        "The file was listed in the repository but could not be read, so nothing in it was analysed.",
    });
  }

  params.timing.fetchMs += fetched.ms;
  params.timing.parseMs += analysed.ms;
  params.timing.fileCount += present.length;

  return analysed.value;
}

/**
 * Where the root configuration lives, worked out rather than asked for.
 *
 * The dialog used to have a folder picker for this, and it was the step most
 * likely to be got wrong: a wrong folder imports a module with no variables and
 * no outputs, which looks like a broken repository rather than a wrong answer.
 *
 * The rule is the one a person would apply. Terraform in the repository root is
 * the root — that is the overwhelming majority, and it is unambiguous. Otherwise
 * the shallowest folder that holds `.tf` files wins, with the conventional
 * non-module folders skipped: `examples/vpc` is Terraform, but it is a
 * demonstration of the module rather than the module.
 *
 * Returns "." when nothing is found, which is also what a repository containing
 * no Terraform at all should import as: an empty module, not a failure.
 */
export function detectTerraformRoot(treeEntries: TreeEntry[]): string {
  if (listTfFilesForFolder({ treeEntries, folder: "." }).length > 0) {
    return ".";
  }

  const skipped = new Set([
    "examples",
    "example",
    "test",
    "tests",
    "modules",
    ".github",
    "docs",
  ]);

  const candidates = new Set<string>();

  for (const entry of treeEntries) {
    if (entry.type !== "blob" || !entry.path.toLowerCase().endsWith(".tf")) {
      continue;
    }

    const segments = entry.path.split("/");
    // The file itself is the last segment, so anything shorter than two has
    // already been handled by the root check above.
    if (segments.length < 2) continue;

    const first = segments[0];
    if (!first || skipped.has(first.toLowerCase())) continue;

    candidates.add(segments.slice(0, -1).join("/"));
  }

  // Shallowest first, then alphabetically, so the choice is stable across
  // imports of the same repository rather than depending on tree order.
  const sorted = [...candidates].sort((left, right) => {
    const depth = left.split("/").length - right.split("/").length;
    return depth !== 0 ? depth : left.localeCompare(right);
  });

  return sorted[0] ?? ".";
}

/**
 * The submodule folders a repository conventionally exposes.
 *
 * Only `<root>/modules/<name>` with Terraform of its own, which is the layout the
 * whole `terraform-aws-modules` ecosystem uses and the one our own catalogue
 * follows. Deliberately not "every folder containing `.tf`": that would import
 * examples and test fixtures as modules, and a library full of `examples/complete`
 * is worse than one that missed an unconventional layout.
 */
export function detectSubmoduleFolders(
  treeEntries: TreeEntry[],
  rootFolder: string,
): string[] {
  const root = normalizeFolderPath(rootFolder) ?? ".";
  const container = root === "." ? "modules" : `${root}/modules`;

  return listDirectChildFolders({ treeEntries, folder: container }).filter(
    (folder) => listTfFilesForFolder({ treeEntries, folder }).length > 0,
  );
}

async function resolveSubmoduleFolders(params: {
  treeEntries: TreeEntry[];
  rootFolder: string;
  userProvided: string[];
}) {
  const rootNormalized = normalizeFolderPath(params.rootFolder) ?? ".";
  const candidates = (params.userProvided ?? [])
    .map((p) => normalizeFolderPath(p))
    .filter((p): p is string => !!p && p !== ".")
    .filter((p) => p !== rootNormalized);

  const out = new Set<string>();

  for (const c of candidates) {
    // If the folder itself contains Terraform, treat it as a module.
    const hasTf =
      listTfFilesForFolder({ treeEntries: params.treeEntries, folder: c })
        .length > 0;

    if (hasTf) {
      out.add(c);
      continue;
    }

    // Otherwise, treat as a container folder: create a submodule for each immediate
    // child folder that contains Terraform.
    const children = listDirectChildFolders({
      treeEntries: params.treeEntries,
      folder: c,
    });

    for (const child of children) {
      const childHasTf =
        listTfFilesForFolder({
          treeEntries: params.treeEntries,
          folder: child,
        }).length > 0;

      if (childHasTf) out.add(child);
    }
  }

  return [...out].sort();
}

/**
 * Imports one ref of one repository, creating or refreshing its module rows.
 *
 * Idempotent on `(sourceId, versionTag, terraformRootFolder)`: importing the same
 * ref twice refreshes the analysis rather than duplicating it, which is what lets
 * a moving ref like a branch be re-read and the catalogue be re-synced.
 *
 * Throws on a repository that cannot be read; callers map that to a status code.
 */
export async function importModuleFromGit(
  input: ImportModuleFromGitInput,
): Promise<ImportModuleFromGitResult> {
  const startedAt = performance.now();
  const { userId, token, repoFullName, refName } = input;

  const defaultName = repoFullName.split("/").pop() ?? repoFullName;

  // Persist a stable, non-empty version tag to the DB.
  // We store the human ref name (branch name or release tag) rather than a full refs/* string.
  const versionTag = refName;

  const url = `https://github.com/${repoFullName}.git?ref=${encodeURIComponent(versionTag)}`;
  const sourceName = (input.nameOverride?.trim() || defaultName).trim();
  const canonicalSourceUrl = canonicalRepoUrl(repoFullName);

  // Scoped by the owner being written, so a user importing a repository that is
  // also in the shipped catalogue gets their own source row rather than editing
  // the shared one. `userId: null` matches IS NULL here because Prisma turns an
  // explicit null in a filter into IS NULL — the equality-never-matches-NULL
  // rule that protects builtins elsewhere applies to a *string* userId.
  const existingSource = await database.terraformModuleSource.findFirst({
    where: { userId, url: canonicalSourceUrl },
    select: { id: true },
  });

  const timing: TimingSink = { fetchMs: 0, parseMs: 0, fileCount: 0 };

  // Before the source row is written, because the tree is what says whether the
  // repository ships an icon — and, since this rewrite, where its Terraform is.
  const tree = await timed(() =>
    fetchRepoTree({ token, repoFullName, ref: refName }),
  );
  const treeEntries = tree.value;

  // Detected when the caller says nothing, which is now the normal case: the
  // import dialog no longer asks. An explicit value still wins, because the
  // catalogue sync pins folders deliberately and a repository with an unusual
  // layout has to remain importable.
  const terraformRootFolder =
    normalizeFolderPath(input.terraformRootFolder) ??
    detectTerraformRoot(treeEntries);

  const providedSubmodules = (input.terraformSubmodulesFolders ?? [])
    .map((p) => normalizeFolderPath(p))
    .filter((p): p is string => !!p && p !== ".");

  const rawSubmodules =
    providedSubmodules.length > 0
      ? providedSubmodules
      : detectSubmoduleFolders(treeEntries, terraformRootFolder);

  const iconUrl = await resolveIconUrl({
    token,
    repoFullName,
    refName,
    defaultBranch: input.defaultBranch ?? null,
    treeEntries,
  });

  // A choice is written as a pair or not at all. Half of it — a mode of `aws`
  // with no name, or a name with no mode — would be a row that cannot be
  // rendered from its own contents.
  const icon = input.icon ?? null;

  const source = existingSource
    ? await database.terraformModuleSource.update({
        where: { id: existingSource.id },
        data: {
          name: sourceName,
          description: input.description?.trim() || null,
          tags: normalizeTags(input.tags),
          // `iconUrl` is detection, not preference: re-read on every import so an
          // icon added or removed upstream is picked up. The preference is only
          // touched when the caller actually expressed one.
          iconUrl,
          ...(icon ? { iconMode: icon.mode, iconName: icon.iconName } : {}),
        },
      })
    : await database.terraformModuleSource.create({
        data: {
          userId,
          name: sourceName,
          description: input.description?.trim() || null,
          tags: normalizeTags(input.tags),
          url: canonicalSourceUrl,
          provider: "github",
          iconUrl,
          // No choice on a first import means the repository's own icon, which is
          // what the schema default says and what the catalogue relies on.
          ...(icon ? { iconMode: icon.mode, iconName: icon.iconName } : {}),
        },
      });

  const terraformSubmodulesFolders = await resolveSubmoduleFolders({
    treeEntries,
    rootFolder: terraformRootFolder,
    userProvided: rawSubmodules,
  });

  const rootAnalysis = await analyzeFolder({
    token,
    repoFullName,
    refName,
    treeEntries,
    folder: terraformRootFolder,
    timing,
  });

  const submoduleAnalyses = await Promise.all(
    terraformSubmodulesFolders.map(async (folder) => {
      const analysis = await analyzeFolder({
        token,
        repoFullName,
        refName,
        treeEntries,
        folder,
        timing,
      });

      return { folder, analysis };
    }),
  );

  // Bracketed with timestamps rather than wrapped in `timed`, which would cost
  // the whole transaction body a level of indentation for one number.
  const dbStartedAt = performance.now();

  const created = await database.$transaction(
    async (tx) => {
      // Root module: idempotent on the unique (sourceId, versionTag, terraformRootFolder) tuple.
      const existingRoot = await tx.terraformModule.findFirst({
        where: {
          userId,
          sourceId: source.id,
          versionTag,
          terraformRootFolder,
        },
        select: { id: true },
      });

      // A re-import must refresh the analysis: the previous run may have been
      // produced by an older analyzer, or the ref may have moved (branches).
      const rootModule = existingRoot
        ? await tx.terraformModule.update({
            where: { id: existingRoot.id },
            data: {
              url,
              terraformSubmodulesFolders,
              variables: rootAnalysis.variables as unknown as Prisma.JsonArray,
              outputs: rootAnalysis.outputs as unknown as Prisma.JsonArray,
            },
          })
        : await tx.terraformModule.create({
            data: {
              userId,
              sourceId: source.id,
              // Root module display is derived from terraform_module_sources.
              submoduleName: null,
              versionTag,
              url,
              terraformRootFolder,
              terraformSubmodulesFolders,
              variables: rootAnalysis.variables as unknown as Prisma.JsonArray,
              outputs: rootAnalysis.outputs as unknown as Prisma.JsonArray,
              isSubmodule: false,
            },
          });

      const submodules: Array<{ id: string; terraformRootFolder: string }> = [];

      for (const {
        folder: subFolder,
        analysis: subAnalysis,
      } of submoduleAnalyses) {
        const existingSub = await tx.terraformModule.findFirst({
          where: {
            userId,
            sourceId: source.id,
            versionTag,
            terraformRootFolder: subFolder,
          },
          select: { id: true },
        });

        const sub = existingSub
          ? await tx.terraformModule.update({
              where: { id: existingSub.id },
              data: {
                url,
                parentModuleId: rootModule.id,
                variables: subAnalysis.variables as unknown as Prisma.JsonArray,
                outputs: subAnalysis.outputs as unknown as Prisma.JsonArray,
              },
            })
          : await tx.terraformModule.create({
              data: {
                userId,
                sourceId: source.id,
                // For imported submodules, store the folder basename as submodule_name.
                submoduleName: subFolder.split("/").pop() ?? subFolder,
                versionTag,
                url,
                terraformRootFolder: subFolder,
                terraformSubmodulesFolders: [],
                variables: subAnalysis.variables as unknown as Prisma.JsonArray,
                outputs: subAnalysis.outputs as unknown as Prisma.JsonArray,
                isSubmodule: true,
                parentModuleId: rootModule.id,
              },
            });

        await persistAnalysis(tx, sub.id, subAnalysis);
        submodules.push({ id: sub.id, terraformRootFolder: subFolder });
      }

      await persistAnalysis(tx, rootModule.id, rootAnalysis);

      return { rootModule, submodules };
    },
    // Analysis is done before the transaction opens, but resource rewrites
    // can still take a moment on large modules.
    { timeout: 30_000 },
  );

  const dbMs = performance.now() - dbStartedAt;

  return {
    module: created.rootModule,
    submodules: created.submodules,
    source,
    warnings: rootAnalysis.errors,
    timings: {
      totalMs: performance.now() - startedAt,
      treeMs: tree.ms,
      fetchMs: timing.fetchMs,
      parseMs: timing.parseMs,
      dbMs,
      fileCount: timing.fileCount,
      folderCount: 1 + terraformSubmodulesFolders.length,
    },
  };
}
