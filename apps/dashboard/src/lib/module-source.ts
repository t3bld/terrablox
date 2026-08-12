/**
 * Condenses a Terraform module source into something that fits on a graph node.
 *
 * A source like
 * `git::https://github.com/porsche-code/aac-aws-vmland.git//terraform?ref=1.0.1`
 * carries the host, the subdirectory and the ref, none of which distinguish one
 * node from another in a graph where every call points at the same forge. The
 * repository name does.
 *
 * The full source is never thrown away — it is shown in the detail panel.
 */
export function shortModuleSource(
  source: string | null | undefined,
  sourceKind?: string | null,
): string | null {
  const trimmed = source?.trim();
  if (!trimmed) return null;

  // Terraform's forwarding prefixes: `git::`, `hg::`, `s3::`, …
  const withoutForwarder = trimmed.replace(/^[a-z][a-z0-9+.-]*::/i, "");

  // Relative paths are already short and their shape is the information.
  if (/^\.{1,2}\//.test(withoutForwarder) || sourceKind === "local") {
    return withoutForwarder;
  }

  const withoutQuery = withoutForwarder.split("?")[0] ?? "";
  const repoPart = stripSubdirectory(withoutQuery);
  const segments = pathSegments(repoPart);
  if (segments.length === 0) return withoutQuery || null;

  // Registry addresses are `[<host>/]<namespace>/<name>/<provider>`, so the
  // meaningful part is the second to last segment, not the last.
  if (sourceKind === "registry" && segments.length >= 3) {
    return segments[segments.length - 2] ?? null;
  }

  const last = segments[segments.length - 1];
  if (!last) return withoutQuery || null;

  return last.replace(/\.git$/i, "") || last;
}

/**
 * Removes Terraform's `//subdir` suffix without mistaking it for the `//` that
 * follows a URL scheme.
 */
function stripSubdirectory(source: string): string {
  const schemeEnd = source.indexOf("://");
  const from = schemeEnd >= 0 ? schemeEnd + 3 : 0;
  const subdirAt = source.indexOf("//", from);

  return subdirAt >= 0 ? source.slice(0, subdirAt) : source;
}

function pathSegments(repoPart: string): string[] {
  // scp-style remotes (`git@github.com:org/repo.git`) put the path after a
  // colon rather than a slash.
  const withoutHost =
    !repoPart.includes("://") && /^[^/]*@[^/]*:/.test(repoPart)
      ? (repoPart.split(":").pop() ?? repoPart)
      : repoPart;

  return withoutHost.split("/").filter(Boolean);
}
