/**
 * Writes the shipped module catalogue as a committed snapshot.
 *
 *   GITHUB_TOKEN=$(gh auth token) pnpm catalogue:snapshot
 *
 * Lands in `packages/catalogue` rather than in either app, because it has two readers
 * that cannot see each other. The marketing site is a static export on GitHub Pages:
 * no server, so nothing that could hold a database connection — a snapshot is not a
 * shortcut around a live read there, it is the only shape available, and the
 * alternative to real module names is a count, which tells a visitor scanning for
 * `rds-aurora` nothing. The MCP server has the same problem for a different reason: it
 * runs inside somebody else's editor and can reach neither our database nor our repos.
 *
 * Read from the repositories rather than from a seeded database, which is the whole
 * point of this script existing next to `seed-builtin-modules`. The two share their
 * vocabulary through `catalogue.mts` and diverge in what they do with it: the seed
 * writes rows, this writes a file. Neither needs the other to have run, so nobody
 * has to keep a seeded instance around to publish the site.
 *
 * Icons are downloaded rather than linked. A `raw.githubusercontent.com` URL in the
 * page would work — the repositories are public — but it makes a marketing page
 * depend on fifty external requests and breaks the moment an `icon.png` is renamed
 * upstream. Bytes in `public/` cannot break.
 *
 * Only the shipped catalogue is ever read: `terrablox-aws-*` in one public org. A
 * module a user imported into their own library is private and cannot reach this
 * file, which is a property of where the data comes from rather than a filter that
 * could be forgotten.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { listRepoTree, readRepoFile } from "@terrablox/git/files";
import {
  type ArchitectureEdge,
  buildArchitecture,
} from "@terrablox/terraform/architecture-graph";
import {
  layoutArchitecture,
  type PositionedNode,
} from "@terrablox/terraform/architecture-layout";
import {
  iconOfService,
  serviceOfResource,
} from "@terrablox/terraform/aws-services";
import { analyzeTerraformFiles } from "@/lib/module-library/analyze";
import { REPO_ICON_FILES } from "@/lib/module-library/icon";

import {
  displayName,
  type GithubRepo,
  listCatalogueRepos,
  listRefs,
  ORG,
  PREFIX,
  resolveToken,
  SERVICE_NAMES,
  serviceSlug,
} from "./seed-builtin-modules/catalogue.mts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SNAPSHOT_FILE = path.join(
  REPO_ROOT,
  "packages/catalogue/src/entries.generated.ts",
);
const ICON_DIR = path.join(REPO_ROOT, "apps/website/public/module-icons");

/**
 * Where the AWS service icons come from, and where the site needs them.
 *
 * Copied rather than duplicated wholesale: the dashboard vendors 810 of them, and
 * the architecture diagrams here reference a few dozen. Only the referenced ones are
 * copied, and only when missing — the landing page already put a handful in that
 * folder for its own diagram, and wiping it would take those with it.
 */
const AWS_ICON_SOURCE = path.join(REPO_ROOT, "apps/dashboard/public/aws-icons");
const AWS_ICON_TARGET = path.join(REPO_ROOT, "apps/website/public/aws-icons");

/**
 * How many inputs and outputs a module contributes to the snapshot.
 *
 * The `iam` module declares hundreds, and all of them in one file would make the
 * page a wall of names nobody reads and the snapshot a megabyte nobody diffs. The
 * required ones come first and are never cut, because those are the ones a reader
 * is deciding about; the rest are truncated with a count, and the source repository
 * is one click away for anyone who needs the full list.
 */
const PORT_LIMIT = 40;

interface SnapshotPort {
  name: string;
  type: string | null;
  required: boolean;
  description: string | null;
  default: string | null;
}

interface SnapshotModule {
  slug: string;
  name: string;
  description: string | null;
  repo: string;
  version: string;
  /** File name under `public/module-icons`, or null when the repo ships none. */
  icon: string | null;
  inputs: SnapshotPort[];
  outputs: Array<{ name: string; description: string | null }>;
  /** Truncation counts, so the page can say how much it is not showing. */
  omitted: { inputs: number; outputs: number };
  /** Terraform resource types the module creates, deduplicated and sorted. */
  resources: string[];
  /** Submodule folder names, which are modules in their own right upstream. */
  submodules: string[];
  /**
   * The architecture diagram, already projected and laid out.
   *
   * Stored computed rather than as the resources and references it was built from,
   * which is the one place this snapshot freezes something it could recompute. The
   * reason is size: the inputs are five times the output — 46 KB against 9 KB for
   * the VPC module — and the layout is deterministic, so freezing it loses nothing
   * a rebuild would restore.
   *
   * The cost classification goes the other way, computed in the page at build time,
   * because that table changes and the site must not disagree with the product about
   * what bills. The asymmetry is deliberate: a change to `buildArchitecture` needs a
   * regenerated snapshot to reach these pages.
   */
  architecture: { nodes: PositionedNode[]; edges: ArchitectureEdge[] } | null;
}

function short(value: unknown, max = 300): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** A default rendered for reading, not for pasting into HCL. */
function renderDefault(value: unknown): string | null {
  if (value === undefined) return null;
  if (value === null) return "null";
  if (typeof value === "string") return value === "" ? '""' : value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  // Objects and lists are shown as their shape rather than their contents: a
  // forty-key default is not information at this size.
  if (Array.isArray(value)) return value.length === 0 ? "[]" : "[…]";
  return Object.keys(value as object).length === 0 ? "{}" : "{…}";
}

/** The `.tf` files directly inside one folder, from an already-listed tree. */
function tfFilesIn(
  entries: Array<{ path: string; type: string }>,
  folder: string,
): string[] {
  const prefix = folder === "." ? "" : `${folder}/`;

  return entries
    .filter((entry) => entry.type === "blob")
    .map((entry) => entry.path)
    .filter((file) => file.startsWith(prefix) && file.endsWith(".tf"))
    .filter((file) => !file.slice(prefix.length).includes("/"));
}

/** Folder names under `modules/`, which upstream treats as submodules. */
function submoduleNames(
  entries: Array<{ path: string; type: string }>,
): string[] {
  const found = new Set<string>();

  for (const entry of entries) {
    const match = entry.path.match(/^modules\/([^/]+)\//);
    if (match?.[1]) found.add(match[1]);
  }

  return [...found].sort();
}

/**
 * Downloads the repository's icon, if it ships one.
 *
 * Looked for on the **default branch** rather than on the pinned tag, which is the
 * one thing about this that is not obvious: these repositories are forks, the icon
 * was added by the fork, and the tags point at upstream commits from before it
 * existed. Reading the tag's tree finds nothing for all fifty of them — which is
 * exactly why the importer resolves icons against the default branch too.
 *
 * `REPO_ICON_FILES` rather than a pattern of our own, so this cannot start
 * accepting something the product would not. It is `icon.png` only: the dashboard
 * serves repository icons through a proxy that refuses SVG, because an SVG carries
 * script and would run against the session cookie.
 *
 * Saved as `<slug>.png`, so the page needs no mapping and a rename upstream changes
 * nothing on this side.
 */
async function saveIcon(
  token: string,
  repo: GithubRepo,
  slug: string,
): Promise<string | null> {
  for (const candidate of REPO_ICON_FILES) {
    const response = await fetch(
      `https://raw.githubusercontent.com/${repo.full_name}/${encodeURIComponent(
        repo.default_branch,
      )}/${candidate}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    if (!response.ok) continue;

    const extension = candidate.split(".").pop() ?? "png";
    const name = `${slug}.${extension}`;

    writeFileSync(
      path.join(ICON_DIR, name),
      Buffer.from(await response.arrayBuffer()),
    );

    return name;
  }

  return null;
}

async function snapshotRepo(
  token: string,
  repo: GithubRepo,
): Promise<SnapshotModule | null> {
  const refs = await listRefs(token, repo);

  // The pinned tag, not the branch: a snapshot that advertised a moving ref would
  // be telling visitors a version number that means nothing next week.
  const pinned = refs.find((ref) => ref.refType === "tag") ?? refs[0];
  if (!pinned) return null;

  const tree = await listRepoTree(token, {
    repoFullName: repo.full_name,
    ref: pinned.refName,
  });

  const slug = serviceSlug(repo.name);
  const files = tfFilesIn(tree.entries, ".");

  const sources = (
    await Promise.all(
      files.map(async (file) => {
        const read = await readRepoFile(token, {
          repoFullName: repo.full_name,
          path: file,
          ref: pinned.refName,
        });

        return read ? { path: file, content: read.content } : null;
      }),
    )
  ).filter((file): file is { path: string; content: string } => file !== null);

  const analysis = await analyzeTerraformFiles(sources);

  // Required first, then alphabetical. The order is the reading order: what a
  // module insists on knowing comes before what it will guess.
  const allInputs = [...analysis.variables]
    .sort(
      (a, b) =>
        Number(b.required ?? false) - Number(a.required ?? false) ||
        a.name.localeCompare(b.name),
    )
    .map(
      (variable): SnapshotPort => ({
        name: variable.name,
        type: short(variable.type, 80),
        required: Boolean(variable.required),
        description: short(variable.description),
        default: renderDefault(variable.default),
      }),
    );

  const allOutputs = [...analysis.outputs]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((output) => ({
      name: output.name,
      description: short(output.description),
    }));

  const resources = [
    ...new Set(
      analysis.resources
        .filter((entry) => entry.kind === "resource")
        .map((entry) => entry.type)
        .filter((type): type is string => typeof type === "string"),
    ),
  ].sort();

  /**
   * The same projection the product draws, from the same functions.
   *
   * The field names are the one thing that has to be translated: the analysis calls
   * them `type`/`name`/`provider`, and `buildArchitecture` wants
   * `resourceType`/`resourceName`/`providerName` — the shape the database columns
   * use. `persist-analysis.ts` performs exactly this mapping on its way into
   * Postgres, and getting it wrong is silent: every field arrives as `undefined`, no
   * resource matches anything, and the graph comes back with zero nodes rather than
   * an error.
   */
  const architectureResources = analysis.resources.map((entry) => ({
    kind: entry.kind,
    resourceType: entry.type,
    resourceName: entry.name,
    providerName: entry.provider,
    conditionalOn: entry.conditionalOn ?? null,
    availabilityZone: entry.availabilityZone ?? null,
  }));

  const graph = buildArchitecture(
    architectureResources,
    analysis.references,
    analysis.moduleCalls.map((call) => ({
      name: call.name,
      source: call.source,
      version: call.version,
      sourceKind: call.sourceKind,
    })),
  );

  const architecture = graph.nodes.length
    ? {
        nodes: layoutArchitecture(graph.nodes, graph.edges),
        edges: graph.edges,
      }
    : null;

  return {
    slug,
    name: displayName(repo.name),
    description: short(repo.description, 400),
    repo: repo.full_name,
    version: pinned.refName,
    icon: await saveIcon(token, repo, slug),
    inputs: allInputs.slice(0, PORT_LIMIT),
    outputs: allOutputs.slice(0, PORT_LIMIT),
    omitted: {
      inputs: Math.max(0, allInputs.length - PORT_LIMIT),
      outputs: Math.max(0, allOutputs.length - PORT_LIMIT),
    },
    resources,
    submodules: submoduleNames(tree.entries),
    architecture,
  };
}

/**
 * Copies the AWS service icons the diagrams actually name.
 *
 * Collected from the nodes rather than guessed from resource types, because the
 * projection decides which service a box belongs to and an attachment badge carries
 * its own icon. Missing files are counted rather than thrown: an icon the manifest
 * does not vendor should cost a box its picture, not the whole snapshot.
 */
function copyAwsIcons(modules: SnapshotModule[]): {
  copied: number;
  missing: string[];
} {
  const wanted = new Set<string>();

  const collect = (value: unknown): void => {
    if (!value || typeof value !== "object") return;

    if (Array.isArray(value)) {
      for (const item of value) collect(item);
      return;
    }

    for (const [key, item] of Object.entries(value)) {
      if (key === "icon" && typeof item === "string" && item) wanted.add(item);
      else collect(item);
    }
  };

  for (const module of modules) {
    collect(module.architecture);

    // The costs view draws one icon per resource type, resolved through the service
    // it belongs to. Those names overlap the diagram's but are not a subset: a
    // supporting resource folded into a box on the diagram still gets its own row
    // and its own icon there.
    for (const type of module.resources) {
      const icon = iconOfService(serviceOfResource(type, "aws"));
      if (icon) wanted.add(icon);
    }
  }

  mkdirSync(AWS_ICON_TARGET, { recursive: true });

  let copied = 0;
  const missing: string[] = [];

  for (const name of [...wanted].sort()) {
    const from = path.join(AWS_ICON_SOURCE, `${name}.svg`);
    const to = path.join(AWS_ICON_TARGET, `${name}.svg`);

    if (existsSync(to)) continue;
    if (!existsSync(from)) {
      missing.push(name);
      continue;
    }

    copyFileSync(from, to);
    copied++;
  }

  return { copied, missing };
}

function renderSnapshot(modules: SnapshotModule[]): string {
  return `// Generated by \`pnpm catalogue:snapshot\`. Do not edit by hand.
//
// The shipped module catalogue, read from the \`${PREFIX}*\` repositories in the
// \`${ORG}\` org and committed so it can be served without a database. Two readers
// depend on that: the marketing site is a static export with nowhere to hold a
// connection, and the MCP server runs in somebody else's editor with no access to
// ours. Regenerate when the catalogue changes; the version numbers are pinned tags,
// so this goes stale slowly.
//
// Generated: ${new Date().toISOString().slice(0, 10)}

import type { ArchitectureEdge } from "@terrablox/terraform/architecture-graph";
import type { PositionedNode } from "@terrablox/terraform/architecture-layout";

export interface CataloguePort {
  name: string;
  type: string | null;
  required: boolean;
  description: string | null;
  default: string | null;
}

export interface CatalogueOutput {
  name: string;
  description: string | null;
}

export interface CatalogueArchitecture {
  /**
   * Positioned nodes, exactly as \`layoutArchitecture\` returned them.
   *
   * Not the diagram's own node type: that one is a translation of this — \`type\`
   * becomes \`frame\`, an attachment's addresses become a count — and the
   * translation belongs next to the component that needs it, not in generated data.
   */
  nodes: PositionedNode[];
  edges: ArchitectureEdge[];
}

export interface CatalogueEntry {
  slug: string;
  name: string;
  description: string | null;
  repo: string;
  version: string;
  icon: string | null;
  inputs: CataloguePort[];
  outputs: CatalogueOutput[];
  omitted: { inputs: number; outputs: number };
  resources: string[];
  submodules: string[];
  architecture: CatalogueArchitecture | null;
}

export const CATALOGUE_ENTRIES: CatalogueEntry[] = ${JSON.stringify(
    modules,
    null,
    2,
  )};
`;
}

async function main() {
  const token = resolveToken("pnpm catalogue:snapshot");

  console.log(`Reading ${ORG} for repositories named ${PREFIX}*…`);
  const repos = await listCatalogueRepos(token);

  if (repos.length === 0) {
    console.error(`No repositories named ${PREFIX}* found in ${ORG}.`);
    process.exit(1);
  }

  console.log(`Found ${repos.length} repositories.\n`);

  // Emptied rather than merged, so an icon whose repository left the catalogue
  // does not stay in `public/` forever.
  rmSync(ICON_DIR, { recursive: true, force: true });
  mkdirSync(ICON_DIR, { recursive: true });

  const modules: SnapshotModule[] = [];
  const unnamed: string[] = [];
  const failures: Array<{ repo: string; message: string }> = [];

  // Sequential, for the reason the seed script is: each repository is already a
  // burst of parallel file reads, and running the repositories in parallel too
  // trips GitHub's secondary rate limit.
  for (const [index, repo] of repos.entries()) {
    const position = `[${index + 1}/${repos.length}]`;

    if (!SERVICE_NAMES[serviceSlug(repo.name)]) unnamed.push(repo.name);

    try {
      const module = await snapshotRepo(token, repo);
      if (!module) continue;

      modules.push(module);
      console.log(
        `${position} ${module.slug} @ ${module.version} — ` +
          `${module.inputs.length} inputs, ${module.outputs.length} outputs, ` +
          `${module.resources.length} resource types` +
          `${module.icon ? "" : ", no icon"}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ repo: repo.full_name, message });
      // Kept going: one unreadable repository should not cost the other forty-nine.
      console.error(`${position} ${repo.name} FAILED — ${message}`);
    }
  }

  modules.sort((a, b) => a.slug.localeCompare(b.slug));
  writeFileSync(SNAPSHOT_FILE, renderSnapshot(modules));

  const icons = copyAwsIcons(modules);

  console.log(
    `\nWrote ${modules.length} modules to ${path.relative(REPO_ROOT, SNAPSHOT_FILE)}.`,
  );
  console.log(
    `Module icons: ${modules.filter((m) => m.icon).length}/${modules.length} in ${path.relative(REPO_ROOT, ICON_DIR)}.`,
  );
  console.log(
    `Diagrams: ${modules.filter((m) => m.architecture).length}/${modules.length}, ` +
      `${icons.copied} new AWS icon(s) copied.`,
  );

  if (icons.missing.length > 0) {
    console.log(
      `\n${icons.missing.length} icon(s) named by a diagram are not vendored: ${icons.missing.join(", ")}`,
    );
  }

  if (unnamed.length > 0) {
    console.log(
      `\n${unnamed.length} repositor${unnamed.length === 1 ? "y has" : "ies have"} no SERVICE_NAMES entry:`,
    );
    for (const name of unnamed)
      console.log(`  ${name} -> ${displayName(name)}`);
  }

  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const failure of failures) {
      console.log(`  ${failure.repo}: ${failure.message}`);
    }
  }

  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
