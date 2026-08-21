import { NextResponse } from "next/server";

import { COPILOT_MODEL, COPILOT_REASONING_EFFORT } from "@/lib/agent/copilot";
import type { AgentOverrides } from "@/lib/agent/effective-settings";
import { DEFAULT_TURN_TIMEOUT_SECONDS } from "@/lib/agent/runtime-options";
import {
  asReasoningEffort,
  getAgentSettings,
} from "@/lib/agent/settings-service";
import {
  getCurrentUserId,
  getProviderTokenForRequest,
} from "@/lib/auth/server-helpers";
import { database } from "@/lib/database";
import { createRepository, GithubRequestError } from "@/lib/github/repo-files";
import {
  type AppRepoInput,
  AppRepoInputError,
  appRepoColumns,
  parseAppRepoInput,
} from "@/lib/projects/app-repo";
import { toProjectDto } from "@/lib/projects/serialize";
import { normalizeFolder } from "@/lib/projects/service";

export async function GET(_req: Request) {
  try {
    const userId = await getCurrentUserId();

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const projects = await database.project.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
    });

    return NextResponse.json({ projects: projects.map(toProjectDto) });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to load projects" },
      { status: 500 },
    );
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
interface CreateProjectBody {
  name?: string;
  repo?: { name?: string; owner?: string | null; private?: boolean };
  branch?: string | null;
  terraformEntryFile?: string | null;
  /** Optional link to the application this infrastructure is for. */
  appRepo?: AppRepoInput | null;
}

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
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as CreateProjectBody | null;
  const name = body?.name?.trim();

  if (!name) {
    return NextResponse.json(
      { error: "Missing project name" },
      { status: 400 },
    );
  }
  if (!body?.repo) {
    return NextResponse.json(
      { error: "A project needs a repository" },
      { status: 400 },
    );
  }

  const token = await getProviderTokenForRequest(req, "github");
  if (!token) {
    return NextResponse.json(
      { error: "GitHub is not connected" },
      { status: 401 },
    );
  }

  // Parsed before the repository is created: a rejected link would otherwise
  // leave a repository on GitHub for a project that was never stored.
  let appRepo: ReturnType<typeof parseAppRepoInput>;
  try {
    appRepo = parseAppRepoInput(body.appRepo);
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
