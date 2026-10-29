/**
 * Reports every module library: `pnpm db:library:status` (alias
 * `db:builtin:status`).
 *
 * Exists because the answer lives in two places that can disagree — the database
 * holds the rows, the entry's `visible` flag decides whether anyone can see
 * them — and "the modules are missing" is the same symptom either way. Printing
 * both together turns that into a one-line diagnosis per library.
 */
import { prisma } from "@/lib/database";
import { moduleLibraries } from "@/lib/module-library/libraries";

const libraries = moduleLibraries();
const configured = new Set(libraries.map((library) => library.id));
let hiddenWithRows = false;

for (const library of libraries) {
  const owner = library.scope === "global" ? null : { not: null };
  const [sources, roots, submodules, users] = await Promise.all([
    prisma.terraformModuleSource.count({
      where: { library: library.id, userId: owner },
    }),
    prisma.terraformModule.count({
      where: { library: library.id, userId: owner, isSubmodule: false },
    }),
    prisma.terraformModule.count({
      where: { library: library.id, userId: owner, isSubmodule: true },
    }),
    library.scope === "user"
      ? prisma.moduleLibrarySync.count({ where: { library: library.id } })
      : Promise.resolve(0),
  ]);

  const { visible } = library;

  console.log(
    `\n${library.name} (${library.id}) — ${library.scope}, ${library.org}`,
  );
  console.log(visible ? "  visible" : '  hidden ("visible": false)');
  console.log(
    library.scope === "global"
      ? `  Installed: ${sources} repositories, ${roots} versions, ${submodules} submodules`
      : `  Synced: ${users} user(s), ${sources} repository copies, ${roots} versions, ${submodules} submodules`,
  );

  if (library.scope === "global" && visible && sources === 0) {
    console.log(
      `  Visible but nothing is installed. Run:\n    GITHUB_TOKEN=$(gh auth token) pnpm db:library:sync --library ${library.id}`,
    );
  }
  if (!visible && sources > 0) hiddenWithRows = true;
}

// Rows of a library that is no longer configured are inert: no read path admits
// an unknown id. Worth saying, because they still take space.
const orphaned = await prisma.terraformModuleSource.groupBy({
  by: ["library"],
  where: { library: { notIn: [...configured] } },
  _count: { _all: true },
});
for (const row of orphaned) {
  console.log(
    `\n${row.library}: ${row._count._all} repositories from a library that is no longer configured — invisible to everyone.`,
  );
}

if (hiddenWithRows) {
  console.log(
    [
      "",
      "A hidden library keeps its rows, so turning it back on is instant. While it",
      "is hidden, a project whose Terraform calls one of its modules shows that",
      "call as a node with no inputs or outputs.",
    ].join("\n"),
  );
}

await prisma.$disconnect();
