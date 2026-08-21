import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/auth/server-helpers";
import { readProjectAwsState } from "@/lib/aws/project-connection";
import { database } from "@/lib/database";
import { findOwnedProject } from "@/lib/projects/service";

/**
 * The AWS account one project deploys into.
 *
 * Project-scoped on purpose. The old user-level status said "this user has some
 * AWS connection", which unlocked the Deploy tab of a project that had no account
 * of its own and then failed the moment it tried to read anything.
 */
export async function GET(
  _request: Request,
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

  return NextResponse.json({ aws: await readProjectAwsState(userId, project) });
}

const REGION_PATTERN = /^[a-z]{2}(-[a-z]+)+-\d$/;

/**
 * Points this project at one of the user's connected accounts.
 *
 * Separate from the connect flow, which creates the connection: signing in to an
 * AWS account and deciding that *this* project deploys into it are two decisions,
 * and only the second one is per project.
 */
export async function PUT(
  request: Request,
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

  let body: { accountId?: unknown; region?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
  }

  const accountId = typeof body.accountId === "string" ? body.accountId : "";
  const region = typeof body.region === "string" ? body.region.trim() : "";

  if (!/^\d{12}$/.test(accountId)) {
    return NextResponse.json(
      { error: "That is not an AWS account ID." },
      { status: 400 },
    );
  }

  if (region && !REGION_PATTERN.test(region)) {
    return NextResponse.json(
      { error: "Enter a region like eu-central-1." },
      { status: 400 },
    );
  }

  // The account has to be one the user actually signed in to. Without this check
  // a project could name any account and the tabs would unlock on a connection
  // that does not exist.
  const connection = await database.awsConnection.findFirst({
    where: { userId, accountId },
    select: { id: true, region: true },
  });

  if (!connection) {
    return NextResponse.json(
      { error: `Account ${accountId} is not connected.` },
      { status: 400 },
    );
  }

  const updated = await database.project.update({
    where: { id: project.id },
    data: {
      awsAccountId: accountId,
      ...(region ? { awsRegion: region } : {}),
    },
  });

  return NextResponse.json({
    aws: await readProjectAwsState(userId, updated),
  });
}

/** Unlinks the account, leaving the sign-in itself alone. */
export async function DELETE(
  _request: Request,
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

  const updated = await database.project.update({
    where: { id: project.id },
    data: { awsAccountId: null },
  });

  return NextResponse.json({
    aws: await readProjectAwsState(userId, updated),
  });
}
