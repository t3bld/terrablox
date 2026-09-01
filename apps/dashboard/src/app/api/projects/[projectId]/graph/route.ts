import { NextResponse } from "next/server";

import {
  getCurrentUserId,
  getProviderTokenForRequest,
} from "@/lib/auth/server-helpers";
import { GithubRequestError } from "@/lib/github/repo-files";
import { isValidLocalName } from "@/lib/projects/locals";
import { describeRepoFailure } from "@/lib/projects/repo-failure";
import {
  applyProjectMutation,
  findOwnedProject,
  loadProjectGraph,
  MutationError,
} from "@/lib/projects/service";
import type { ProjectGraphMutation } from "@/lib/projects/types";

/** Reads the graph straight from the repository, which is its source of truth. */
export async function GET(
  req: Request,
  { params }: { params: { projectId: string } },
) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const project = await findOwnedProject(userId, params.projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const token = await getProviderTokenForRequest(req, project.provider);
  if (!token) {
    return NextResponse.json(
      { error: "GitHub is not connected" },
      { status: 401 },
    );
  }

  try {
    const graph = await loadProjectGraph(token, project);
    return NextResponse.json({ graph });
  } catch (e) {
    // Diagnosed rather than forwarded: this is the request that fails for every
    // caller of the project page after a repository is deleted or renamed, so it
    // is the one that has to say which of those happened.
    return NextResponse.json(
      { error: await describeRepoFailure(token, project, e) },
      { status: e instanceof GithubRequestError ? e.status : 500 },
    );
  }
}

function parseMutation(body: unknown): ProjectGraphMutation | null {
  if (typeof body !== "object" || body === null) return null;
  const input = body as Record<string, unknown>;
  const action = input.action;

  const str = (key: string) =>
    typeof input[key] === "string" && (input[key] as string).trim()
      ? (input[key] as string).trim()
      : null;

  switch (action) {
    case "add-module": {
      const moduleId = str("moduleId");
      if (!moduleId) return null;

      const position = input.position as
        | { x?: unknown; y?: unknown }
        | undefined;

      return {
        action,
        moduleId,
        ...(str("name") ? { name: str("name") as string } : {}),
        ...(typeof position?.x === "number" && typeof position?.y === "number"
          ? { position: { x: position.x, y: position.y } }
          : {}),
      };
    }
    case "remove-module": {
      const name = str("name");
      return name ? { action, name } : null;
    }
    case "connect": {
      const source = str("source");
      const sourceOutput = str("sourceOutput");
      const target = str("target");
      const targetInput = str("targetInput");
      if (!source || !sourceOutput || !target || !targetInput) return null;
      return { action, source, sourceOutput, target, targetInput };
    }
    case "disconnect": {
      const target = str("target");
      const targetInput = str("targetInput");
      return target && targetInput ? { action, target, targetInput } : null;
    }
    case "rename-module": {
      const name = str("name");
      const newName = str("newName");
      return name && newName ? { action, name, newName } : null;
    }
    case "set-argument": {
      const name = str("name");
      const inputName = str("input");
      // An empty value is meaningful — it writes `""` — so only the presence
      // of the field is checked.
      const value = typeof input.value === "string" ? input.value : null;
      if (!name || !inputName || value === null) return null;
      return { action, name, input: inputName, value };
    }
    case "auto-connect": {
      const name = str("name");
      return name ? { action, name } : null;
    }
    case "add-local": {
      const name = str("name");
      // An empty value is meaningful for a local too: it writes `""`, which is
      // a placeholder the user then fills in.
      const value = typeof input.value === "string" ? input.value : null;
      if (!name || value === null || !isValidLocalName(name)) return null;

      const position = input.position as
        | { x?: unknown; y?: unknown }
        | undefined;
      const connectTo = input.connectTo as
        | { target?: unknown; targetInput?: unknown }
        | undefined;

      const target =
        typeof connectTo?.target === "string" ? connectTo.target.trim() : "";
      const targetInput =
        typeof connectTo?.targetInput === "string"
          ? connectTo.targetInput.trim()
          : "";

      return {
        action,
        name,
        value,
        ...(typeof position?.x === "number" && typeof position?.y === "number"
          ? { position: { x: position.x, y: position.y } }
          : {}),
        ...(target && targetInput
          ? { connectTo: { target, targetInput } }
          : {}),
      };
    }
    case "set-local": {
      const name = str("name");
      const value = typeof input.value === "string" ? input.value : null;
      return name && value !== null ? { action, name, value } : null;
    }
    case "rename-local": {
      const name = str("name");
      const newName = str("newName");
      if (!name || !newName || !isValidLocalName(newName)) return null;
      return { action, name, newName };
    }
    case "remove-local": {
      const name = str("name");
      return name ? { action, name } : null;
    }
    case "connect-local": {
      const local = str("local");
      const target = str("target");
      const targetInput = str("targetInput");
      if (!local || !target || !targetInput) return null;
      return { action, local, target, targetInput };
    }
    default:
      return null;
  }
}

/**
 * Applies a graph edit and commits it. The response carries the graph as it is
 * after the commit, so the canvas never has to guess what the repository now
 * contains.
 */
export async function POST(
  req: Request,
  { params }: { params: { projectId: string } },
) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const project = await findOwnedProject(userId, params.projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const mutation = parseMutation(await req.json().catch(() => null));
  if (!mutation) {
    return NextResponse.json(
      { error: "Unsupported or incomplete graph change" },
      { status: 400 },
    );
  }

  const token = await getProviderTokenForRequest(req, project.provider);
  if (!token) {
    return NextResponse.json(
      { error: "GitHub is not connected" },
      { status: 401 },
    );
  }

  try {
    const result = await applyProjectMutation(token, project, mutation);
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof MutationError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    // A write hits the same wall as a read once the repository is gone, and an
    // edit is where the raw 404 is least usable: nothing the user can retype
    // fixes it.
    return NextResponse.json(
      { error: await describeRepoFailure(token, project, e) },
      { status: e instanceof GithubRequestError ? e.status : 500 },
    );
  }
}
