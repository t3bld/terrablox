/**
 * URL schemes that are safe to put in an `href` or `src` rendered from markdown.
 *
 * `react-markdown` sanitises URLs itself — but only on the elements it creates. Both
 * markdown renderers in this app override the `a` component (and the README one
 * overrides `img`), and an override receives the value and decides what to do with
 * it. On current versions the value has already been through `urlTransform`, so this
 * is defence in depth rather than a live hole; it stops being defence in depth the
 * moment someone upgrades, downgrades, or adds a third renderer that forgets.
 *
 * The scheme that matters is `javascript:`, where a click executes script in the
 * page. `data:` is refused for links too: a `data:text/html` navigation runs in an
 * origin the browser derives from the document, and there is no reason a README
 * needs one.
 */
const SAFE_LINK_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/**
 * Schemes allowed for images, which are strictly less dangerous than links: an
 * `<img src>` is never navigated to, so `data:` is a real convenience — inline
 * diagrams and badges use it — with no script semantics attached.
 */
const SAFE_IMAGE_SCHEMES = new Set(["http:", "https:", "data:"]);

/**
 * Whether a URL is safe in the given position.
 *
 * Relative URLs and fragments pass: they resolve against this document, so they
 * cannot introduce a scheme. Anything with a scheme is checked against the allowlist,
 * and anything unparseable is refused.
 *
 * The leading-whitespace strip matters. Browsers tolerate `\tjava\nscript:alert(1)`
 * inside an attribute, and a naive `startsWith("javascript:")` misses it — parsing
 * with `URL` rather than matching text is what makes that irrelevant here.
 */
function isSafe(url: string, allowed: ReadonlySet<string>): boolean {
  const trimmed = url.trim();
  if (trimmed === "") return false;

  // Fragment or clearly relative: no scheme, nothing to exploit.
  if (trimmed.startsWith("#") || trimmed.startsWith("/")) return true;

  try {
    // A base is supplied so a relative path parses instead of throwing; the scheme
    // of the result is then the base's, which is in the allowlist.
    const parsed = new URL(trimmed, "https://terrablox.invalid/");
    return allowed.has(parsed.protocol);
  } catch {
    return false;
  }
}

/** An `href` that is safe to render, or undefined so no link is produced. */
export function safeLinkHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  return isSafe(href, SAFE_LINK_SCHEMES) ? href : undefined;
}

/** A `src` that is safe to render, or undefined so no image is produced. */
export function safeImageSrc(src: string | undefined): string | undefined {
  if (!src) return undefined;
  return isSafe(src, SAFE_IMAGE_SCHEMES) ? src : undefined;
}

/**
 * Resolves a possibly-relative markdown URL against a repository base, then checks it.
 *
 * README links and images are written relative to the repository, so they have to be
 * rebased to survive rendering here. Resolution happens first and validation second,
 * deliberately: a relative path is harmless before rebasing and could be anything
 * after, so checking the input rather than the output would check the wrong string.
 */
export function resolveMarkdownUrl(
  value: string,
  base: string | null | undefined,
  kind: "link" | "image",
): string | undefined {
  const check = kind === "link" ? safeLinkHref : safeImageSrc;

  if (!value) return undefined;

  // Absolute, a fragment, or a mail link: nothing to rebase.
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("#")) {
    return check(value);
  }

  if (!base) return check(value);

  try {
    const resolved = new URL(
      value.replace(/^\.\//, ""),
      `${base.replace(/\/$/, "")}/`,
    ).toString();
    return check(resolved);
  } catch {
    return check(value);
  }
}
