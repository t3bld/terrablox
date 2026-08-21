import { NextResponse } from "next/server";
import {
  getCurrentUserId,
  getProviderTokenForRequest,
} from "@/lib/auth/server-helpers";
import { parseIconChoice } from "@/lib/modules/icon";
import {
  type GitRefType,
  importModuleFromGit,
} from "@/lib/modules/import-from-git";

/**
 * Imports a repository into the signed-in user's module library.
 *
 * Authentication, validation and status codes only: the pipeline itself lives in
 * {@link importModuleFromGit} because the shipped catalogue runs the same one
 * with a null owner.
 */
interface CreateModuleFromGitImportInput {
  repoFullName: string;
  refType: GitRefType;
  refName: string;
  terraformRootFolder?: string;
  terraformSubmodulesFolders?: string[];
  nameOverride?: string;
  description?: string;
  tags?: string[];
  /** `{ mode, iconName }`; absent leaves whatever the source row already says. */
  icon?: unknown;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Partial<CreateModuleFromGitImportInput>;

    const userId = await getCurrentUserId();
    const repoFullName = body.repoFullName?.trim();
    const refType = body.refType;
    const refName = body.refName?.trim();

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!repoFullName || !repoFullName.includes("/")) {
      return NextResponse.json(
        { error: "Missing repoFullName" },
        { status: 400 },
      );
    }

    if (refType !== "release" && refType !== "branch" && refType !== "tag") {
      return NextResponse.json({ error: "Invalid refType" }, { status: 400 });
    }

    // Null for a caller that said nothing, which leaves the stored choice alone.
    // Anything malformed is treated the same way rather than rejected: the icon is
    // decoration, and failing an import over it would be out of proportion.
    const icon = parseIconChoice(body.icon);

    if (!refName) {
      return NextResponse.json({ error: "Missing refName" }, { status: 400 });
    }

    const token = await getProviderTokenForRequest(req, "github");
    if (!token) {
      return NextResponse.json(
        { error: "Missing or invalid provider token" },
        { status: 401 },
      );
    }

    const result = await importModuleFromGit({
      userId,
      token,
      repoFullName,
      refType,
      refName,
      terraformRootFolder: body.terraformRootFolder,
      terraformSubmodulesFolders: body.terraformSubmodulesFolders,
      nameOverride: body.nameOverride,
      description: body.description,
      tags: body.tags,
      icon,
    });

    return NextResponse.json(
      {
        module: result.module,
        submodules: result.submodules,
        source: result.source,
        warnings: result.warnings,
      },
      { status: 201 },
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to import module" },
      { status: 500 },
    );
  }
}
