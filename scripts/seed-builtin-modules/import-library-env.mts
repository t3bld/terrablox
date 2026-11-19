import { prisma } from "@/lib/database";
import { normalizeModuleLibraryDefinition } from "@/lib/module-library/library-definition";

const ENV_NAME = "TERRABLOX_MODULE_LIBRARIES";

function definitionsFromEnvironment() {
  const raw = process.env[ENV_NAME];
  if (raw === undefined || raw.trim() === "") {
    throw new Error(`${ENV_NAME} is not set. Nothing was imported.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${ENV_NAME} is not valid JSON.`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${ENV_NAME} must be a JSON array.`);
  }

  const definitions = parsed.map((entry, index) => {
    try {
      return normalizeModuleLibraryDefinition(entry);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${ENV_NAME}[${index}] is invalid: ${reason}`);
    }
  });

  const ids = new Set<string>();
  const organizations = new Set<string>();
  for (const definition of definitions) {
    if (ids.has(definition.id)) {
      throw new Error(`${ENV_NAME} contains duplicate id '${definition.id}'.`);
    }
    const organization = `${definition.scope}:${definition.org.toLowerCase()}`;
    if (organizations.has(organization)) {
      throw new Error(
        `${ENV_NAME} contains more than one ${definition.scope} library for '${definition.org}'.`,
      );
    }
    ids.add(definition.id);
    organizations.add(organization);
  }

  return definitions;
}

async function main() {
  const definitions = definitionsFromEnvironment();

  await prisma.$transaction(async (tx) => {
    // This is an explicit one-time migration command. Deactivate first so an
    // archived/default definition cannot conflict with the old environment's
    // organisation before the desired rows are restored below.
    await tx.moduleLibraryDefinition.updateMany({
      data: { active: false, visible: false },
    });

    for (const [sortOrder, definition] of definitions.entries()) {
      await tx.moduleLibraryDefinition.upsert({
        where: { id: definition.id },
        create: { ...definition, active: true, sortOrder },
        update: { ...definition, active: true, sortOrder },
      });
    }

    // Definition filters or submodule structure may have changed. A `never`
    // sync runs one full re-import before private rows become visible again.
    await tx.moduleLibrarySync.updateMany({
      data: {
        state: "never",
        pending: false,
        repos: {},
        lastAttemptAt: null,
        lockId: null,
        lockedUntil: null,
      },
    });
  });

  console.log(
    `Imported ${definitions.length} module library definition${definitions.length === 1 ? "" : "s"} from ${ENV_NAME}. Remove the variable before making changes in Admin Settings.`,
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
