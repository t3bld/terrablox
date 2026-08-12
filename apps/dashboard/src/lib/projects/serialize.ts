import type { Project, ProjectChatMessage } from "@terrablox/database";

import type { ProjectChatMessageDto, ProjectDto } from "./types";

export function toProjectDto(project: Project): ProjectDto {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    provider: project.provider,
    repoFullName: project.repoFullName,
    repoUrl: project.repoUrl,
    repoBranch: project.repoBranch,
    terraformRootFolder: project.terraformRootFolder,
    terraformEntryFile: project.terraformEntryFile,
    lastSyncedSha: project.lastSyncedSha,
    lastSyncedAt: project.lastSyncedAt?.toISOString() ?? null,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}

export function toChatMessageDto(
  message: ProjectChatMessage,
): ProjectChatMessageDto {
  const role = message.role;

  return {
    id: message.id,
    role: role === "user" || role === "assistant" ? role : "system",
    content: message.content,
    metadata:
      typeof message.metadata === "object" &&
      message.metadata !== null &&
      !Array.isArray(message.metadata)
        ? (message.metadata as Record<string, unknown>)
        : {},
    createdAt: message.createdAt.toISOString(),
  };
}
