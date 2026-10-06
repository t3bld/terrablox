/**
 * Imports the module catalogue Terrablox ships with.
 *
 * Every repository named `terrablox-aws-*` in the configured GitHub org is
 * imported with a null owner, which makes it visible to every user without anyone
 * importing anything. Run it once per installation, and again whenever the
 * upstream modules should be refreshed:
 *
 *   GITHUB_TOKEN=$(gh auth token) pnpm db:builtin:sync
 *
 * Two refs per repository: the default branch, which follows upstream, and the
 * newest release tag, which does not. Users then choose in the version switcher
 * between tracking upstream and pinning. Re-running the sync updates the branch
 * rows in place — that is what "follows upstream" means — while a new upstream
 * release simply adds a version rather than moving an existing one.
 *
 * Idempotent, because the unique key is `(sourceId, versionTag,
 * terraformRootFolder)` and the pipeline updates rather than inserts on a hit.
 *
 * GitHub stays the source of truth: nothing is vendored, and the database holds
 * only the analysis, exactly as it does for a repository a user imports.
 *
 * The token needs no scopes for public repositories — it is required only because
 * GitHub's unauthenticated rate limit (60 requests an hour) cannot carry ~50
 * repositories, each of which costs a tree listing plus one request per `.tf`
 * file.
 */

// Imported through the app's own module rather than `@terrablox/database`
// directly: pnpm only links a workspace package into the node_modules of the
// packages that depend on it, and `scripts/` depends on nothing.
import { prisma } from "@/lib/database";
import {
  type ImportTimings,
  importModuleFromGit,
} from "@/lib/module-library/import-from-git";
import {
  BUILTIN_USER_ID,
  builtinModulesEnabled,
} from "@/lib/module-library/ownership";
// The catalogue's own vocabulary — which repositories, and what to call them —
// lives beside this file because the website's snapshot generator reads the same
// repositories and has to show the same names.
import {
  CATALOGUE_TAGS,
  type CatalogueRef,
  displayName,
  listCatalogueRepos,
  listRefs,
  ORG,
  PREFIX,
  resolveToken,
  SERVICE_NAMES,
  SUBMODULE_CONTAINER,
  serviceSlug,
} from "./catalogue.mts";

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Adds one import's figures into a running total. */
function addTimings(into: ImportTimings, add: ImportTimings): void {
  into.totalMs += add.totalMs;
  into.treeMs += add.treeMs;
  into.fetchMs += add.fetchMs;
  into.parseMs += add.parseMs;
  into.dbMs += add.dbMs;
  into.fileCount += add.fileCount;
  into.folderCount += add.folderCount;
}

function emptyTimings(): ImportTimings {
  return {
    totalMs: 0,
    treeMs: 0,
    fetchMs: 0,
    parseMs: 0,
    dbMs: 0,
    fileCount: 0,
    folderCount: 0,
  };
}

async function main() {
  if (!builtinModulesEnabled()) {
    console.error(
      [
        "TERRABLOX_BUILTIN_MODULES is false, so this instance does not offer the",
        "shipped catalogue and syncing it would write rows nothing would read.",
        "",
        "Remove the variable (it defaults to on) or set it to true, then re-run.",
      ].join("\n"),
    );
    process.exit(1);
  }

  const token = resolveToken("pnpm db:builtin:sync");

  console.log(`Reading ${ORG} for repositories named ${PREFIX}*…`);
  const repos = await listCatalogueRepos(token);

  if (repos.length === 0) {
    console.error(
      `No repositories named ${PREFIX}* found in ${ORG}. Check the org name and that the token can see it.`,
    );
    process.exit(1);
  }

  console.log(`Found ${repos.length} repositories.\n`);

  let importedRefs = 0;
  /** Repositories that fell back to a derived name; see {@link displayName}. */
  const unnamed: string[] = [];
  const failures: Array<{ repo: string; ref: string; message: string }> = [];
  const totals = emptyTimings();
  const startedAt = performance.now();

  // Sequential on purpose. Each repository is already a burst of parallel file
  // reads inside the pipeline, and running the repositories in parallel too
  // reliably trips GitHub's secondary rate limit.
  for (const [index, repo] of repos.entries()) {
    const position = `[${index + 1}/${repos.length}]`;

    if (!SERVICE_NAMES[serviceSlug(repo.name)]) {
      unnamed.push(repo.name);
    }

    let refs: CatalogueRef[];
    try {
      refs = await listRefs(token, repo);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ repo: repo.full_name, ref: "(refs)", message });
      console.error(
        `${position} ${repo.name} FAILED to list refs — ${message}`,
      );
      continue;
    }

    for (const { refName, refType } of refs) {
      try {
        const result = await importModuleFromGit({
          userId: BUILTIN_USER_ID,
          token,
          repoFullName: repo.full_name,
          refType,
          refName,
          terraformRootFolder: ".",
          terraformSubmodulesFolders: [SUBMODULE_CONTAINER],
          nameOverride: displayName(repo.name),
          description: repo.description,
          tags: CATALOGUE_TAGS,
          // Already known from listing the org, and the icon lookup would
          // otherwise re-ask GitHub for it once per ref.
          defaultBranch: repo.default_branch,
        });

        importedRefs++;
        addTimings(totals, result.timings);

        const t = result.timings;
        const submodules =
          result.submodules.length > 0
            ? `, ${result.submodules.length} submodules`
            : "";
        const warnings =
          result.warnings.length > 0
            ? `, ${result.warnings.length} file(s) unparsed`
            : "";

        // One line per ref, kept to what a watching human can read: which repo,
        // which ref, how long. The per-phase timings still land in the summary
        // totals at the end, where they are actually comparable.
        console.log(
          `${position} ${repo.name} @ ${refName}${submodules}${warnings}` +
            ` — ${seconds(t.totalMs)}`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ repo: repo.full_name, ref: refName, message });
        // Kept going: one unreadable ref should not cost the other hundred.
        console.error(
          `${position} ${repo.name} @ ${refName} FAILED — ${message}`,
        );
      }
    }
  }

  const wallMs = performance.now() - startedAt;

  console.log(
    `\nImported ${importedRefs} refs across ${repos.length} repositories in ${seconds(wallMs)}.`,
  );

  // fetch and parse overlap each other, because folders are analysed
  // concurrently, so these are sums of work rather than slices of the wall
  // clock. The point is the ratio: it says whether fetching or parsing is worth
  // attacking.
  console.log(
    [
      "Where the time went (summed, not wall clock):",
      `  tree listing  ${seconds(totals.treeMs)}`,
      `  file fetching ${seconds(totals.fetchMs)}`,
      `  HCL parsing   ${seconds(totals.parseMs)}`,
      `  database      ${seconds(totals.dbMs)}`,
      `  ${totals.fileCount} files across ${totals.folderCount} folders`,
    ].join("\n"),
  );

  if (unnamed.length > 0) {
    console.log(
      [
        "",
        `${unnamed.length} repositor${unnamed.length === 1 ? "y has" : "ies have"} no entry in SERVICE_NAMES and got a derived name:`,
        ...unnamed.map((name) => `  ${name} -> ${displayName(name)}`),
        "",
        "Add them to SERVICE_NAMES in scripts/seed-builtin-modules/catalogue.mts.",
      ].join("\n"),
    );
  }

  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const failure of failures) {
      console.log(`  ${failure.repo} @ ${failure.ref}: ${failure.message}`);
    }
  }

  const [modules, sources] = await Promise.all([
    prisma.terraformModule.count({ where: { userId: BUILTIN_USER_ID } }),
    prisma.terraformModuleSource.count({ where: { userId: BUILTIN_USER_ID } }),
  ]);
  console.log(
    `\nThe catalogue now holds ${modules} module rows across ${sources} repositories.`,
  );

  await prisma.$disconnect();
  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
