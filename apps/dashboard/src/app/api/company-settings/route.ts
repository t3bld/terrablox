import { NextResponse } from "next/server";

import { getCurrentUserId } from "@/lib/auth/server-helpers";
import {
  type CompanySettingsDto,
  emptyCompanySettings,
  normalizeRootFolder,
  normalizeSubmodulesPath,
} from "@/lib/company-settings";
import { database } from "@/lib/database";

function toDto(row: {
  name: string;
  terraformSubmodulesPath: string | null;
  terraformRootFolder: string | null;
}): CompanySettingsDto {
  return {
    name: row.name,
    terraformSubmodulesPath: row.terraformSubmodulesPath,
    terraformRootFolder: row.terraformRootFolder,
  };
}

export async function GET() {
  try {
    const userId = await getCurrentUserId();

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const settings = await database.companySettings.findUnique({
      where: { userId },
    });

    return NextResponse.json({
      settings: settings ? toDto(settings) : emptyCompanySettings,
    });
  } catch (e) {
    return NextResponse.json(
      {
        error:
          e instanceof Error ? e.message : "Failed to load company settings",
      },
      { status: 500 },
    );
  }
}

export async function PUT(req: Request) {
  try {
    const userId = await getCurrentUserId();

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json()) as Record<string, unknown>;
    const rawName = body["name"];
    const name = typeof rawName === "string" ? rawName.trim() : "";
    const terraformSubmodulesPath = normalizeSubmodulesPath(
      body["terraformSubmodulesPath"],
    );
    const terraformRootFolder = normalizeRootFolder(
      body["terraformRootFolder"],
    );

    const settings = await database.companySettings.upsert({
      where: { userId },
      create: {
        userId,
        name,
        terraformSubmodulesPath,
        terraformRootFolder,
      },
      update: { name, terraformSubmodulesPath, terraformRootFolder },
    });

    return NextResponse.json({ settings: toDto(settings) });
  } catch (e) {
    return NextResponse.json(
      {
        error:
          e instanceof Error ? e.message : "Failed to save company settings",
      },
      { status: 500 },
    );
  }
}
