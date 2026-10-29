/**
 * Exports recorded agent turns as JSONL, one transformation per line, for feeding
 * the harness.
 *
 *   pnpm transformations:export > transformations.jsonl
 *   pnpm transformations:export --labelled-only > labelled.jsonl
 *   pnpm transformations:export --kind legacy > migrations.jsonl
 *
 * Each row is a self-contained training example: the prompt and the conditions it
 * ran under, the graph before and after, the trajectory, mutations and decisions in
 * between, the migration source (the app-repo files and MCP results a legacy
 * migration starts from), the commits it produced, and — once the project's
 * pipeline has judged them — whether the resulting Terraform was valid. That last
 * field is the label, so `--labelled-only` keeps the turns a pipeline has actually
 * ruled on and drops the ones still waiting.
 *
 * `--kind greenfield|graph|legacy` keeps one starting state. A migration from a
 * legacy system reads as `legacy`; a project built from nothing as `greenfield`; a
 * turn that extended an existing graph as `graph`. The three are different learning
 * problems, so training on one at a time is often what you want.
 *
 * Reads from the database the dashboard writes, through the app's own `@/lib/
 * database` for the same reason the seed scripts do: pnpm only links a workspace
 * package into the node_modules of packages that depend on it, and `scripts/`
 * depends on nothing. Writes to stdout and nothing else, so redirecting it is the
 * whole interface and a half-written file is never left behind.
 *
 * Nothing is redacted. The data may carry account ids, ARNs and bucket names from
 * the Terraform it describes; users are told their projects are used this way, and
 * stripping it would throw away exactly the signal the harness is meant to learn.
 */

import { prisma } from "@/lib/database";

const labelledOnly = process.argv.includes("--labelled-only");

/** The `--kind` value, validated against the three starting states, or undefined. */
const KINDS = ["greenfield", "graph", "legacy"] as const;
const kindArg = process.argv[process.argv.indexOf("--kind") + 1];
const kind = (KINDS as readonly string[]).includes(kindArg ?? "")
  ? kindArg
  : undefined;

if (process.argv.includes("--kind") && !kind) {
  console.error(`--kind must be one of: ${KINDS.join(", ")}`);
  process.exit(1);
}

/** Streamed in id order and in pages, so the whole table never has to sit in memory at once. */
const PAGE = 500;

async function main(): Promise<void> {
  let cursor: string | undefined;
  let written = 0;

  for (;;) {
    const page = await prisma.projectTransformation.findMany({
      where: {
        ...(labelledOnly ? { pipelineConclusion: { not: null } } : {}),
        // Postgres JSONB path filter on the classified kind; cheap and exact.
        ...(kind ? { migrationSource: { path: ["kind"], equals: kind } } : {}),
      },
      orderBy: { id: "asc" },
      take: PAGE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });

    if (page.length === 0) break;

    for (const row of page) {
      // One compact line per row: the reader is a training pipeline, not a human,
      // and a pretty-printed object would multiply the file size for nobody.
      process.stdout.write(
        `${JSON.stringify({
          id: row.id,
          projectId: row.projectId,
          createdAt: row.createdAt.toISOString(),
          prompt: row.prompt,
          reply: row.reply,
          settings: row.settings,
          graphBefore: row.graphBefore,
          graphAfter: row.graphAfter,
          steps: row.steps,
          mutations: row.mutations,
          decisions: row.decisions,
          migrationSource: row.migrationSource,
          commits: row.commits,
          mutationErrors: row.mutationErrors,
          outcome: row.outcome,
          pipelineConclusion: row.pipelineConclusion,
        })}\n`,
      );
      written += 1;
    }

    cursor = page[page.length - 1]?.id;
    if (page.length < PAGE) break;
  }

  // To stderr, so it never lands in the JSONL a caller redirected stdout into.
  const filters = [
    kind ? `kind=${kind}` : null,
    labelledOnly ? "labelled only" : null,
  ].filter(Boolean);
  console.error(
    `Exported ${written} transformation${written === 1 ? "" : "s"}${
      filters.length ? ` (${filters.join(", ")})` : ""
    }.`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
