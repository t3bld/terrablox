"use server";

import { database } from "../lib/database";
import type { Project } from "@terrablox/database";

export async function getProjects(userId: string): Promise<Project[]> {
  try {
    return await database.project.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
  } catch {
    return [];
  }
}

export async function getProjectCount(userId: string): Promise<number> {
  try {
    return await database.project.count({ where: { userId } });
  } catch {
    return 0;
  }
}

export async function getModuleCount(userId: string): Promise<number> {
  try {
    return await database.terraformModule.count({ where: { userId } });
  } catch {
    return 0;
  }
}
