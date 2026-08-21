import { NextResponse } from "next/server";

import { getCurrentUserId } from "@/lib/auth/server-helpers";
import { database } from "@/lib/database";
import { parseGraphLayout } from "@/lib/graph-layout";
import { visibleToUser } from "@/lib/modules/ownership";

/**
 * Confirms the session user may read this module. Never taken from the request:
 * a client-supplied id would let any caller read or overwrite another user's
 * layout.
 *
 * Visibility rather than ownership, because a layout belongs to the person who
 * dragged the nodes, not to the module. A shipped module has to be arrangeable
 * too, and the layout row stays private either way — it is keyed by
 * `(userId, moduleId, graph)`, so two users arranging the same shipped module
 * keep separate rows.
 */
async function findVisibleModule(userId: string, moduleId: string) {
  return database.terraformModule.findFirst({
    where: { id: moduleId, ...visibleToUser(userId) },
    select: { id: true },
  });
}

type RouteContext = { params: { moduleId: string } };

/**
 * A module is drawn by more than one diagram and their node ids are unrelated,
 * so each keeps its own row. Restricted to a known set: an arbitrary value from
 * the query string would let a caller fill the table with rows nothing reads.
 */
const GRAPHS = ["connections", "architecture"] as const;
type GraphKind = (typeof GRAPHS)[number];

function readGraph(req: Request): GraphKind | null {
  const raw = new URL(req.url).searchParams.get("graph");
  if (raw === null) return "connections";
  return GRAPHS.includes(raw as GraphKind) ? (raw as GraphKind) : null;
}

/** Shared preamble: authenticate, validate the id, verify ownership. */
async function resolveRequest(req: Request, { params }: RouteContext) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return {
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  const moduleId = params.moduleId?.trim();
  if (!moduleId) {
    return {
      error: NextResponse.json({ error: "Missing moduleId" }, { status: 400 }),
    };
  }

  const graph = readGraph(req);
  if (!graph) {
    return {
      error: NextResponse.json({ error: "Unknown graph" }, { status: 400 }),
    };
  }

  if (!(await findVisibleModule(userId, moduleId))) {
    return {
      error: NextResponse.json({ error: "Module not found" }, { status: 404 }),
    };
  }

  return { userId, moduleId, graph };
}

export async function GET(req: Request, context: RouteContext) {
  const resolved = await resolveRequest(req, context);
  if (resolved.error) return resolved.error;
  const { userId, moduleId, graph } = resolved;

  const layout = await database.moduleGraphLayout.findUnique({
    where: { userId_moduleId_graph: { userId, moduleId, graph } },
    select: { positions: true },
  });

  return NextResponse.json({ positions: parseGraphLayout(layout?.positions) });
}

export async function PUT(req: Request, context: RouteContext) {
  const resolved = await resolveRequest(req, context);
  if (resolved.error) return resolved.error;
  const { userId, moduleId, graph } = resolved;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const positions = parseGraphLayout(
    (body as { positions?: unknown } | null)?.positions,
  );

  // An empty layout means "back to the computed arrangement". Deleting rather
  // than storing `{}` keeps the table free of rows that say nothing.
  if (Object.keys(positions).length === 0) {
    await database.moduleGraphLayout.deleteMany({
      where: { userId, moduleId, graph },
    });
    return NextResponse.json({ positions: {} });
  }

  await database.moduleGraphLayout.upsert({
    where: { userId_moduleId_graph: { userId, moduleId, graph } },
    create: { userId, moduleId, graph, positions },
    update: { positions },
  });

  return NextResponse.json({ positions });
}

export async function DELETE(req: Request, context: RouteContext) {
  const resolved = await resolveRequest(req, context);
  if (resolved.error) return resolved.error;
  const { userId, moduleId, graph } = resolved;

  await database.moduleGraphLayout.deleteMany({
    where: { userId, moduleId, graph },
  });

  return NextResponse.json({ positions: {} });
}
