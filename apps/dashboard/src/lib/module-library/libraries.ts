import "server-only";

import { database } from "@/lib/database";
import {
  type LibraryLabel,
  type LibraryScope,
  type ModuleLibraryDefinition,
  normalizeModuleLibraryDefinition,
} from "./library-definition";

function toDefinition(row: {
  id: string;
  name: string;
  scope: string;
  visible: boolean;
  org: string;
  topics: string[];
  prefix: string | null;
  publicOnly: boolean;
  submoduleContainer: string | null;
  pipelineSecret: string;
}): ModuleLibraryDefinition {
  return normalizeModuleLibraryDefinition({
    id: row.id,
    name: row.name,
    scope: row.scope,
    visible: row.visible,
    org: row.org,
    topics: row.topics,
    prefix: row.prefix ?? undefined,
    publicOnly: row.publicOnly,
    submoduleContainer: row.submoduleContainer ?? undefined,
    pipelineSecret: row.pipelineSecret,
  });
}

/** Every active library, including hidden ones, in stable operator order. */
export async function moduleLibraries(): Promise<ModuleLibraryDefinition[]> {
  const rows = await database.moduleLibraryDefinition.findMany({
    where: { active: true },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
  });
  return rows.map(toDefinition);
}

/** Finds one active definition by its stable row id. */
export async function findModuleLibrary(
  id: string,
): Promise<ModuleLibraryDefinition | undefined> {
  const row = await database.moduleLibraryDefinition.findFirst({
    where: { id, active: true },
  });
  return row ? toDefinition(row) : undefined;
}

/** Active, visible libraries of one scope in stable operator order. */
export async function visibleLibraries(
  scope: LibraryScope,
): Promise<ModuleLibraryDefinition[]> {
  const rows = await database.moduleLibraryDefinition.findMany({
    where: { active: true, visible: true, scope },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
  });
  return rows.map(toDefinition);
}

export async function visibleLibraryIds(
  scope: LibraryScope,
): Promise<string[]> {
  const rows = await database.moduleLibraryDefinition.findMany({
    where: { active: true, visible: true, scope },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

/** Loads all active labels in one query for list/detail mapping without N+1 reads. */
export async function moduleLibraryLabels(): Promise<
  ReadonlyMap<string, LibraryLabel>
> {
  const rows = await database.moduleLibraryDefinition.findMany({
    where: { active: true },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    select: { id: true, name: true },
  });
  return new Map(rows.map((row): [string, LibraryLabel] => [row.id, row]));
}
