"use server";

import { database } from "@/lib/database";

export type GitRefType = "release" | "branch";

export interface CreateModuleFromGitImportInput {
  userId: string;
  repoFullName: string;
  refType: GitRefType;
  refName: string;
  terraformRootFolder?: string;
  terraformSubmodulesFolders?: string[];
  nameOverride?: string;
  description?: string;
  tags?: string[];
}

function normalizeFolderPath(input?: string | null) {
  const raw = (input ?? "").trim();
  if (!raw) return null;
  const normalized = raw.replace(/^\/+/, "").replace(/\/+$/, "");
  return normalized === "" ? null : normalized;
}

function normalizeTags(tags?: string[] | null) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tags ?? []) {
    const n = t.trim().replace(/\s+/g, "-").toLowerCase();
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

export async function createModuleFromGitImport(
  input: CreateModuleFromGitImportInput,
) {
  const {
    userId,
    repoFullName,
    refType,
    refName,
    terraformRootFolder,
    terraformSubmodulesFolders,
    nameOverride,
    description,
    tags,
  } = input;

  // Keep the human-readable module name default predictable.
  const defaultName = repoFullName.split("/").pop() ?? repoFullName;

  // Terraform-friendly GitHub source URL pattern.
  // Note: This doesn't clone anything yet; it just records metadata for later.
  const url = `https://github.com/${repoFullName}.git?ref=${encodeURIComponent(refName)}`;

  const sourceName = (nameOverride?.trim() || defaultName).trim();
  const canonicalSourceUrl = `https://github.com/${repoFullName}.git`;

  const existingSource = await database.terraformModuleSource.findFirst({
    where: { userId, url: canonicalSourceUrl },
    select: { id: true },
  });

  const source = existingSource
    ? await database.terraformModuleSource.update({
        where: { id: existingSource.id },
        data: {
          name: sourceName,
          description: description?.trim() || null,
          tags: normalizeTags(tags),
        },
      })
    : await database.terraformModuleSource.create({
        data: {
          userId,
          name: sourceName,
          description: description?.trim() || null,
          tags: normalizeTags(tags),
          url: canonicalSourceUrl,
          provider: "github",
        },
      });

  return await database.terraformModule.create({
    data: {
      userId,
      sourceId: source.id,
      versionTag: refType === "release" ? refName : null,
      url,
      terraformRootFolder: normalizeFolderPath(terraformRootFolder) ?? ".",
      terraformSubmodulesFolders: (terraformSubmodulesFolders ?? [])
        .map((p) => normalizeFolderPath(p))
        .filter((p): p is string => !!p && p !== "."),
    },
  });
}
