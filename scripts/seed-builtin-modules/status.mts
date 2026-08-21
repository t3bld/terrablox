/**
 * Reports the state of the shipped catalogue: `pnpm db:builtin:status`.
 *
 * Exists because the answer lives in two places that can disagree — the database
 * holds the rows, `TERRABLOX_BUILTIN_MODULES` decides whether anyone can see
 * them — and "the modules are missing" is the same symptom either way. Printing
 * both together turns that into a one-line diagnosis.
 */

import { prisma } from "@/lib/database";
import {
  BUILTIN_USER_ID,
  builtinModulesEnabled,
} from "@/lib/modules/ownership";

const enabled = builtinModulesEnabled();
const raw = process.env.TERRABLOX_BUILTIN_MODULES?.trim();

const [sources, roots, submodules] = await Promise.all([
  prisma.terraformModuleSource.count({ where: { userId: BUILTIN_USER_ID } }),
  prisma.terraformModule.count({
    where: { userId: BUILTIN_USER_ID, isSubmodule: false },
  }),
  prisma.terraformModule.count({
    where: { userId: BUILTIN_USER_ID, isSubmodule: true },
  }),
]);

console.log(
  `TERRABLOX_BUILTIN_MODULES: ${raw ?? "(unset, defaults to true)"} -> ${
    enabled ? "enabled" : "disabled"
  }`,
);
console.log(
  `Installed: ${sources} repositories, ${roots} versions, ${submodules} submodules`,
);

if (enabled && sources === 0) {
  console.log(
    "\nThe catalogue is enabled but nothing is installed. Run:\n  GITHUB_TOKEN=$(gh auth token) pnpm db:builtin:sync",
  );
}

if (!enabled && sources > 0) {
  // Deliberately not deleted when the flag goes off, so turning it back on is
  // instant rather than another sync. The rows are inert while hidden.
  console.log(
    [
      "",
      "The catalogue is installed but hidden, so no user can see these modules.",
      "Any project whose Terraform already calls one will show it as a node with",
      "no inputs or outputs, because the graph resolves module blocks against the",
      "library it can see.",
      "",
      "Set TERRABLOX_BUILTIN_MODULES=true to show them again — the rows are still",
      "there, so nothing needs re-importing.",
    ].join("\n"),
  );
}

await prisma.$disconnect();
