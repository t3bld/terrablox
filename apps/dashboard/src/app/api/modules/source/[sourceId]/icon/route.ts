import { NextResponse } from "next/server";

import {
  getCurrentUserId,
  getProviderTokenForRequest,
} from "@/lib/auth/server-helpers";
import { database } from "@/lib/database";
import { visibleModulesForUser } from "@/lib/module-library/visibility";

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

/**
 * The image types this route will serve, as an allowlist.
 *
 * SVG is deliberately absent, and it is the reason this list exists rather than a
 * `startsWith("image/")` check. An SVG is a document: it can carry `<script>`, and a
 * browser navigating straight to this URL would execute it *on this app's origin*,
 * with access to the session cookie. `X-Content-Type-Options: nosniff` does not help
 * — it stops a browser guessing a different type, not a legitimately-declared SVG
 * running its own script.
 *
 * That mattered because `icon.svg` is one of the two file names the importer looks
 * for (`lib/module-library/icon.ts`), so any repository could ship one and, once imported,
 * hand itself a stored-XSS URL on our origin. Raster formats have no script
 * semantics, so the allowlist costs nothing an icon needs.
 */
const SERVABLE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);

export async function GET(
  req: Request,
  { params }: { params: { sourceId: string } },
) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const visibility = await visibleModulesForUser(userId);
  const source = await database.terraformModuleSource.findFirst({
    where: { id: params.sourceId, ...visibility },
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
    // The request carries a GitHub token. Following a redirect would attach that
    // Authorization header to whatever host the redirect names, which is how a
    // token leaves the systems it was issued for — the host allowlist above only
    // constrains the URL we choose, not the one we might be sent to.
    redirect: "manual",
  });

  if (!upstream.ok || !upstream.body) {
    // 404 rather than the upstream status: to the caller this is simply "no
    // icon", and the component falls back on it either way. A 3xx lands here too,
    // since `redirect: "manual"` reports it as a non-ok response.
    return NextResponse.json({ error: "No icon" }, { status: 404 });
  }

  // Parameters stripped before matching: `image/png; charset=utf-8` is a real thing
  // to receive, and comparing the whole header would reject it.
  const type = (upstream.headers.get("content-type") ?? "")
    .split(";")[0]
    ?.trim()
    .toLowerCase();

  if (!type || !SERVABLE_TYPES.has(type)) {
    return NextResponse.json({ error: "No icon" }, { status: 404 });
  }

  return new NextResponse(upstream.body, {
    headers: {
      "Content-Type": type,
      "Cache-Control": CACHE_CONTROL,
      // The bytes come from another origin; nothing here should be sniffed as
      // anything but an image.
      "X-Content-Type-Options": "nosniff",
      // Belt and braces behind the type allowlist: even if something scriptable
      // reached this response, this policy gives it nothing to run and nowhere to
      // call. `sandbox` drops it into an opaque origin, so it cannot touch cookies.
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      // Not a document. Stops a direct navigation from rendering it as a page at all
      // in browsers that honour it for images.
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  });
}
