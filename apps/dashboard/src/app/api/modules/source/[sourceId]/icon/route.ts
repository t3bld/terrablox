import { NextResponse } from "next/server";

import {
  getCurrentUserId,
  getProviderTokenForRequest,
} from "@/lib/auth/server-helpers";
import { database } from "@/lib/database";
import { visibleToUser } from "@/lib/modules/ownership";

/**
 * Serves the `icon.png` a repository ships.
 *
 * A proxy rather than a link, because a private repository's raw URL needs a
 * token: linking it directly would work for the public catalogue and quietly show
 * the default icon for every module a company imported itself, which is the case
 * where a recognisable icon is worth the most.
 *
 * Only the URL recorded at import is fetched, and only from GitHub's raw host, so
 * a tampered row cannot turn this into an open proxy for arbitrary addresses.
 */
const ALLOWED_HOST = "raw.githubusercontent.com";

/** An icon changes about as often as the repository is re-imported. */
const CACHE_CONTROL = "private, max-age=3600, stale-while-revalidate=86400";

export async function GET(
  req: Request,
  { params }: { params: { sourceId: string } },
) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const source = await database.terraformModuleSource.findFirst({
    where: { id: params.sourceId, ...visibleToUser(userId) },
    select: { iconUrl: true },
  });

  if (!source?.iconUrl) {
    return NextResponse.json({ error: "No icon" }, { status: 404 });
  }

  let url: URL;
  try {
    url = new URL(source.iconUrl);
  } catch {
    return NextResponse.json({ error: "No icon" }, { status: 404 });
  }

  if (url.protocol !== "https:" || url.host !== ALLOWED_HOST) {
    return NextResponse.json({ error: "No icon" }, { status: 404 });
  }

  const token = await getProviderTokenForRequest(req, "github");

  const upstream = await fetch(url, {
    // Public repositories need no token, so a missing one is not fatal here.
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    cache: "no-store",
  });

  if (!upstream.ok || !upstream.body) {
    // 404 rather than the upstream status: to the caller this is simply "no
    // icon", and the component falls back on it either way.
    return NextResponse.json({ error: "No icon" }, { status: 404 });
  }

  const type = upstream.headers.get("content-type") ?? "";
  if (!type.startsWith("image/")) {
    return NextResponse.json({ error: "No icon" }, { status: 404 });
  }

  return new NextResponse(upstream.body, {
    headers: {
      "Content-Type": type,
      "Cache-Control": CACHE_CONTROL,
      // The bytes come from another origin; nothing here should be sniffed as
      // anything but an image.
      "X-Content-Type-Options": "nosniff",
    },
  });
}
