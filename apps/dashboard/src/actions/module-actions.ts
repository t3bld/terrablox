"use server";

import { database } from "@/lib/database";

export type GitRefType = "release" | "branch";

export interface CreateModuleFromGitImportInput {
  userId: string;
  repoFullName: string;
  refType: GitRefType;
  refName: string;
  terraformRootFolder?: string;
  nameOverride?: string;
}

export async function createModuleFromGitImport(
  input: CreateModuleFromGitImportInput,
) {
  const { userId, repoFullName, refType, refName, terraformRootFolder } = input;

  // Keep the human-readable module name default predictable.
  const defaultName = repoFullName.split("/").pop() ?? repoFullName;

  // Terraform-friendly GitHub source URL pattern.
  // Note: This doesn't clone anything yet; it just records metadata for later.
  const url = `https://github.com/${repoFullName}.git?ref=${encodeURIComponent(refName)}`;

  return await database.terraformModule.create({
    data: {
      userId,
      name: input.nameOverride?.trim() || defaultName,
      versionTag: refType === "release" ? refName : null,
      url,
      terraformRootFolder: terraformRootFolder?.trim() || null,
    },
  });
}

