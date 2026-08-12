/**
 * Resolves a module's `module` blocks to modules the user has already imported,
 * so a dependency can link straight to its own detail page.
 *
 * The two sides describe the same repository in different shapes: a dependency
 * carries a Terraform source string
 * (`git::https://github.com/acme/cbbac-aws-alb.git//terraform?ref=3.0.1`),
 * while an import stores a clone URL plus the analysed root folder. Both are
 * reduced to a repository name and a subdirectory, which is what actually
 * identifies the module.
 *
 * Host and organisation are deliberately *not* compared. The same module is
 * routinely reachable under several of them — a fork, a mirror, an internal
 * GitHub Enterprise next to github.com — and requiring them to match would drop
 * links that a user rightly expects to see.
 */

import { compareVersionsDesc } from "./versions";

export interface ModuleSourceRef {
  /** Repository name without owner or `.git`, lowercased. */
  repo: string;
  /** Terraform's `//subdir`, normalised; empty string for the repository root. */
  subdir: string;
  /** The `?ref=` revision, if the source pins one. */
  ref: string | null;
}

export interface LinkCandidate {
  id: string;
  versionTag: string | null;
  terraformRootFolder: string | null;
  createdAt?: string | Date | null;
  sourceUrl: string | null;
  sourceName: string | null;
  submoduleName?: string | null;
}

export interface ModuleLink {
  moduleId: string;
  name: string;
  versionTag: string | null;
  /** False when the pinned ref is not imported and a fallback was chosen. */
  exactVersion: boolean;
  /** The ref the dependency asks for, kept so the UI can explain a mismatch. */
  requestedRef: string | null;
}

/** Terraform's forwarding prefixes: `git::`, `hg::`, `s3::`, … */
const FORWARDER_RE = /^[a-z][a-z0-9+.-]*::/i;

/**
 * Splits a Terraform module source into the parts that identify a repository.
 *
 * Returns null for sources that cannot name a repository on their own —
 * relative paths, which are resolved against the containing repository rather
 * than fetched.
 */
export function parseModuleSourceRef(
  source: string | null | undefined,
  sourceKind?: string | null,
): ModuleSourceRef | null {
  const trimmed = source?.trim();
  if (!trimmed) return null;

  const withoutForwarder = trimmed.replace(FORWARDER_RE, "");

  // A relative path points inside the module that declares it, so there is no
  // repository name to match on.
  if (/^\.{1,2}\//.test(withoutForwarder) || sourceKind === "local") {
    return null;
  }

  const [beforeQuery, query] = splitQuery(withoutForwarder);
  const { base, subdir } = splitSubdirectory(beforeQuery);
  const segments = pathSegments(base);
  if (segments.length === 0) return null;

  // Registry addresses are `[<host>/]<namespace>/<name>/<provider>`, so the
  // module name is the second to last segment rather than the last.
  const nameSegment =
    sourceKind === "registry" && segments.length >= 3
      ? segments[segments.length - 2]
      : segments[segments.length - 1];

  const repo = nameSegment
    ?.replace(/\.git$/i, "")
    .trim()
    .toLowerCase();
  if (!repo) return null;

  return { repo, subdir: normaliseSubdir(subdir), ref: readRef(query) };
}

/** The same identifying parts, derived from an imported module instead. */
export function candidateRef(candidate: LinkCandidate): ModuleSourceRef | null {
  const parsed = parseModuleSourceRef(candidate.sourceUrl);
  if (!parsed) return null;

  // The clone URL has no `//subdir`; the analysed folder plays that role.
  return {
    repo: parsed.repo,
    subdir: normaliseSubdir(candidate.terraformRootFolder),
    ref: null,
  };
}

/**
 * Picks the imported module a dependency should link to, preferring the pinned
 * revision and otherwise falling back to the newest import of that repository.
 *
 * A fallback is still a useful link: it answers "which of these do I have?",
 * and `exactVersion` lets the UI say that it is not the pinned one.
 */
export function resolveModuleLink(
  source: string | null | undefined,
  sourceKind: string | null | undefined,
  candidates: LinkCandidate[],
): ModuleLink | null {
  const wanted = parseModuleSourceRef(source, sourceKind);
  if (!wanted) return null;

  const matches = candidates.filter((candidate) => {
    const ref = candidateRef(candidate);
    return ref?.repo === wanted.repo && ref.subdir === wanted.subdir;
  });

  if (matches.length === 0) return null;

  const exact = wanted.ref
    ? matches.find((m) => sameRef(m.versionTag, wanted.ref))
    : undefined;

  const chosen = exact ?? sortCandidates(matches)[0];
  if (!chosen) return null;

  return {
    moduleId: chosen.id,
    name: chosen.submoduleName ?? chosen.sourceName ?? wanted.repo,
    versionTag: chosen.versionTag,
    exactVersion: exact !== undefined || wanted.ref === null,
    requestedRef: wanted.ref,
  };
}

/** Resolves many dependencies at once, keyed by the dependency id. */
export function resolveModuleLinks<
  T extends { id: string; source: string | null; sourceKind?: string | null },
>(dependencies: T[], candidates: LinkCandidate[]): Map<string, ModuleLink> {
  const links = new Map<string, ModuleLink>();

  for (const dependency of dependencies) {
    const link = resolveModuleLink(
      dependency.source,
      dependency.sourceKind ?? null,
      candidates,
    );
    if (link) links.set(dependency.id, link);
  }

  return links;
}

export interface DependentCall {
  /** The local name of the `module` block, e.g. `alb` in `module "alb"`. */
  name: string;
  exactVersion: boolean;
  requestedRef: string | null;
}

export interface ModuleDependent {
  moduleId: string;
  name: string;
  versionTag: string | null;
  /** One entry per `module` block; a module may call the same target twice. */
  calls: DependentCall[];
}

/**
 * The inverse of {@link resolveModuleLink}: which imported modules call the
 * given one.
 *
 * Resolution deliberately runs against the *full* candidate list rather than
 * the target alone. A dependency pinned to `1.0.0` belongs on the page of the
 * `1.0.0` import, not on every version of that repository — matching only the
 * repository would claim callers that the forward link sends elsewhere.
 */
export function resolveDependents<
  T extends {
    name: string;
    source: string | null;
    sourceKind?: string | null;
    moduleId: string;
  },
>(
  targetModuleId: string,
  dependencies: T[],
  candidates: LinkCandidate[],
): ModuleDependent[] {
  const byModule = new Map<string, ModuleDependent>();

  for (const dependency of dependencies) {
    // A module listing itself would be noise, not information.
    if (dependency.moduleId === targetModuleId) continue;

    const link = resolveModuleLink(
      dependency.source,
      dependency.sourceKind ?? null,
      candidates,
    );
    if (link?.moduleId !== targetModuleId) continue;

    const caller = candidates.find((c) => c.id === dependency.moduleId);
    if (!caller) continue;

    const entry = byModule.get(caller.id) ?? {
      moduleId: caller.id,
      name: caller.submoduleName ?? caller.sourceName ?? "(unnamed)",
      versionTag: caller.versionTag,
      calls: [],
    };
    entry.calls.push({
      name: dependency.name,
      exactVersion: link.exactVersion,
      requestedRef: link.requestedRef,
    });
    byModule.set(caller.id, entry);
  }

  for (const entry of byModule.values()) {
    entry.calls.sort((a, b) => a.name.localeCompare(b.name));
  }

  return [...byModule.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function sortCandidates(candidates: LinkCandidate[]): LinkCandidate[] {
  return [...candidates].sort(compareVersionsDesc);
}

/**
 * `v3.0.1` and `3.0.1` name the same release; Terraform sources and Git tags
 * disagree about the prefix often enough that an exact string match would
 * report a mismatch that does not exist.
 */
function sameRef(versionTag: string | null, ref: string | null): boolean {
  if (!versionTag || !ref) return false;

  const strip = (value: string) =>
    value.trim().replace(/^v/i, "").toLowerCase();
  return strip(versionTag) === strip(ref);
}

function splitQuery(source: string): [string, string | null] {
  const at = source.indexOf("?");
  return at >= 0 ? [source.slice(0, at), source.slice(at + 1)] : [source, null];
}

/**
 * Separates Terraform's `//subdir` suffix without mistaking it for the `//`
 * that follows a URL scheme.
 */
function splitSubdirectory(source: string): { base: string; subdir: string } {
  const schemeEnd = source.indexOf("://");
  const from = schemeEnd >= 0 ? schemeEnd + 3 : 0;
  const at = source.indexOf("//", from);

  return at >= 0
    ? { base: source.slice(0, at), subdir: source.slice(at + 2) }
    : { base: source, subdir: "" };
}

function pathSegments(base: string): string[] {
  const schemeAt = base.indexOf("://");
  if (schemeAt >= 0) {
    // Drop the host, otherwise a bare `https://github.com/` would report the
    // host itself as the repository name.
    return base
      .slice(schemeAt + 3)
      .split("/")
      .filter(Boolean)
      .slice(1);
  }

  // scp-style remotes (`git@github.com:org/repo.git`) put the path after a
  // colon rather than a slash.
  const withoutHost = /^[^/]*@[^/]*:/.test(base)
    ? (base.split(":").pop() ?? base)
    : base;

  return withoutHost.split("/").filter(Boolean);
}

/** `./terraform/`, `/terraform` and `terraform` all name the same folder. */
function normaliseSubdir(value: string | null | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "." || trimmed === "./") return "";

  return trimmed
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function readRef(query: string | null): string | null {
  if (!query) return null;

  for (const part of query.split("&")) {
    const [key, value] = part.split("=");
    if (key === "ref" && value) return decodeURIComponent(value);
  }

  return null;
}
