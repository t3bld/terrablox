/**
 * Imports the global module libraries: `pnpm db:library:sync`.
 *
 *   GITHUB_TOKEN=$(gh auth token) pnpm db:library:sync                    # every global library
 *   GITHUB_TOKEN=$(gh auth token) pnpm db:library:sync --library terrablox
 *   pnpm db:builtin:sync                                                  # alias for --library terrablox
 *
 * A thin wrapper over the same engine the dashboard uses (lib/module-library/
 * library-engine.ts): discover, optionally prune, import the default branch plus
 * the newest tag of each repository. Rows are written with a NULL owner and
 * `library = <id>`, so every user sees them while the library is visible.
 *
 * Independent of visibility on purpose: importing a hidden library is how an
 * operator prepares it before setting `"visible": true` on its entry.
 *
 * Per-user libraries (e.g. Porsche) cannot be imported here: they are read with
 * each user's own token, from the dashboard.
 *
 * Flags:
 *   --library <id>   only this library (repeatable)
 *   --changed-only   skip tags already imported (a tag never moves); the default
 *                    branch is always refreshed. Default re-imports every ref,
 *                    which also refreshes the analysis after an analyzer change
 *   --prune          delete sources the org no longer lists. Off by default:
 *                    removing a shared module removes it from every user's canvas
 *
 * The token needs no scopes for public repositories — it is required because
 * GitHub's unauthenticated rate limit cannot carry ~50 repositories.
 */
// Imported through the app's own module rather than `@terrablox/database`
// directly: pnpm only links a workspace package into the node_modules of the
// packages that depend on it, and `scripts/` depends on nothing.
import { prisma } from "@/lib/database";
import type { ImportTimings } from "@/lib/module-library/import-from-git";
import {
  type ModuleLibraryDefinition,
  moduleLibraries,
  TERRABLOX_LIBRARY_ID,
} from "@/lib/module-library/libraries";
import { syncGlobalLibrary } from "@/lib/module-library/library-engine";
import {
  SERVICE_NAMES,
  serviceSlug,
} from "@/lib/module-library/terrablox-catalogue";
import { resolveToken } from "./catalogue.mts";

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
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

function addTimings(into: ImportTimings, add: ImportTimings): void {
  for (const key of Object.keys(into) as Array<keyof ImportTimings>) {
    into[key] += add[key];
  }
}

function parseArgs(argv: string[]) {
  const ids: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--library") {
      const id = argv[i + 1];
      if (!id || id.startsWith("--")) {
        console.error("--library needs an id, e.g. --library terrablox");
        process.exit(2);
      }
      ids.push(id);
      i++;
    }
  }
  return {
    ids,
    changedOnly: argv.includes("--changed-only"),
    prune: argv.includes("--prune"),
  };
}

async function syncOne(
  library: ModuleLibraryDefinition,
  token: string,
  options: { changedOnly: boolean; prune: boolean },
): Promise<number> {
  const label = `${library.name} (${library.id})`;
  const selection = [
    library.prefix ? `named ${library.prefix}*` : null,
    library.topics.length ? `tagged ${library.topics.join(" + ")}` : null,
    library.publicOnly ? "public" : null,
  ]
    .filter(Boolean)
    .join(", ");

  console.log(
    `\n== ${label}: reading ${library.org} for repositories ${selection}…`,
  );
  if (!library.visible) {
    console.log(
      `   Hidden ("visible": false): importing anyway, nobody sees it until it is switched on.`,
    );
  }

  const totals = emptyTimings();
  const unnamed: string[] = [];
  const startedAt = performance.now();

  const result = await syncGlobalLibrary({
    library,
    token,
    mode: options.changedOnly ? "changed" : "all",
    prune: options.prune,
    onDiscovered: (repos) => {
      console.log(`   Found ${repos.length} repositories.\n`);
      if (library.id === TERRABLOX_LIBRARY_ID) {
        for (const repo of repos) {
          if (!SERVICE_NAMES[serviceSlug(repo.name, library.prefix ?? "")]) {
            unnamed.push(repo.name);
          }
        }
      }
    },
    onRef: ({ repo, index, total, refName, result: imported, error }) => {
      const position = `[${index + 1}/${total}]`;
      if (error || !imported) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `${position} ${repo.name} @ ${refName} FAILED — ${message}`,
        );
        return;
      }
      addTimings(totals, imported.timings);
      const submodules =
        imported.submodules.length > 0
          ? `, ${imported.submodules.length} submodules`
          : "";
      const warnings =
        imported.warnings.length > 0
          ? `, ${imported.warnings.length} file(s) unparsed`
          : "";
      console.log(
        `${position} ${repo.name} @ ${refName}${submodules}${warnings} — ${seconds(imported.timings.totalMs)}`,
      );
    },
  });

  if (result.repos.length === 0) {
    console.error(
      `   Nothing matched in ${library.org}. Check the org, the selection and that the token can see it.`,
    );
    return 1;
  }

  console.log(
    `\n   Imported ${result.imported} refs across ${result.repos.length} repositories in ${seconds(performance.now() - startedAt)}.` +
      (options.prune ? ` Pruned ${result.pruned} repositories.` : ""),
  );
  console.log(
    [
      "   Where the time went (summed, not wall clock):",
      `     tree listing  ${seconds(totals.treeMs)}`,
      `     file fetching ${seconds(totals.fetchMs)}`,
      `     HCL parsing   ${seconds(totals.parseMs)}`,
      `     database      ${seconds(totals.dbMs)}`,
      `     ${totals.fileCount} files across ${totals.folderCount} folders`,
    ].join("\n"),
  );

  if (unnamed.length > 0) {
    console.log(
      [
        "",
        `   ${unnamed.length} repositor${unnamed.length === 1 ? "y has" : "ies have"} no entry in SERVICE_NAMES and got a derived name:`,
        ...unnamed.map((name) => `     ${name}`),
        "   Add them to SERVICE_NAMES in apps/dashboard/src/lib/module-library/terrablox-catalogue.ts.",
      ].join("\n"),
    );
  }

  if (result.failures.length > 0) {
    console.log("\n   Failures:");
    for (const failure of result.failures) {
      console.log(`     ${failure.repo} @ ${failure.ref}: ${failure.message}`);
    }
  }

  const [modules, sources] = await Promise.all([
    prisma.terraformModule.count({
      where: { userId: null, library: library.id },
    }),
    prisma.terraformModuleSource.count({
      where: { userId: null, library: library.id },
    }),
  ]);
  console.log(
    `\n   ${library.name} now holds ${modules} module rows across ${sources} repositories.`,
  );

  return result.failures.length > 0 ? 1 : 0;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const all = moduleLibraries();
  const global = all.filter((library) => library.scope === "global");

  for (const id of options.ids) {
    const def = all.find((library) => library.id === id);
    if (!def) {
      console.error(
        `Unknown library '${id}'. Configured: ${all.map((l) => l.id).join(", ")}`,
      );
      process.exit(2);
    }
    if (def.scope !== "global") {
      console.error(
        `'${id}' is a per-user library: each user's copy is read with their own token from the dashboard, not here.`,
      );
      process.exit(2);
    }
  }

  const targets = options.ids.length
    ? global.filter((library) => options.ids.includes(library.id))
    : global;

  const token = resolveToken("pnpm db:library:sync");

  let exitCode = 0;
  for (const library of targets) {
    try {
      exitCode = Math.max(exitCode, await syncOne(library, token, options));
    } catch (error) {
      exitCode = 1;
      console.error(
        `\n${library.id} FAILED — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  await prisma.$disconnect();
  process.exit(exitCode);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
