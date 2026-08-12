import "server-only";

import type { Project } from "@terrablox/database";
import { parseOutputs, parseVariables } from "@/components/module-detail/types";
import { database } from "@/lib/database";
import {
  commitFiles,
  type FileChange,
  listRepoTree,
  readRepoFile,
} from "@/lib/github/repo-files";
import { analyzeTerraformFiles } from "@/lib/terraform/analyze";
import {
  appendBlock,
  findBlock,
  listBlockAttributes,
  listBlocks,
  removeBlock,
  removeBlockAttribute,
  renameBlockLabel,
  renderModuleBlock,
  setBlockAttribute,
  uniqueBlockLabel,
} from "@/lib/terraform/hcl-edit";
import { resolveModuleLink } from "@/lib/terraform/module-link";

import {
  buildProjectGraph,
  type LibraryModule,
  libraryModuleName,
  usedModuleLabels,
} from "./graph";
import type {
  ProjectGraph,
  ProjectGraphMutation,
  ProjectMutationResult,
} from "./types";
import { coerceHclValue, unambiguousSource, wiringScore } from "./wiring";

/** Root configurations are rarely huge; the cap only bounds a runaway repo. */
const MAX_ROOT_FILES = 60;

export function normalizeFolder(input: string | null | undefined): string {
  const raw = (input ?? "").trim();
  if (!raw) return ".";
  const normalized = raw.replace(/^\/+/, "").replace(/\/+$/, "");
  return normalized === "" ? "." : normalized;
}

/**
 * Loads a project the user owns. Ownership is part of the lookup rather than a
 * later check so a wrong id can never reach the repository calls below.
 */
export async function findOwnedProject(
  userId: string,
  projectId: string,
): Promise<Project | null> {
  return database.project.findFirst({ where: { id: projectId, userId } });
}

function rootPrefix(project: Project): string {
  const folder = normalizeFolder(project.terraformRootFolder);
  return folder === "." ? "" : `${folder}/`;
}

/** Repository path of a file inside the project's Terraform root folder. */
export function repoPath(project: Project, fileName: string): string {
  return `${rootPrefix(project)}${fileName}`;
}

export interface ProjectFiles {
  /** Commit the files were read from. */
  sha: string;
  /** Contents keyed by repository-relative path. */
  files: Map<string, string>;
}

/**
 * Reads the `.tf` files that make up the project's root configuration.
 *
 * Only files directly inside the root folder are read: nested folders are
 * separate modules, and pulling them in would draw a graph that does not match
 * what `terraform plan` sees in this directory.
 */
export async function readProjectFiles(
  token: string,
  project: Project,
): Promise<ProjectFiles> {
  const { sha, entries } = await listRepoTree(token, {
    repoFullName: project.repoFullName,
    ref: project.repoBranch,
  });

  const prefix = rootPrefix(project);

  const paths = entries
    .filter((entry) => entry.type === "blob")
    .map((entry) => entry.path)
    .filter((path) => path.startsWith(prefix) && path.endsWith(".tf"))
    .filter((path) => !path.slice(prefix.length).includes("/"))
    .slice(0, MAX_ROOT_FILES);

  const contents = await Promise.all(
    paths.map(async (path) => {
      const file = await readRepoFile(token, {
        repoFullName: project.repoFullName,
        path,
        ref: project.repoBranch,
      });
      return file ? ([path, file.content] as const) : null;
    }),
  );

  return {
    sha,
    files: new Map(
      contents.filter((entry): entry is [string, string] => !!entry),
    ),
  };
}

/** The user's imported modules, in the shape the graph builder expects. */
export async function readModuleLibrary(
  userId: string,
): Promise<LibraryModule[]> {
  const modules = await database.terraformModule.findMany({
    where: { userId },
    include: { source: true },
  });

  return modules.map((mod) => ({
    id: mod.id,
    versionTag: mod.versionTag,
    terraformRootFolder: mod.terraformRootFolder,
    createdAt: mod.createdAt,
    sourceUrl: mod.source?.url ?? null,
    sourceName: mod.source?.name ?? null,
    submoduleName: mod.submoduleName,
    variables: mod.variables,
    outputs: mod.outputs,
  }));
}

function readPositions(
  project: Project,
): Record<string, { x: number; y: number }> {
  const raw = project.graphPositions;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};

  const positions: Record<string, { x: number; y: number }> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const { x, y } = value as { x?: unknown; y?: unknown };
    if (typeof x === "number" && typeof y === "number")
      positions[id] = { x, y };
  }

  return positions;
}

export async function loadProjectGraph(
  token: string,
  project: Project,
): Promise<ProjectGraph> {
  const [{ sha, files }, library] = await Promise.all([
    readProjectFiles(token, project),
    readModuleLibrary(project.userId),
  ]);

  const analysis = await analyzeTerraformFiles(
    [...files.entries()].map(([path, content]) => ({ path, content })),
  );

  return buildProjectGraph({
    analysis,
    files,
    library,
    positions: readPositions(project),
    sha,
  });
}

/**
 * Terraform source address for a module in the library.
 *
 * Written in `git::` form with an explicit `?ref` so the configuration keeps
 * working for anyone who clones the repository, and so re-importing the graph
 * resolves the call back to the same library entry.
 */
export function moduleSourceAddress(module: LibraryModule): string | null {
  const url = module.sourceUrl?.trim();
  if (!url) return null;

  const base = url.replace(/\.git$/i, "").replace(/\/+$/, "");

  const folder = normalizeFolder(module.terraformRootFolder);
  const subdir = folder === "." ? "" : `//${folder}`;
  const ref = module.versionTag?.trim();

  return `git::${base}.git${subdir}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;
}

/** File a module block lives in, or null when no file declares it. */
function fileOfModule(files: Map<string, string>, name: string): string | null {
  for (const [path, content] of files) {
    if (findBlock(content, "module", name)) return path;
  }
  return null;
}

class MutationError extends Error {}

/** A `module` block in the configuration, paired with what the library knows. */
interface PlacedModule {
  label: string;
  module: LibraryModule | null;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  return /^".*"$/s.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

/**
 * Every module block, resolved against the library.
 *
 * Read straight from the text rather than from an analysis: wiring runs inside
 * a mutation, on files that have just been edited in memory, and re-running the
 * WASM parser to learn what is essentially "which source does this block name"
 * would cost more than it explains.
 */
function readPlacedModules(
  files: Map<string, string>,
  library: LibraryModule[],
): PlacedModule[] {
  const placed: PlacedModule[] = [];

  for (const content of files.values()) {
    for (const block of listBlocks(content)) {
      const label = block.labels[0];
      if (block.type !== "module" || !label) continue;

      const source = listBlockAttributes(content, block).find(
        (attribute) => attribute.name === "source",
      );
      const link = source
        ? resolveModuleLink(unquote(source.value), null, library)
        : null;

      placed.push({
        label,
        module: link
          ? (library.find((m) => m.id === link.moduleId) ?? null)
          : null,
      });
    }
  }

  return placed;
}

interface Wire {
  targetInput: string;
  producer: string;
  output: string;
}

/**
 * Fills a module's required inputs from what is already on the canvas.
 *
 * Only unambiguous matches are written — see `unambiguousSource`. Everything
 * else is left for the user, because a wrong wire is silent: it plans, it
 * applies, and it builds the wrong thing.
 */
function autoWire(
  files: Map<string, string>,
  library: LibraryModule[],
  target: { label: string; module: LibraryModule },
): Wire[] {
  const path = fileOfModule(files, target.label);
  if (!path) return [];

  const producers = readPlacedModules(files, library).filter(
    (placed) => placed.label !== target.label && placed.module,
  );
  if (producers.length === 0) return [];

  const wires: Wire[] = [];

  for (const variable of parseVariables(target.module.variables)) {
    if (!variable.required) continue;

    const content = files.get(path) ?? "";
    const block = findBlock(content, "module", target.label);
    if (!block) break;

    const alreadySet = listBlockAttributes(content, block).some(
      (attribute) => attribute.name === variable.name,
    );
    if (alreadySet) continue;

    const candidates = producers.flatMap((placed) =>
      parseOutputs(placed.module?.outputs).map((output) => ({
        producer: placed.label,
        output: output.name,
        // A block is often named after what it is (`vpc`), but not always
        // (`this`), so the module's own name is a second chance at the prefix.
        score: Math.max(
          wiringScore(variable.name, output.name, placed.label),
          placed.module
            ? wiringScore(
                variable.name,
                output.name,
                libraryModuleName(placed.module),
              )
            : 0,
        ),
      })),
    );

    const choice = unambiguousSource(candidates);
    if (!choice) continue;

    const updated = setBlockAttribute(content, {
      type: "module",
      label: target.label,
      name: variable.name,
      value: `module.${choice.producer}.${choice.output}`,
    });
    if (updated === null) continue;

    files.set(path, updated);
    wires.push({
      targetInput: variable.name,
      producer: choice.producer,
      output: choice.output,
    });
  }

  return wires;
}

/**
 * Applies a graph edit to the repository.
 *
 * The edit is computed against the files as they are on the branch right now
 * and committed as a single revision, so the repository never holds a partially
 * applied change and the returned graph always reflects what was written.
 */
export async function applyProjectMutation(
  token: string,
  project: Project,
  mutation: ProjectGraphMutation,
): Promise<ProjectMutationResult> {
  const { files } = await readProjectFiles(token, project);
  const next = new Map(files);

  const { message, addedLabel } = await mutate(next, project, mutation);

  const changes: FileChange[] = [];
  for (const [path, content] of next) {
    if (files.get(path) !== content) changes.push({ path, content });
  }
  for (const path of files.keys()) {
    if (!next.has(path)) changes.push({ path, content: null });
  }

  const commit = await commitFiles(token, {
    repoFullName: project.repoFullName,
    branch: project.repoBranch,
    message,
    changes,
  });

  const positions = readPositions(project);
  if (addedLabel && mutation.action === "add-module" && mutation.position) {
    positions[addedLabel] = mutation.position;
  }

  const updated = await database.project.update({
    where: { id: project.id },
    data: {
      lastSyncedSha: commit?.sha ?? project.lastSyncedSha,
      lastSyncedAt: new Date(),
      graphPositions: positions,
    },
  });

  const graph = await loadProjectGraph(token, updated);

  return {
    graph,
    commit: commit
      ? { sha: commit.sha, path: commit.paths[0] ?? "", message }
      : null,
  };
}

interface MutationOutcome {
  message: string;
  /** Label of a block the mutation created, so its position can be stored. */
  addedLabel?: string;
}

async function mutate(
  files: Map<string, string>,
  project: Project,
  mutation: ProjectGraphMutation,
): Promise<MutationOutcome> {
  switch (mutation.action) {
    case "add-module":
      return addModule(files, project, mutation);
    case "remove-module":
      return { message: removeModule(files, mutation.name) };
    case "connect":
      return { message: connect(files, mutation) };
    case "disconnect":
      return { message: disconnect(files, mutation) };
    case "rename-module":
      return { message: renameModule(files, mutation.name, mutation.newName) };
    case "set-argument":
      return { message: setArgument(files, mutation) };
    case "auto-connect":
      return autoConnect(files, project, mutation.name);
  }
}

function setArgument(
  files: Map<string, string>,
  mutation: Extract<ProjectGraphMutation, { action: "set-argument" }>,
): string {
  const path = fileOfModule(files, mutation.name);
  if (!path) {
    throw new MutationError(`No module "${mutation.name}" in this project`);
  }

  const content = files.get(path) ?? "";
  const updated = setBlockAttribute(content, {
    type: "module",
    label: mutation.name,
    name: mutation.input,
    value: coerceHclValue(mutation.value),
  });

  if (updated === null) {
    throw new MutationError(`No module "${mutation.name}" in this project`);
  }
  files.set(path, updated);

  return `Set ${mutation.name}.${mutation.input}`;
}

async function autoConnect(
  files: Map<string, string>,
  project: Project,
  name: string,
): Promise<MutationOutcome> {
  const library = await readModuleLibrary(project.userId);
  const placed = readPlacedModules(files, library).find(
    (entry) => entry.label === name,
  );

  if (!placed) throw new MutationError(`No module "${name}" in this project`);
  if (!placed.module) {
    throw new MutationError(`Module "${name}" is not in your library`);
  }

  const wires = autoWire(files, library, {
    label: name,
    module: placed.module,
  });
  if (wires.length === 0) {
    throw new MutationError(
      `Nothing on the canvas unambiguously matches an input of "${name}"`,
    );
  }

  return { message: `Wire ${wires.length} input(s) of ${name}` };
}

async function addModule(
  files: Map<string, string>,
  project: Project,
  mutation: Extract<ProjectGraphMutation, { action: "add-module" }>,
): Promise<MutationOutcome> {
  const library = await readModuleLibrary(project.userId);
  const module = library.find((m) => m.id === mutation.moduleId);
  if (!module) throw new MutationError("Module is not in your library");

  const source = moduleSourceAddress(module);
  if (!source) {
    throw new MutationError("This module has no repository URL to reference");
  }

  const wanted =
    mutation.name?.trim() ||
    module.submoduleName ||
    module.sourceName ||
    "module";
  const name = uniqueBlockLabel(usedModuleLabels(files), wanted);

  const path = repoPath(project, project.terraformEntryFile);
  const current = files.get(path) ?? "";

  files.set(path, appendBlock(current, renderModuleBlock({ name, source })));

  // A module dropped next to the ones it depends on should arrive connected;
  // making the user redraw obvious wires is busywork the tool can do itself.
  const wires = autoWire(files, library, { label: name, module });
  const summary =
    wires.length > 0
      ? `Add module ${name} (wired ${wires.map((w) => w.targetInput).join(", ")})`
      : `Add module ${name}`;

  return { message: summary, addedLabel: name };
}

function removeModule(files: Map<string, string>, name: string): string {
  const path = fileOfModule(files, name);
  if (!path) throw new MutationError(`No module "${name}" in this project`);

  const content = files.get(path);
  const without = content ? removeBlock(content, "module", name) : null;
  if (without === null) {
    throw new MutationError(`No module "${name}" in this project`);
  }
  files.set(path, without);

  // Arguments elsewhere still pointing at the removed module would leave a
  // configuration that no longer plans, so they go with it.
  for (const [otherPath, otherContent] of files) {
    files.set(otherPath, dropReferencesTo(otherContent, name));
  }

  return `Remove module ${name}`;
}

/**
 * Drops every module argument whose value reads from `module.<name>`.
 *
 * Each removal shifts the offsets of everything after it, so the scan restarts
 * from the rewritten text rather than reusing the spans it just invalidated.
 */
function dropReferencesTo(content: string, name: string): string {
  const pattern = new RegExp(`\\bmodule\\.${name}\\b`);
  let result = content;

  for (;;) {
    const hit = findReferencingAttribute(result, pattern);
    if (!hit) return result;

    const stripped = removeBlockAttribute(result, {
      type: "module",
      label: hit.label,
      name: hit.attribute,
    });
    if (stripped === null || stripped === result) return result;
    result = stripped;
  }
}

function findReferencingAttribute(
  content: string,
  pattern: RegExp,
): { label: string; attribute: string } | null {
  for (const label of usedModuleLabels(new Map([["", content]]))) {
    const block = findBlock(content, "module", label);
    if (!block) continue;

    for (const attribute of listBlockAttributes(content, block)) {
      if (pattern.test(attribute.value)) {
        return { label, attribute: attribute.name };
      }
    }
  }

  return null;
}

function connect(
  files: Map<string, string>,
  mutation: Extract<ProjectGraphMutation, { action: "connect" }>,
): string {
  const path = fileOfModule(files, mutation.target);
  if (!path) {
    throw new MutationError(`No module "${mutation.target}" in this project`);
  }

  const content = files.get(path) ?? "";
  const updated = setBlockAttribute(content, {
    type: "module",
    label: mutation.target,
    name: mutation.targetInput,
    value: `module.${mutation.source}.${mutation.sourceOutput}`,
  });

  if (updated === null) {
    throw new MutationError(`No module "${mutation.target}" in this project`);
  }
  files.set(path, updated);

  return `Wire ${mutation.source}.${mutation.sourceOutput} into ${mutation.target}.${mutation.targetInput}`;
}

function disconnect(
  files: Map<string, string>,
  mutation: Extract<ProjectGraphMutation, { action: "disconnect" }>,
): string {
  const path = fileOfModule(files, mutation.target);
  if (!path) {
    throw new MutationError(`No module "${mutation.target}" in this project`);
  }

  const content = files.get(path) ?? "";
  const updated = removeBlockAttribute(content, {
    type: "module",
    label: mutation.target,
    name: mutation.targetInput,
  });

  if (updated === null) {
    throw new MutationError(`No module "${mutation.target}" in this project`);
  }
  files.set(path, updated);

  return `Unwire ${mutation.target}.${mutation.targetInput}`;
}

function renameModule(
  files: Map<string, string>,
  name: string,
  newName: string,
): string {
  const target = uniqueBlockLabel(
    usedModuleLabels(files).filter((label) => label !== name),
    newName,
  );

  const path = fileOfModule(files, name);
  if (!path) throw new MutationError(`No module "${name}" in this project`);

  const declaring = files.get(path) ?? "";
  const renamed = renameBlockLabel(declaring, "module", name, target);
  if (renamed === null) {
    throw new MutationError(`No module "${name}" in this project`);
  }
  files.set(path, renamed);

  const reference = new RegExp(`\\bmodule\\.${name}\\b`, "g");
  for (const [otherPath, content] of files) {
    files.set(otherPath, content.replace(reference, `module.${target}`));
  }

  return `Rename module ${name} to ${target}`;
}

export { MutationError };
