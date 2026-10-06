import { DEFAULT_TURN_TIMEOUT_SECONDS } from "@terrablox/agent-harness/runtime-options";
import { GithubRequestError } from "@terrablox/git/client";
import {
  createRepository,
  RepoOwnerNotWritableError,
  verifyOwnerCanHoldNewRepo,
} from "@terrablox/git/repositories";
import { NextResponse } from "next/server";
import { z } from "zod";
import { COPILOT_MODEL, COPILOT_REASONING_EFFORT } from "@/lib/agent/copilot";
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
import { routeError } from "@/lib/api/route-error";
import * as schema from "@/lib/api/schemas";
import { getProviderTokenForRequest } from "@/lib/auth/server-helpers";
import { database } from "@/lib/database";
import {
  AppRepoInputError,
  appRepoColumns,
  parseAppRepoInput,
  verifyAppRepoAccess,
} from "@/lib/projects/app-repo";
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
 * A project is always created together with a fresh repository.
 *
 * Adopting an existing one used to be the other half of this endpoint. It is gone
 * on purpose: it forced every caller to also say which folder inside that
 * repository held the root configuration, and a wrong answer there produced an
 * empty graph with no explanation. A repository we create has exactly one
 * possible answer, so there is no question left to get wrong.
 */
/**
 * The create-project request.
 *
 * `repo.name` and `repo.owner` are the values a GitHub repository is created from, so
 * they get GitHub's own naming rules rather than a trim. `requireRepoName` below still
 * runs — it produces the message the wizard shows — but a shape check here is what
 * stops an unbounded string reaching the API call.
 *
 * `appRepo` stays `unknown`: `parseAppRepoInput` owns that shape, and it has to,
 * because the project-update route and the agent path both call it.
 */
const createBody = z.object({
  name: schema.displayText(200),
  repo: z.object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(
        /^[A-Za-z0-9._-]+$/,
        "A repository name may only contain letters, digits, dots, hyphens and underscores",
      ),
    owner: z
      .string()
      .trim()
      .max(100)
      .regex(/^[A-Za-z0-9-]*$/, "That is not a GitHub owner name")
      .nullish(),
    private: z.boolean().optional(),
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
 * pin nothing at all. Writing the concrete model, effort and timeout is what makes
 * this a snapshot.
 */
async function snapshotAgentSettings(userId: string): Promise<AgentOverrides> {
  const global = await getAgentSettings(userId);

  return {
    model: global.model ?? COPILOT_MODEL,
    reasoningEffort:
      global.reasoningEffort ??
      asReasoningEffort(COPILOT_REASONING_EFFORT) ??
      null,
    turnTimeout: global.turnTimeout ?? DEFAULT_TURN_TIMEOUT_SECONDS,
    disabledKnowledge: global.disabledKnowledge,
    disabledTools: global.disabledTools,
  };
}

/** Terraform files are `.tf`; anything else could never hold a module block. */
function normalizeEntryFile(input: string | null | undefined): string {
  const raw = (input ?? "").trim().replace(/^\/+/, "");
  if (!raw) return "main.tf";
  return raw.endsWith(".tf") ? raw : `${raw}.tf`;
}

/**
 * Creates a project together with the repository it is bound to.
 *
 * The binding is mandatory: the graph is a view of the repository, so a project
 * without one would have nothing to show and nowhere to write changes to.
 */
export async function POST(req: Request) {
  let userId: string;
  let body: z.infer<typeof createBody>;
  try {
    // Creating a project creates a *repository* on GitHub, so this is rate limited on
    // the infrastructure budget rather than the ordinary write one.
    userId = await requireUserWithLimit(
      "project.create",
      RATE_LIMITS.infrastructure,
    );
    body = await parseJsonBody(req, createBody);
  } catch (error) {
    return routeError("project.create", error);
  }

  const name = body.name;

  const token = await getProviderTokenForRequest(req, "github");
  if (!token) {
    return NextResponse.json(
      { error: "GitHub is not connected" },
      { status: 401 },
    );
  }

  // Parsed *and verified* before the repository is created: a rejected link would
  // otherwise leave a repository on GitHub for a project that was never stored.
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

  // Asked before the repository exists, for the same reason the app-repo link is
  // verified above: GitHub will create a repository outside the installation's
  // grant without complaint, and the refusal would then arrive at the first write —
  // leaving an empty repository behind for a project that was never stored.
  try {
    await verifyOwnerCanHoldNewRepo(token, body.repo.owner ?? null);
  } catch (e) {
    if (e instanceof RepoOwnerNotWritableError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    throw e;
  }

  try {
    const repo = await createRepository(token, {
      name: requireRepoName(body.repo.name),
      owner: body.repo.owner ?? null,
      private: body.repo.private ?? true,
    });

    const project = await database.project.create({
      data: {
        userId,
        name,
        provider: "github",
        repoFullName: repo.fullName,
        repoUrl: repo.htmlUrl,
        repoBranch: body.branch?.trim() || repo.defaultBranch,
        // A repository we just created holds nothing but a README, so the root
        // configuration can only be the repository root. Nothing to detect and
        // nothing to ask.
        terraformRootFolder: normalizeFolder(null),
        terraformEntryFile: normalizeEntryFile(body.terraformEntryFile),
        ...appRepoColumns(appRepo ?? null),
        // Round-tripped through JSON so Prisma sees a plain value, the same way
        // `saveAgentOverrides` does it: `AgentOverrides` has optional keys, which
        // its `InputJsonValue` type will not accept.
        agentOverrides: JSON.parse(
          JSON.stringify(await snapshotAgentSettings(userId)),
        ),
      },
    });

    return NextResponse.json(
      { project: toProjectDto(project) },
      { status: 201 },
    );
  } catch (e) {
    const status = e instanceof GithubRequestError ? e.status : 500;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to create project" },
      { status: status === 404 ? 400 : status },
    );
  }
}

function requireRepoName(name: string | undefined): string {
  const trimmed = name?.trim();
  if (!trimmed) {
    throw new GithubRequestError("Missing repository name", 400);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new GithubRequestError(
      "Repository names may only contain letters, digits, '.', '_' and '-'",
      400,
    );
  }
  return trimmed;
}
