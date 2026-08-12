/**
 * Ordering for module version refs.
 *
 * `versionTag` is a free-text column holding whatever ref was imported, so it
 * mixes release tags (`v6.6.0`, `6.6.0`, `v1.2.3-rc.1`) with branch names
 * (`main`, `feature/x`). A plain string sort is actively wrong here: it puts
 * `v6.10.0` *before* `v6.6.0`, i.e. it hides the newest release.
 *
 * Rules, in order:
 *   1. Semver-ish tags come first, newest first.
 *   2. Releases outrank their own pre-releases (`1.0.0` > `1.0.0-rc.1`).
 *   3. Everything unparsable (branches) follows, newest import first.
 */

export interface VersionLike {
  versionTag: string | null;
  createdAt?: string | Date | null;
}

interface ParsedVersion {
  parts: number[];
  prerelease: string | null;
}

const SEMVER_RE = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+](.+))?$/;

export function parseVersionTag(tag: string | null): ParsedVersion | null {
  if (!tag) return null;

  const match = SEMVER_RE.exec(tag.trim());
  if (!match) return null;

  return {
    parts: [
      Number(match[1] ?? 0),
      Number(match[2] ?? 0),
      Number(match[3] ?? 0),
    ],
    prerelease: match[4] ?? null,
  };
}

/**
 * Compares the dot-separated identifiers of a pre-release the way semver does:
 * numeric identifiers compare numerically, and a shorter prefix loses.
 */
function comparePrerelease(a: string, b: string): number {
  const left = a.split(".");
  const right = b.split(".");

  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i];
    const r = right[i];

    if (l === undefined) return -1;
    if (r === undefined) return 1;

    const ln = Number(l);
    const rn = Number(r);
    const bothNumeric = !Number.isNaN(ln) && !Number.isNaN(rn);

    const diff = bothNumeric ? ln - rn : l.localeCompare(r);
    if (diff !== 0) return diff;
  }

  return 0;
}

function toTime(value: string | Date | null | undefined): number {
  if (!value) return 0;
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(time) ? 0 : time;
}

/**
 * Sort comparator putting the newest version first.
 *
 * Use with `[...versions].sort(compareVersionsDesc)` — it does not mutate.
 */
export function compareVersionsDesc(a: VersionLike, b: VersionLike): number {
  const pa = parseVersionTag(a.versionTag);
  const pb = parseVersionTag(b.versionTag);

  if (pa && !pb) return -1;
  if (!pa && pb) return 1;

  if (pa && pb) {
    for (let i = 0; i < 3; i++) {
      const diff = (pb.parts[i] ?? 0) - (pa.parts[i] ?? 0);
      if (diff !== 0) return diff;
    }

    if (pa.prerelease && !pb.prerelease) return 1;
    if (!pa.prerelease && pb.prerelease) return -1;
    if (pa.prerelease && pb.prerelease) {
      const diff = comparePrerelease(pb.prerelease, pa.prerelease);
      if (diff !== 0) return diff;
    }
  }

  const byDate = toTime(b.createdAt) - toTime(a.createdAt);
  if (byDate !== 0) return byDate;

  return (a.versionTag ?? "").localeCompare(b.versionTag ?? "");
}

export function sortVersionsDesc<T extends VersionLike>(versions: T[]): T[] {
  return [...versions].sort(compareVersionsDesc);
}

/** The version a repo should open at by default. */
export function pickLatest<T extends VersionLike>(versions: T[]): T | null {
  return sortVersionsDesc(versions)[0] ?? null;
}

export function isReleaseTag(tag: string | null): boolean {
  return parseVersionTag(tag) !== null;
}
