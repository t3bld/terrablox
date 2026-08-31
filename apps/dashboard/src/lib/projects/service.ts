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
import { visibleToUser } from "@/lib/modules/ownership";
import { analyzeTerraformFiles } from "@/lib/terraform/analyze";
import {
  appendBlock,
  findBlock,
  findLocalsBlockDeclaring,
  findLocalsBlocks,
  listBlockAttributes,
  listBlocks,
  listLocalsEntries,
  removeBlock,
  removeBlockAttribute,
  removeLocalsEntry,
  renameBlockLabel,
  renameLocalsEntry,
  renderLocalsBlock,
  renderModuleBlock,
  setBlockAttribute,
  setLocalsEntry,
  uniqueBlockLabel,
} from "@/lib/terraform/hcl-edit";
import { resolveModuleLink } from "@/lib/terraform/module-link";

import {
  buildProjectGraph,
  type LibraryModule,
  libraryModuleName,
  usedModuleLabels,
} from "./graph";
import { isValidLocalName, localNodeId, localReference } from "./locals";
import type {
  OperationOrigin,
  ProjectGraph,
  ProjectGraphMutation,
  ProjectMutationResult,
} from "./types";
import {
  coerceHclValue,
  isPassThroughOutput,
  isWirableInput,
  unambiguousSource,
  wiringScore,
} from "./wiring";

/** Root configurations are rarely huge; the cap only bounds a runaway repo. */
const MAX_ROOT_FILES = 60;

/**
 * Where a project's first `locals` block is written.
 *
 * Its own file rather than the entry file: locals are the values a reader looks
 * up, and burying the first one under a hundred lines of module calls is how
 * they stop being findable. Later locals join whichever block already exists.
 */
const LOCALS_FILE = "locals.tf";

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

/**
 * The modules a project may draw on, in the shape the graph builder expects.
 *
 * The user's own imports plus the catalogue TerraBlox ships with. Both have to be
 * here rather than only the former: `buildProjectGraph` resolves every `module`
 * block in the repository against this list, and a block whose module is missing
 * becomes a node with no inputs or outputs. A project built on a shipped module
 * would otherwise render as an unwirable box.
 */
export async function readModuleLibrary(
  userId: string,
): Promise<LibraryModule[]> {
  const modules = await database.terraformModule.findMany({
    where: visibleToUser(userId),
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
    // Free of an extra query — the source is already joined for its name — and
    // the difference between a library the agent can choose from and one it can
    // only guess at.
    description: mod.source?.description ?? null,
    tags: mod.source?.tags ?? [],
  }));
}

/**
 * The resource types a set of modules creates, by module id.
 *
 * Separate from {@link readModuleLibrary} and deliberately not part of it. A
 * module's resources are tens of rows each, and every project graph load reads
 * the whole library — folding them in would multiply the cost of drawing a canvas
 * to serve a question only the agent asks, about the two or three modules it is
 * actually considering.
 *
 * Only the type and the kind: the caller wants to know what will exist and what
 * it will bill, not where in the module it was declared.
 */
export async function readModuleResourceTypes(
  userId: string,
  moduleIds: string[],
): Promise<Record<string, Array<{ kind: string; resourceType: string }>>> {
  if (moduleIds.length === 0) return {};

  const rows = await database.providerResource.findMany({
    // Scoped through the module rather than trusting the ids: they arrive from a
    // model, and another user's module id is a valid-looking string.
    where: { moduleId: { in: moduleIds }, module: visibleToUser(userId) },
    select: { moduleId: true, kind: true, resourceType: true },
  });

  const byModule: Record<
    string,
    Array<{ kind: string; resourceType: string }>
  > = {};

  for (const row of rows) {
    const existing = byModule[row.moduleId];
    const entry = { kind: row.kind, resourceType: row.resourceType };
    if (existing) existing.push(entry);
    else byModule[row.moduleId] = [entry];
  }

  return byModule;
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
    // Not `required`, which turned out to select almost nothing: 324 of 372
    // imported modules declare no required variable at all, so this loop used to
    // do nothing on any real catalogue. See `isWirableInput`.
    if (!isWirableInput(variable)) continue;

    const content = files.get(path) ?? "";
    const block = findBlock(content, "module", target.label);
    if (!block) break;

    const alreadySet = listBlockAttributes(content, block).some(
      (attribute) => attribute.name === variable.name,
    );
    if (alreadySet) continue;

    const candidates = producers.flatMap((placed) => {
      // The producer's own inputs, so an output that merely echoes one of them
      // is not mistaken for that module producing the value. See
      // `isPassThroughOutput`.
      const placedInputs = parseVariables(placed.module?.variables);

      return parseOutputs(placed.module?.outputs)
        .filter((output) => !isPassThroughOutput(output.name, placedInputs))
        .map((output) => ({
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
        }));
    });

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
  origin: OperationOrigin = "canvas",
): Promise<ProjectMutationResult> {
  const { files, sha: parentSha } = await readProjectFiles(token, project);
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
    message: commitMessage(message, mutation.action, origin),
    changes,
  });

  const positions = readPositions(project);

  if (
    addedLabel &&
    (mutation.action === "add-module" || mutation.action === "add-local") &&
    mutation.position
  ) {
    positions[addedLabel] = mutation.position;
  }

  // Layout follows the node it belongs to. Without this a renamed local reappears
  // wherever the layout engine puts an unplaced node, which reads as the canvas
  // having lost it.
  if (mutation.action === "rename-local") {
    const from = localNodeId(mutation.name);
    const to = localNodeId(mutation.newName);
    if (positions[from]) {
      positions[to] = positions[from] as { x: number; y: number };
      delete positions[from];
    }
  }
  if (mutation.action === "rename-module" && positions[mutation.name]) {
    positions[mutation.newName] = positions[mutation.name] as {
      x: number;
      y: number;
    };
    delete positions[mutation.name];
  }
  if (mutation.action === "remove-local") {
    delete positions[localNodeId(mutation.name)];
  }
  if (mutation.action === "remove-module") {
    delete positions[mutation.name];
  }

  const updated = await database.project.update({
    where: { id: project.id },
    data: {
      lastSyncedSha: commit?.sha ?? project.lastSyncedSha,
      lastSyncedAt: new Date(),
      graphPositions: positions,
    },
  });

  // After the commit, so nothing is recorded that did not reach the repository.
  await database.projectOperation.create({
    data: {
      projectId: project.id,
      origin,
      mutation: JSON.parse(JSON.stringify(mutation)),
      summary: message,
      commitSha: commit?.sha ?? null,
      // The branch head the edit was computed against, not the last sha we
      // happened to sync: a push made outside the app moves one but not the other.
      parentSha,
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

/** Trailer names, in the `Key: value` convention `git interpret-trailers` reads. */
export const OPERATION_TRAILER = "TerraBlox-Operation";
export const ORIGIN_TRAILER = "TerraBlox-Origin";

/**
 * The commit message, with the operation attached as trailers.
 *
 * Puts the structured form of the edit in the repository rather than only in
 * our database, so a commit still says which operation produced it — and can be
 * told apart from a hand-written push — if the history table is ever lost.
 */
function commitMessage(
  summary: string,
  action: string,
  origin: OperationOrigin,
): string {
  return `${summary}\n\n${OPERATION_TRAILER}: ${action}\n${ORIGIN_TRAILER}: ${origin}\n`;
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
    case "set-arguments":
      return {
        message: setArguments(files, mutation.name, mutation.values),
      };
    case "auto-connect":
      return autoConnect(files, project, mutation.name);
    case "add-local":
      return addLocal(files, project, mutation);
    case "set-local":
      return { message: setLocal(files, mutation.name, mutation.value) };
    case "rename-local":
      return { message: renameLocal(files, mutation.name, mutation.newName) };
    case "remove-local":
      return { message: removeLocal(files, mutation.name) };
    case "connect-local":
      return { message: connectLocal(files, mutation) };
  }
}

/** File declaring a local, or null when no `locals` block does. */
function fileOfLocal(files: Map<string, string>, name: string): string | null {
  for (const [path, content] of files) {
    if (findLocalsBlockDeclaring(content, name)) return path;
  }
  return null;
}

/** Every local name in the project, for collision checks. */
function usedLocalNames(files: Map<string, string>): Set<string> {
  const names = new Set<string>();
  for (const content of files.values()) {
    for (const entry of listLocalsEntries(content)) names.add(entry.name);
  }
  return names;
}

/**
 * Declares a local, and optionally wires it into the input that asked for it.
 *
 * The wiring is part of this mutation rather than a second one because on the
 * canvas it is one gesture: dragging out of an unfilled input and letting go.
 * Splitting it would put two commits and two history rows behind one action, and
 * leave a dangling local behind if the second half failed.
 */
function addLocal(
  files: Map<string, string>,
  project: Project,
  mutation: Extract<ProjectGraphMutation, { action: "add-local" }>,
): MutationOutcome {
  const name = mutation.name.trim();
  if (!isValidLocalName(name)) {
    throw new MutationError(
      `"${name}" is not a valid local name. Use letters, digits and underscores, starting with a letter.`,
    );
  }
  if (usedLocalNames(files).has(name)) {
    throw new MutationError(`A local called "${name}" already exists`);
  }

  const value = coerceHclValue(mutation.value);

  // Prefer an existing `locals` block over creating a second one: Terraform
  // merges them, but a file per local is not how anyone writes this by hand.
  const existingPath = [...files.keys()]
    .sort()
    .find((path) => findLocalsBlocks(files.get(path) ?? "").length > 0);

  if (existingPath) {
    const updated = setLocalsEntry(files.get(existingPath) ?? "", name, value);
    if (updated === null) {
      throw new MutationError("Could not write the locals block");
    }
    files.set(existingPath, updated);
  } else {
    const path = repoPath(project, LOCALS_FILE);
    const current = files.get(path) ?? "";
    files.set(path, appendBlock(current, renderLocalsBlock([{ name, value }])));
  }

  if (!mutation.connectTo) {
    return { message: `Add local ${name}`, addedLabel: localNodeId(name) };
  }

  const { target, targetInput } = mutation.connectTo;
  wireLocal(files, name, target, targetInput);

  return {
    message: `Add local ${name} and wire it to ${target}.${targetInput}`,
    addedLabel: localNodeId(name),
  };
}

function setLocal(
  files: Map<string, string>,
  name: string,
  value: string,
): string {
  const path = fileOfLocal(files, name);
  if (!path) throw new MutationError(`No local "${name}" in this project`);

  const updated = setLocalsEntry(
    files.get(path) ?? "",
    name,
    coerceHclValue(value),
  );
  if (updated === null) {
    throw new MutationError(`No local "${name}" in this project`);
  }
  files.set(path, updated);

  return `Set local ${name}`;
}

/**
 * Renames a local and every `local.<name>` that read it.
 *
 * Word-boundary matched so `local.env` does not rewrite `local.environment`,
 * and applied across all files because a local is module-wide.
 */
function renameLocal(
  files: Map<string, string>,
  name: string,
  newName: string,
): string {
  const trimmed = newName.trim();
  if (!isValidLocalName(trimmed)) {
    throw new MutationError(`"${trimmed}" is not a valid local name`);
  }
  if (trimmed !== name && usedLocalNames(files).has(trimmed)) {
    throw new MutationError(`A local called "${trimmed}" already exists`);
  }

  const path = fileOfLocal(files, name);
  if (!path) throw new MutationError(`No local "${name}" in this project`);

  const renamed = renameLocalsEntry(files.get(path) ?? "", name, trimmed);
  if (renamed === null) {
    throw new MutationError(`No local "${name}" in this project`);
  }
  files.set(path, renamed);

  const pattern = new RegExp(`\\blocal\\.${escapeRegExp(name)}\\b`, "g");
  for (const [otherPath, content] of files) {
    files.set(otherPath, content.replace(pattern, `local.${trimmed}`));
  }

  return `Rename local ${name} to ${trimmed}`;
}

/**
 * Removes a local and every argument that read it.
 *
 * Same reasoning as removing a module: an argument left pointing at a local that
 * no longer exists is a configuration that does not plan.
 */
function removeLocal(files: Map<string, string>, name: string): string {
  const path = fileOfLocal(files, name);
  if (!path) throw new MutationError(`No local "${name}" in this project`);

  const without = removeLocalsEntry(files.get(path) ?? "", name);
  if (without === null) {
    throw new MutationError(`No local "${name}" in this project`);
  }
  files.set(path, without);

  const pattern = new RegExp(`\\blocal\\.${escapeRegExp(name)}\\b`);
  for (const [otherPath, content] of files) {
    files.set(otherPath, dropAttributesMatching(content, pattern));
  }

  return `Remove local ${name}`;
}

function connectLocal(
  files: Map<string, string>,
  mutation: Extract<ProjectGraphMutation, { action: "connect-local" }>,
): string {
  if (!fileOfLocal(files, mutation.local)) {
    throw new MutationError(`No local "${mutation.local}" in this project`);
  }

  wireLocal(files, mutation.local, mutation.target, mutation.targetInput);

  return `Wire ${mutation.target}.${mutation.targetInput} to local.${mutation.local}`;
}

/** Points one module argument at a local. */
function wireLocal(
  files: Map<string, string>,
  local: string,
  target: string,
  targetInput: string,
): void {
  const path = fileOfModule(files, target);
  if (!path) throw new MutationError(`No module "${target}" in this project`);

  const updated = setBlockAttribute(files.get(path) ?? "", {
    type: "module",
    label: target,
    name: targetInput,
    value: localReference(local),
  });

  if (updated === null) {
    throw new MutationError(`No module "${target}" in this project`);
  }
  files.set(path, updated);
}

function setArgument(
  files: Map<string, string>,
  mutation: Extract<ProjectGraphMutation, { action: "set-argument" }>,
): string {
  return setArguments(files, mutation.name, [
    { input: mutation.input, value: mutation.value },
  ]);
}

/**
 * Writes several arguments of one module, and returns one summary for the lot.
 *
 * Each write is applied to the text the previous one produced, because
 * `setBlockAttribute` works on offsets that the write before it invalidated.
 */
function setArguments(
  files: Map<string, string>,
  name: string,
  values: ReadonlyArray<{ input: string; value: string }>,
): string {
  const path = fileOfModule(files, name);
  if (!path) {
    throw new MutationError(`No module "${name}" in this project`);
  }
  if (values.length === 0) {
    throw new MutationError(`No arguments given for "${name}"`);
  }

  let content = files.get(path) ?? "";

  for (const entry of values) {
    const updated = setBlockAttribute(content, {
      type: "module",
      label: name,
      name: entry.input,
      value: coerceHclValue(entry.value),
    });

    if (updated === null) {
      throw new MutationError(`No module "${name}" in this project`);
    }
    content = updated;
  }

  files.set(path, content);

  const first = values[0];
  return values.length === 1 && first
    ? `Set ${name}.${first.input}`
    : `Set ${values.length} arguments on ${name} (${values.map((entry) => entry.input).join(", ")})`;
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
  return dropAttributesMatching(
    content,
    new RegExp(`\\bmodule\\.${escapeRegExp(name)}\\b`),
  );
}

/**
 * Drops every module argument whose value matches `pattern`.
 *
 * Shared by module and local removal: both leave arguments pointing at
 * something that is gone, and the repair is identical.
 */
function dropAttributesMatching(content: string, pattern: RegExp): string {
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
