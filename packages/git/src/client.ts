/**
 * The one way this codebase talks to GitHub.
 *
 * There used to be two. `lib/github/repo-files.ts` had this function, and
 * `lib/git-provider/github.ts` had a private one of its own that built
 * `https://api.github.com/…` URLs by hand — so the same API was reached through two
 * clients with two error types, and both of them could list a repository tree. Which
 * one a caller got decided what a failure looked like, and nothing said so.
 *
 * No `server-only` marker here, deliberately, even though every current caller runs on
 * the server. The token is a parameter, so this module holds no secret of its own, and
 * the marker would make the package unusable from the CLI or the GitHub Action that are
 * the reason it is a package. The app keeps the guarantee where it belongs: in the
 * modules that *fetch* the token.
 */

const GITHUB_API = "https://api.github.com";
const API_VERSION = "2022-11-28";

/** How much of a failure body is worth quoting before it stops being a message. */
const MAX_BODY = 300;

export class GithubRequestError extends Error {
  readonly status: number;

  /**
   * What the token may do, and what the endpoint wanted, when GitHub said.
   *
   * Kept because GitHub answers a permission it does not like with `404 Not Found`
   * rather than anything about permissions. That cost a real afternoon: committing a
   * workflow file failed with a bare 404 from `POST /git/trees`, which reads as "the
   * repository is gone", while the actual cause was an OAuth token without the
   * `workflow` scope. These two headers say it outright.
   *
   * Both are null for the app's own requests now that Terrablox authenticates as a
   * GitHub App: those tokens carry permissions rather than scopes, and GitHub sends
   * no scope headers for them. A 404 there means the repository is outside the
   * installation's grant, which the callers say in their own words.
   *
   * Kept because this package is also used by the catalogue seed scripts, which run
   * with whatever `GITHUB_TOKEN` or `gh auth token` hands them — often a classic
   * personal access token, for which GitHub does send these headers and this is
   * still the fastest explanation of a confusing 404.
   */
  readonly scopes: { granted: string | null; required: string | null };

  // Assigned rather than declared as constructor parameter properties: the seed
  // scripts load this tree through Node's strip-only TypeScript loader, which rejects
  // them, and one of them made a whole module unloadable from a script.
  constructor(
    message: string,
    status: number,
    scopes: { granted: string | null; required: string | null } = {
      granted: null,
      required: null,
    },
  ) {
    super(message);
    this.status = status;
    this.scopes = scopes;
    this.name = "GithubRequestError";
  }
}

/**
 * Turns a failed response into a sentence worth reading.
 *
 * The scope note is appended only when GitHub named a requirement the token does not
 * satisfy. Printing both lists on every failure would bury the ordinary cases — a
 * missing file, a bad ref — under noise about permissions that were fine.
 */
function describeFailure(
  status: number,
  statusText: string,
  body: string,
  granted: string | null,
  required: string | null,
): string {
  const base = `GitHub API ${status} ${statusText}: ${body.slice(0, MAX_BODY)}`;

  if (!required) return base;

  const has = new Set(
    (granted ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const missing = required
    .split(",")
    .map((s) => s.trim())
    .filter((scope) => scope.length > 0 && !has.has(scope));

  if (missing.length === 0) return base;

  return `${base} (this token is missing the ${missing.join(", ")} scope${
    missing.length === 1 ? "" : "s"
  }; it has ${granted || "none"})`;
}

/**
 * One request, with auth, the API version and one error shape.
 *
 * Takes an API-relative path rather than a URL, which is the half of the merge that
 * removes a whole class of mistake: a caller cannot accidentally point it somewhere
 * else, and every call site reads as the endpoint it is.
 */
export async function githubRequest(
  /**
   * Null for an unauthenticated read.
   *
   * Importing a module from a public repository is allowed without a token, and the
   * header has to be *absent* rather than empty for that to work — GitHub rejects
   * `Bearer ` outright instead of falling back to anonymous access.
   */
  token: string | null,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const granted = res.headers.get("x-oauth-scopes");
    const required = res.headers.get("x-accepted-oauth-scopes");

    throw new GithubRequestError(
      describeFailure(res.status, res.statusText, body, granted, required),
      res.status,
      { granted, required },
    );
  }

  return res;
}
