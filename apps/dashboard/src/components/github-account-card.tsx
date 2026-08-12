"use client";

import { useAuth } from "@terrablox/auth/hooks";
import { Button } from "@terrablox/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@terrablox/ui/card";
import { Github, Link as LinkIcon, Unlink } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

/**
 * Only relevant in "user" mode. GitHub App user tokens do not use scopes at
 * all - they use the fine-grained permissions of the App installation.
 */
const REQUIRED_SCOPES = ["repo", "read:org"];

type GitAuthMode = "app" | "user" | "none";

type AuthConfig = {
  githubConfigured: boolean;
  gitAuthMode: GitAuthMode;
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
        setConfig({
          githubConfigured: !!body?.providers?.github,
          gitAuthMode: (body?.gitAuthMode as GitAuthMode) ?? "none",
        });
      })
      .catch(() => {
        // Assume available and let the link attempt surface the real error.
        if (!cancelled) {
          setConfig({ githubConfigured: true, gitAuthMode: "user" });
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const github = useMemo(() => {
    const identity = user?.identities?.find((id) => id.provider === "github");
    return {
      linked: !!identity,
      scopes: identity?.scopes ?? [],
    };
  }, [user]);

  const isAppMode = config?.gitAuthMode === "app";

  const missingScopes = useMemo(() => {
    if (!github.linked || isAppMode) return [];
    return REQUIRED_SCOPES.filter((scope) => !github.scopes.includes(scope));
  }, [github, isAppMode]);

  async function handleLink() {
    setError(null);
    setIsLinking(true);
    try {
      await linkOAuth("github", {
        redirectTo: window.location.href,
        // A GitHub App ignores scopes; sending them would be misleading.
        scopes: isAppMode ? undefined : REQUIRED_SCOPES,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to link account");
      setIsLinking(false);
    }
    // On success the browser leaves for GitHub, so the state is not reset here.
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Github className="h-5 w-5" />
          GitHub
        </CardTitle>
        <CardDescription>
          {isAppMode
            ? "Link your GitHub identity. Repositories are read through the GitHub App installation, so every member sees the same modules."
            : "Connect your GitHub account to import private and organization modules."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="text-sm">
            Status:{" "}
            <span
              className={
                github.linked
                  ? "text-emerald-600 dark:text-emerald-400 font-medium"
                  : "text-muted-foreground"
              }
            >
              {github.linked ? "Linked" : "Not linked"}
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {github.linked ? (
              <LinkIcon className="h-3.5 w-3.5" />
            ) : (
              <Unlink className="h-3.5 w-3.5" />
            )}
            GitHub
          </div>
        </div>

        {config && !config.githubConfigured ? (
          <div className="space-y-1 rounded-md border border-dashed p-3 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">
              GitHub sign-in is not configured on this server.
            </p>
            <p>
              Register a GitHub App with the callback URL{" "}
              <code className="font-mono">/api/auth/callback/github</code>, then
              set <code className="font-mono">GITHUB_CLIENT_ID</code> and{" "}
              <code className="font-mono">GITHUB_CLIENT_SECRET</code> in{" "}
              <code className="font-mono">apps/dashboard/.env</code> and restart
              the dev server.
            </p>
          </div>
        ) : null}

        {missingScopes.length > 0 ? (
          <p className="text-xs text-amber-600 dark:text-amber-500">
            Missing scopes: {missingScopes.join(", ")}. Re-link the account to
            grant them.
          </p>
        ) : null}

        <div className="flex flex-col gap-2">
          {!github.linked ? (
            <Button
              className="w-full"
              onClick={handleLink}
              disabled={isLinking || !config?.githubConfigured}
            >
              {isLinking ? "Linking..." : "Link GitHub account"}
            </Button>
          ) : (
            <Button className="w-full" variant="secondary" asChild>
              <a
                href="https://github.com/settings/applications"
                target="_blank"
                rel="noopener noreferrer"
              >
                Manage Organization Access
              </a>
            </Button>
          )}
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
