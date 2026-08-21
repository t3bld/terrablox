/**
 * Points the shipped catalogue at renamed repositories: `pnpm db:builtin:relink`.
 *
 * A source row is matched by its canonical URL. Rename a repository upstream and
 * the next sync no longer recognises it as the one already in the database: it
 * adds a second set of rows and leaves the first set behind, stale and
 * indistinguishable in the module list. Rewriting the URLs in place avoids that,
 * and avoids re-reading the repository from GitHub to recover information that is
 * already stored.
 *
 * Two kinds of rename are handled. {@link RENAMES} covers one-off renames of
 * individual repositories, and the prefix rule covers a rename of the whole
 * catalogue at once, as when everything moved from `os-terraform-aws-*` to
 * `terrablox-aws-*`.
 *
 * Only URLs are rewritten — the source URL, the icon URL and the per-version
 * module URLs. The display name deliberately stays untouched: it comes from the
 * `SERVICE_NAMES` table in `main.mts`, and a second copy of that rule here would
 * drift from it the first time a name changed.
 *
 * Only builtin rows are touched. A user who imported one of these repositories
 * themselves owns their own copy, and a rename upstream is not a reason for us to
 * edit it.
 *
 * Idempotent: a row already carrying the new URL is left alone, so running this
 * twice is the same as running it once.
 */

import { prisma } from "@/lib/database";
import { BUILTIN_USER_ID } from "@/lib/modules/ownership";

/**
 * Individual repositories that were renamed, old name to new name.
 *
 * Kept as history rather than cleared once applied: the entries are what makes
 * the script idempotent for anyone whose database is still on an older name, and
 * a list of past renames is worth more than an empty object.
 */
const RENAMES: Readonly<Record<string, string>> = {
  "terrablox-aws-apigateway-v2": "terrablox-aws-apigateway",
  "terrablox-aws-managed-service-grafana": "terrablox-aws-grafana",
  "terrablox-aws-managed-service-prometheus": "terrablox-aws-prometheus",
  "terrablox-aws-wafv2": "terrablox-aws-waf",
};

const OLD_PREFIX = process.env.OLD_PREFIX ?? "os-terraform-aws-";
const NEW_PREFIX = process.env.NEW_PREFIX ?? "terrablox-aws-";

/** The repository name inside a canonical or ref-pinned clone URL. */
function repoNameOf(url: string): string | null {
  const match = /github\.com\/[^/]+\/([^/.?]+)/.exec(url);
  return match?.[1] ?? null;
}

/** What a repository is called now, or null if this one did not move. */
function renamedTo(repo: string): string | null {
  const listed = RENAMES[repo];
  if (listed) return listed;

  if (repo.startsWith(OLD_PREFIX)) {
    return `${NEW_PREFIX}${repo.slice(OLD_PREFIX.length)}`;
  }

  return null;
}

const sources = await prisma.terraformModuleSource.findMany({
  where: { userId: BUILTIN_USER_ID },
  select: { id: true, name: true, url: true, iconUrl: true },
});

if (sources.length === 0) {
  console.log(
    "No builtin sources found, so there is nothing to relink. Run pnpm db:builtin:sync.",
  );
  await prisma.$disconnect();
  process.exit(0);
}

console.log(`Checking ${sources.length} builtin repositories…\n`);

let relinked = 0;
let untouched = 0;

for (const source of sources) {
  const repo = repoNameOf(source.url);
  const renamed = repo ? renamedTo(repo) : null;

  if (!repo || !renamed) {
    untouched++;
    continue;
  }

  // The module rows carry the same URL with `?ref=<tag>` appended, and the icon
  // URL points at a different host entirely, so all of them are rewritten by
  // substring rather than by recomputing each one from parts.
  const modules = await prisma.terraformModule.findMany({
    where: { sourceId: source.id, userId: BUILTIN_USER_ID },
    select: { id: true, url: true },
  });

  await prisma.$transaction([
    prisma.terraformModuleSource.update({
      where: { id: source.id },
      data: {
        url: source.url.replace(repo, renamed),
        ...(source.iconUrl?.includes(repo)
          ? { iconUrl: source.iconUrl.replace(repo, renamed) }
          : {}),
      },
    }),
    ...modules
      .filter((mod) => mod.url?.includes(repo))
      .map((mod) =>
        prisma.terraformModule.update({
          where: { id: mod.id },
          data: { url: (mod.url as string).replace(repo, renamed) },
        }),
      ),
  ]);

  relinked++;
  console.log(
    `  ${repo} -> ${renamed} (${modules.length} version${
      modules.length === 1 ? "" : "s"
    }, name ${source.name} unchanged)`,
  );
}

console.log(
  `\nRelinked ${relinked}, left alone ${untouched}.${
    relinked > 0
      ? "\n\nThe next `pnpm db:builtin:sync` will now update these rows rather than duplicate them."
      : ""
  }`,
);

await prisma.$disconnect();
