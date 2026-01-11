"use client";

import { Button } from "@terrablox/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@terrablox/ui/card";
import { Github, Link as LinkIcon, Unlink } from "lucide-react";
import { useMemo, useState } from "react";
import { useAuth } from "@terrablox/auth/hooks";

export function GithubAccountCard() {
  const { user, signInWithOAuth } = useAuth();
  const [isLinking, setIsLinking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const github = useMemo(() => {
    const identity = user?.identities?.find((id) => id.provider === "github");
    const username = identity?.identity_data?.user_name;
    return {
      linked: !!identity,
      username: typeof username === "string" ? username : undefined,
    };
  }, [user]);

  async function handleLink() {
    setError(null);
    setIsLinking(true);
    try {
      await signInWithOAuth("github", {
        redirectTo: window.location.href,
        scopes: ["read:org", "repo"],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to link account");
    } finally {
      setIsLinking(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Github className="h-5 w-5" />
          GitHub
        </CardTitle>
        <CardDescription>
          Connect your GitHub account to import private and organization
          modules.
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
          {github.linked ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <LinkIcon className="h-3.5 w-3.5" />
              {github.username ?? "GitHub"}
            </div>
          ) : (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Unlink className="h-3.5 w-3.5" />
              GitHub
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2">
          {!github.linked ? (
            <Button
              className="w-full"
              onClick={handleLink}
              disabled={isLinking}
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
