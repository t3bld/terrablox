/**
 * Removes a global library's rows: `pnpm db:library:reset [--library <id>]`
 * (alias `db:builtin:reset`, which is the Terrablox catalogue — the default).
 *
 * For starting the catalogue over rather than patching it — after a rename, or
 * once the repositories themselves have changed enough that relinking would carry
 * stale analysis forward.
 *
 * Deletes only rows with a null owner and that library's id. A module a user imported themselves is
 * their work and cannot be recreated by a sync, so it is never in scope here; the
 * count of those is printed so it is visible that they survived.
 *
 * Everything hanging off a module — resources, dependencies, providers,
 * references, canvas nodes, saved layouts — goes with it through the foreign keys
 * already declared as `onDelete: Cascade`. Deleting the sources is therefore
 * enough, and doing it in one statement means there is no half-deleted state to
 * reason about.
 *
 * Pass --yes to skip the prompt, for a non-interactive shell.
 */

import { createInterface } from "node:readline/promises";

import { prisma } from "@/lib/database";
import {
  moduleLibraries,
  TERRABLOX_LIBRARY_ID,
} from "@/lib/module-library/libraries";
import { BUILTIN_USER_ID } from "@/lib/module-library/ownership";

const flag = process.argv.indexOf("--library");
const libraryId =
  flag >= 0 ? (process.argv[flag + 1] ?? "") : TERRABLOX_LIBRARY_ID;
const library = moduleLibraries().find((def) => def.id === libraryId);

// Unconfigured ids are allowed, so rows of a removed library can be cleaned up;
// per-user ones are not, because their rows belong to users.
if (library?.scope === "user") {
  console.error(
    `'${libraryId}' is a per-user library; its rows are each user's own copy.`,
  );
  process.exit(2);
}
if (!/^[a-z][a-z0-9-]{1,31}$/.test(libraryId)) {
  console.error("--library needs an id, e.g. --library terrablox");
  process.exit(2);
}

const scope = { userId: BUILTIN_USER_ID, library: libraryId };
const label = library?.name ?? libraryId;

const [sources, modules, userModules] = await Promise.all([
  prisma.terraformModuleSource.count({ where: scope }),
  prisma.terraformModule.count({ where: scope }),
  prisma.terraformModule.count({ where: { userId: { not: null } } }),
]);

if (sources === 0 && modules === 0) {
  console.log(`The ${label} library is already empty.`);
  await prisma.$disconnect();
  process.exit(0);
}

console.log(
  [
    `${label}: ${sources} repositories, ${modules} module rows.`,
    `Owned by users:    ${userModules} module rows — these are left alone.`,
    "",
    "Deleting also removes their resources, dependencies, references, canvas",
    "nodes and saved layouts. Re-running the sync rebuilds all of it from GitHub.",
  ].join("\n"),
);

if (!process.argv.includes("--yes")) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\nDelete the ${label} library? [y/N] `);
  rl.close();

  if (!/^y(es)?$/i.test(answer.trim())) {
    console.log("Nothing was deleted.");
    await prisma.$disconnect();
    process.exit(0);
  }
}

const removed = await prisma.terraformModuleSource.deleteMany({
  where: scope,
});

// Rows predating the sources table have no `sourceId`, so the cascade above
// cannot reach them.
const orphans = await prisma.terraformModule.deleteMany({
  where: scope,
});

console.log(
  `\nDeleted ${removed.count} repositories${
    orphans.count > 0 ? ` and ${orphans.count} module rows with no source` : ""
  }.`,
);
console.log(
  `\nRe-seed with:\n  GITHUB_TOKEN=$(gh auth token) pnpm db:library:sync --library ${libraryId}`,
);

await prisma.$disconnect();
