import { DEFAULT_TURN_TIMEOUT_SECONDS } from "@terrablox/agent-harness/runtime-options";
import { GithubRequestError } from "@terrablox/git/client";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  COPILOT_REASONING_EFFORT,
  resolveCopilotModel,
} from "@/lib/agent/copilot";
import type { AgentOverrides } from "@/lib/agent/effective-settings";
import {
  asReasoningEffort,
  getAgentSettings,
} from "@/lib/agent/settings-service";
import {
  parseJsonBody,
  requireUserId,
  requireUserWithLimit,
} from "@/lib/api/guard";
import { RATE_LIMITS } from "@/lib/api/rate-limit";
import { providerError, routeError } from "@/lib/api/route-error";
import * as schema from "@/lib/api/schemas";
import { getProviderTokenForRequest } from "@/lib/auth/server-helpers";
import { database } from "@/lib/database";
import {
  AppRepoInputError,
  appRepoColumns,
  parseAppRepoInput,
  verifyAppRepoAccess,
} from "@/lib/projects/app-repo";
import { bindExistingRepo, RepoBindError } from "@/lib/projects/bind-repo";
import { toProjectDto } from "@/lib/projects/serialize";
import { normalizeFolder } from "@/lib/projects/service";

export async function GET(_req: Request) {
  try {
    const userId = await requireUserId({ action: "projects.list" });

    const projects = await database.project.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
    });

    return NextResponse.json({ projects: projects.map(toProjectDto) });
  } catch (e) {
    // Through `routeError` rather than echoing `e.message`, which used to hand Prisma
    // error text to the caller on any failure.
    return routeError("projects.list", e);
  }
}

/**
 * The import-project request.
 *
 * A project is bound to a repository that already exists on GitHub. Creating one
 * used to be what this endpoint did, and it is gone because of the permission it
 * needed: *Administration*, which also covers deleting repositories and changing
 * collaborators, is the one organisations refuse to grant — and a repository the app
 * creates is outside an installation that was granted *selected repositories* only.
 *
 * `repo.fullName` gets GitHub's own naming rules rather than a trim, because both
 * halves become path segments in every request built from it: owners are letters,
 * digits and hyphens, names add dots and underscores, and `.`/`..` are reserved. The
 * shape check is what stops an unbounded or traversing string reaching the API; that
 * the repository is one the user may bind is `bindExistingRepo`'s job.
 *
 * `appRepo` stays `unknown`: `parseAppRepoInput` owns that shape, and it has to,
 * because the project-update route and the agent path both call it.
 */
const createBody = z.object({
  repo: z.object({
    fullName: z
      .string()
      .trim()
      .regex(
        /^[A-Za-z0-9-]{1,100}\/[A-Za-z0-9._-]{1,100}$/,
        "Expected a GitHub repository as owner/name",
      )
      .refine((value) => !/\/\.{1,2}$/.test(value), {
        message: "Expected a GitHub repository as owner/name",
      }),
  }),
  branch: schema.gitRef.nullish(),
  terraformEntryFile: schema.relativeFolder.nullish(),
  /** Optional link to the application this infrastructure is for. */
  appRepo: z.unknown().optional(),
});

/**
 * Copies the user's current agent settings onto the new project.
 *
 * The global settings are a template, not a live fallback. Without this snapshot
 * every project would keep resolving through the globals, so changing the model
 * once would change it for every project that had never overridden it — including
 * ones that have been deployed and whose behaviour someone is relying on.
 *
 * The values are resolved rather than copied verbatim. A global "no choice" is
 * stored as null, and null in an override means inherit, so copying nulls would
 * pin nothing at all. Writing the concrete effort and timeout is what makes this a
 * snapshot.
 *
 * The model is the exception. An explicit global choice that is still on the
 * user's list is pinned like everything else. "No choice" is not: it is left
 * unset, so the project keeps following the newest Anthropic model on the user's
 * list and a new Claude release becomes its default too, instead of the project
 * staying on whatever was newest the day it was created. A global choice that has
 * left the list is treated as no choice for the same reason.
 */
async function snapshotAgentSettings(
  userId: string,
  githubToken: string,
): Promise<AgentOverrides> {
  const global = await getAgentSettings(userId);
  const choice = await resolveCopilotModel(githubToken, global.model);
  const model = global.model && !choice.unavailable ? global.model : null;

  return {
    model,
    reasoningEffort:
      global.reasoningEffort ??
      asReasoningEffort(COPILOT_REASONING_EFFORT) ??
      null,
    turnTimeout: global.turnTimeout ?? DEFAULT_TURN_TIMEOUT_SECONDS,
    disabledKnowledge: global.disabledKnowledge,
    disabledTools: global.disabledTools,
  };
}

/**
 * The project's name: the repository's name.
 *
 * Nobody types one any more. It still matters, because AWS stack names, the state
 * key and the state bucket are derived from it, so two of a user's projects must not
 * share one. A second repository with the same name under another owner is
 * prefixed with that owner (`other-infra`). Compared case-insensitively, since the
 * derived names are lower-cased anyway.
 */
async function projectNameFor(
  userId: string,
  repoFullName: string,
): Promise<string> {
  const [owner = "", repoName = repoFullName] = repoFullName.split("/");

  const taken = await database.project.findMany({
    where: { userId },
    select: { name: true },
  });
  const used = new Set(taken.map((project) => project.name.toLowerCase()));

  return used.has(repoName.toLowerCase()) ? `${owner}-${repoName}` : repoName;
}

/** Terraform files are `.tf`; anything else could never hold a module block. */
function normalizeEntryFile(input: string | null | undefined): string {
  const raw = (input ?? "").trim().replace(/^\/+/, "");
  if (!raw) return "main.tf";
  return raw.endsWith(".tf") ? raw : `${raw}.tf`;
}

/**
 * Imports an existing repository as a project.
 *
 * The binding is mandatory: the graph is a view of the repository, so a project
 * without one would have nothing to show and nowhere to write changes to.
 *
 * Nothing is created on GitHub, so nothing can be left behind there: every check runs
 * before the one write this handler makes, which is the project row.
 */
export async function POST(req: Request) {
  let userId: string;
  let body: z.infer<typeof createBody>;
  try {
    // Kept on the infrastructure budget even though no repository is created any
    // more: each attempt lists every installation's repositories and walks a whole
    // tree on GitHub, and that spends the user's GitHub rate limit, not ours.
    userId = await requireUserWithLimit(
      "project.create",
      RATE_LIMITS.infrastructure,
    );
    body = await parseJsonBody(req, createBody);
  } catch (error) {
    return routeError("project.create", error);
  }

  const token = await getProviderTokenForRequest(req, "github");
  if (!token) {
    return NextResponse.json(
      { error: "GitHub is not connected" },
      { status: 401 },
    );
  }

  // Parsed *and verified* before the project is stored, so a link that cannot be
  // read is refused here rather than failing in the middle of the first agent turn.
  let appRepo: ReturnType<typeof parseAppRepoInput>;
  try {
    appRepo = parseAppRepoInput(body.appRepo);
    if (appRepo) appRepo = await verifyAppRepoAccess(token, appRepo);
  } catch (e) {
    return NextResponse.json(
      {
        error:
          e instanceof AppRepoInputError
            ? e.message
            : "Invalid application repository",
      },
      { status: 400 },
    );
  }

  // The refusals carry their own message because each one has a fix on GitHub —
  // grant the repository, give it a first commit, pick one without Terraform — and
  // a generic "invalid repository" would leave the user guessing which.
  let bound: Awaited<ReturnType<typeof bindExistingRepo>>;
  try {
    bound = await bindExistingRepo(token, body.repo.fullName, body.branch);
  } catch (e) {
    if (e instanceof RepoBindError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    // Status kept, body dropped: GitHub's own text is about GitHub's API, not about
    // anything the person in the dialog can change.
    if (e instanceof GithubRequestError) {
      return providerError(
        "project.create",
        e,
        "Could not check the repository on GitHub. Try again in a moment.",
      );
    }
    return routeError("project.create", e);
  }

  try {
    const project = await database.project.create({
      data: {
        userId,
        name: await projectNameFor(userId, bound.repo.fullName),
        provider: "github",
        repoFullName: bound.repo.fullName,
        repoUrl: bound.repo.htmlUrl,
        repoBranch: bound.branch,
        // `bindExistingRepo` accepts only repositories without a single `.tf` file,
        // so the root configuration can only be the repository root. Nothing to
        // detect and nothing to ask.
        terraformRootFolder: normalizeFolder(null),
        terraformEntryFile: normalizeEntryFile(body.terraformEntryFile),
        ...appRepoColumns(appRepo ?? null),
        // Round-tripped through JSON so Prisma sees a plain value, the same way
        // `saveAgentOverrides` does it: `AgentOverrides` has optional keys, which
        // its `InputJsonValue` type will not accept.
        agentOverrides: JSON.parse(
          JSON.stringify(await snapshotAgentSettings(userId, token)),
        ),
      },
    });

    return NextResponse.json(
      { project: toProjectDto(project) },
      { status: 201 },
    );
  } catch (e) {
    // Through `routeError` rather than echoing `e.message`: what can fail here is
    // the database, and its error text is not for the browser.
    return routeError("project.create", e);
  }
}
