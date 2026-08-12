import { NextResponse } from "next/server";

import {
  getCurrentUserId,
  getProviderTokenForRequest,
} from "@/lib/auth/server-helpers";
import { database } from "@/lib/database";
import {
  createRepository,
  GithubRequestError,
  getRepository,
} from "@/lib/github/repo-files";
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

interface CreateProjectBody {
  name?: string;
  description?: string | null;
  repo?:
    | { mode: "existing"; fullName?: string }
    | { mode: "new"; name?: string; owner?: string | null; private?: boolean };
  branch?: string | null;
  terraformRootFolder?: string | null;
  terraformEntryFile?: string | null;
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

  try {
    const repo =
      body.repo.mode === "existing"
        ? await resolveExistingRepo(token, body.repo.fullName)
        : await createRepository(token, {
            name: requireRepoName(body.repo.name),
            owner: body.repo.owner ?? null,
            description: body.description ?? null,
            private: body.repo.private ?? true,
          });

    const project = await database.project.create({
      data: {
        userId,
        name,
        description: body.description?.trim() || null,
        provider: "github",
        repoFullName: repo.fullName,
        repoUrl: repo.htmlUrl,
        repoBranch: body.branch?.trim() || repo.defaultBranch,
        terraformRootFolder: normalizeFolder(body.terraformRootFolder),
        terraformEntryFile: normalizeEntryFile(body.terraformEntryFile),
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

async function resolveExistingRepo(
  token: string,
  fullName: string | undefined,
) {
  const repoFullName = fullName?.trim();
  if (!repoFullName?.includes("/")) {
    throw new GithubRequestError("Select a repository first", 400);
  }
  return getRepository(token, repoFullName);
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
