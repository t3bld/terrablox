/**
 * Removes the shipped catalogue: `pnpm db:builtin:reset`.
 *
 * For starting the catalogue over rather than patching it — after a rename, or
 * once the repositories themselves have changed enough that relinking would carry
 * stale analysis forward.
 *
 * Deletes only rows with a null owner. A module a user imported themselves is
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
import { BUILTIN_USER_ID } from "@/lib/modules/ownership";

const [sources, modules, userModules] = await Promise.all([
  prisma.terraformModuleSource.count({ where: { userId: BUILTIN_USER_ID } }),
  prisma.terraformModule.count({ where: { userId: BUILTIN_USER_ID } }),
  prisma.terraformModule.count({ where: { userId: { not: null } } }),
]);

if (sources === 0 && modules === 0) {
  console.log("The shipped catalogue is already empty.");
  await prisma.$disconnect();
  process.exit(0);
}

console.log(
  [
    `Shipped catalogue: ${sources} repositories, ${modules} module rows.`,
    `Owned by users:    ${userModules} module rows — these are left alone.`,
    "",
    "Deleting also removes their resources, dependencies, references, canvas",
    "nodes and saved layouts. Re-running the sync rebuilds all of it from GitHub.",
  ].join("\n"),
);

if (!process.argv.includes("--yes")) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("\nDelete the shipped catalogue? [y/N] ");
  rl.close();

  if (!/^y(es)?$/i.test(answer.trim())) {
    console.log("Nothing was deleted.");
    await prisma.$disconnect();
    process.exit(0);
  }
}

const removed = await prisma.terraformModuleSource.deleteMany({
  where: { userId: BUILTIN_USER_ID },
});

// Rows predating the sources table have no `sourceId`, so the cascade above
// cannot reach them.
const orphans = await prisma.terraformModule.deleteMany({
  where: { userId: BUILTIN_USER_ID },
});

console.log(
  `\nDeleted ${removed.count} repositories${
    orphans.count > 0 ? ` and ${orphans.count} module rows with no source` : ""
  }.`,
);
console.log(
  "\nRe-seed with:\n  GITHUB_TOKEN=$(gh auth token) pnpm db:builtin:sync",
);

await prisma.$disconnect();
