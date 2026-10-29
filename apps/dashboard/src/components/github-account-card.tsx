"use client";

import { useAuth } from "@terrablox/auth/hooks";
import { Badge } from "@terrablox/ui/badge";
import { Button } from "@terrablox/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@terrablox/ui/card";
import { ExternalLink } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type AuthConfig = {
  githubConfigured: boolean;
};

type Installation = {
  login: string;
  type: string;
  repositorySelection: "all" | "selected";
};

export function GithubAccountCard() {
  const { user, linkOAuth } = useAuth();
  const [isLinking, setIsLinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // null while unknown, so the button never flashes the wrong state.
  const [config, setConfig] = useState<AuthConfig | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/auth-config")
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (cancelled) return;
        setConfig({ githubConfigured: !!body?.providers?.github });
      })
      .catch(() => {
        // Assume available and let the link attempt surface the real error.
        if (!cancelled) {
          setConfig({ githubConfigured: true });
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const github = useMemo(() => {
    const identity = user?.identities?.find((id) => id.provider === "github");
    return { linked: !!identity };
  }, [user]);

  // Where the app was granted access. Replaces the scope list this card used to
  // show: a GitHub App user token has no scopes, so that panel would sit empty and
  // its "missing scopes" warning would never clear.
  const [installations, setInstallations] = useState<Installation[] | null>(
    null,
  );
  const [installUrl, setInstallUrl] = useState<string | null>(null);
  /** Bumped to re-read the installations after a grant changed on GitHub. */
  const [reloadKey, setReloadKey] = useState(0);
  /**
   * Set while an organisation owner has yet to approve the app.
   *
   * Read from the server rather than only from the redirect's query parameter, which
   * is what makes it survive a reload: the parameter says what just happened, this
   * says what is still true.
   */
  const [pendingRequestAt, setPendingRequestAt] = useState<string | null>(null);

  // `reloadKey` is listed without being read, exactly like the `moduleId` trigger in
  // the module detail view: it exists to re-run this after a grant changed on GitHub,
  // which is a thing that happened outside this tab and that the effect cannot notice
  // any other way.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate re-run trigger
  useEffect(() => {
    if (!github.linked) return;
    let cancelled = false;

    fetch("/api/github/installations")
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (cancelled || !body) return;
        setInstallations(body.installations ?? []);
        if (typeof body.installUrl === "string") setInstallUrl(body.installUrl);
        setPendingRequestAt(
          typeof body.pendingRequestAt === "string"
            ? body.pendingRequestAt
            : null,
        );
      })
      .catch(() => {
        // Left as null, which renders nothing. A failed lookup is not worth an
        // error on a screen whose main job is the connect button.
      });

    return () => {
      cancelled = true;
    };
  }, [github.linked, reloadKey]);

  /**
   * What just happened on GitHub, if the user arrived from there.
   *
   * The install flow leaves the app entirely and comes back through
   * `/api/github/installations/callback`, which lands here with `?github=<outcome>`.
   * Without this the return was silent: the list below re-reads and either shows a
   * new grant or does not, and the one case where it *correctly* shows nothing —
   * a request awaiting an organisation owner — looked exactly like a failure.
   *
   * The parameter is removed once read, so a reload does not repeat the message and
   * a copied URL does not carry a stale one.
   */
  const [outcome, setOutcome] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const value = params.get("github");
    if (!value) return;

    setOutcome(value);

    params.delete("github");
    const query = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}`,
    );

    // An install or a change means the grant moved, so the list this card shows is
    // out of date the moment it is read. A request changed nothing yet.
    if (value === "installed" || value === "updated") {
      setReloadKey((key) => key + 1);
    }
  }, []);

  async function handleLink() {
    setError(null);
    setIsLinking(true);
    try {
      // No `scopes` argument. Terrablox authenticates as a GitHub App, where what
      // the token may do comes from the app's registered permissions and the
      // repositories each installation was granted. Passing scopes here would be
      // sent and silently ignored.
      await linkOAuth("github", { redirectTo: window.location.href });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to link account");
      setIsLinking(false);
    }
    // On success the browser leaves for GitHub, so the state is not reset here.
  }

  return (
    // `h-full` plus a column content area is what lets the action sit on the
    // bottom edge: the cards in this grid are different heights, and a button
    // that floats wherever its card's text happens to end reads as a different
    // control in each one.
    <Card className="flex h-full flex-col">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-1.5">
            <CardTitle>GitHub</CardTitle>
            <Button asChild className="h-7 w-7" size="icon" variant="ghost">
              <a
                aria-label="Open GitHub website"
                href="https://github.com"
                rel="noreferrer"
                target="_blank"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </Button>
          </div>
          <Badge
            className={
              github.linked
                ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950 dark:text-emerald-300 dark:hover:bg-emerald-950"
                : "text-muted-foreground"
            }
            variant={github.linked ? "secondary" : "outline"}
          >
            {github.linked ? "Connected" : "Unconnected"}
          </Badge>
        </div>
        {!github.linked ? (
          <CardDescription>
            Connect your GitHub account to import private and organization
            modules.
          </CardDescription>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-1 flex-col space-y-4">
        {config && !config.githubConfigured ? (
          <div className="space-y-1 rounded-md border border-dashed p-3 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">
              GitHub sign-in is not configured on this server.
            </p>
            <p>
              Register a GitHub App with the callback URL{" "}
              <code className="font-mono">/api/auth/callback/github</code> and
              the setup URL{" "}
              <code className="font-mono">
                /api/github/installations/callback
              </code>
              , then set <code className="font-mono">GITHUB_CLIENT_ID</code> and{" "}
              <code className="font-mono">GITHUB_CLIENT_SECRET</code> in{" "}
              <code className="font-mono">.env</code> and restart the dev
              server.
            </p>
          </div>
        ) : null}

        {/* Waiting on an owner, for as long as that is true.
            Driven by the stored request rather than by the redirect's query parameter,
            so it survives a reload and is there when the person comes back tomorrow to
            see whether it went through. Without it the pending state was
            indistinguishable from "never asked", and the obvious next move — install
            it — files a second request. */}
        {pendingRequestAt ? (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs leading-relaxed">
            <p className="font-medium">Waiting for an organisation owner</p>
            <p className="mt-1 text-muted-foreground">
              You asked to install Terrablox on an organisation you are not an
              owner of{" "}
              {new Date(pendingRequestAt).toLocaleDateString(undefined, {
                day: "numeric",
                month: "long",
              })}
              , so GitHub sent the request to someone who is. Nothing is granted
              until they approve it, and no repositories will appear here before
              then — asking again only files another request.
            </p>
          </div>
        ) : outcome === "installed" || outcome === "updated" ? (
          /* The successful return, which needs saying once and then never again:
             the grant below is the durable answer. */
          <div className="rounded-md border border-emerald-600/40 bg-emerald-600/5 p-3 text-xs leading-relaxed">
            <p className="font-medium">
              {outcome === "installed"
                ? "Terrablox was installed"
                : "Repository access was updated"}
            </p>
            <p className="mt-1 text-muted-foreground">
              The grant below is what GitHub reports now.
            </p>
          </div>
        ) : null}

        {github.linked && installations ? (
          <div className="space-y-1.5">
            <p className="font-medium text-xs">Repository access</p>

            {installations.length > 0 ? (
              <>
                <div className="flex flex-wrap gap-1">
                  {installations.map((installation) => (
                    <Badge key={installation.login} variant="outline">
                      {installation.login}
                      {/* The selection matters enough to show: on `selected`
                          only the chosen repositories appear in the project
                          picker, which is the first thing to check when one is
                          missing. */}
                      <span className="ml-1 text-muted-foreground">
                        {installation.repositorySelection === "all"
                          ? "all repos"
                          : "selected repos"}
                      </span>
                    </Badge>
                  ))}
                </div>
                {installUrl ? (
                  <a
                    className="inline-block text-muted-foreground text-xs underline underline-offset-4 hover:text-foreground"
                    href={installUrl}
                    rel="noreferrer noopener"
                    target="_blank"
                  >
                    Change repository access
                  </a>
                ) : null}
              </>
            ) : (
              <p className="text-amber-600 text-xs dark:text-amber-500">
                Signed in, but Terrablox has not been granted any repositories
                yet.{" "}
                {installUrl ? (
                  <a
                    className="underline underline-offset-4"
                    href={installUrl}
                    rel="noreferrer noopener"
                    target="_blank"
                  >
                    Install it on GitHub
                  </a>
                ) : null}
              </p>
            )}
          </div>
        ) : null}

        <div className="mt-auto flex flex-col gap-2">
          {!github.linked ? (
            <Button
              className="w-full"
              onClick={handleLink}
              disabled={isLinking || !config?.githubConfigured}
            >
              {isLinking ? "Linking..." : "Link GitHub account"}
            </Button>
          ) : (
            // `/settings/installations` rather than `/settings/applications`: the
            // latter lists authorized OAuth Apps, which is no longer what Terrablox
            // is, and the app would simply not be on that page. The install URL is
            // preferred when known because it lands on this app rather than on a
            // list of every app the user has.
            <Button asChild className="w-full" variant="outline">
              <a
                href={installUrl ?? "https://github.com/settings/installations"}
                rel="noopener noreferrer"
                target="_blank"
              >
                Manage repository access
              </a>
            </Button>
          )}
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
