"use client";

import { useAuth } from "@terrablox/auth/hooks";

export const dynamic = "force-dynamic";

import { Alert, AlertDescription } from "@terrablox/ui/alert";
import { Button } from "@terrablox/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@terrablox/ui/card";
import { Github } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * The only way in: GitHub.
 *
 * Email and password are gone, and not only to save a form. Everything TerraBlox
 * does needs a GitHub identity — reading the repository a project is built from,
 * committing the graph, importing modules, running the agent on the user's own
 * Copilot seat. An account without GitHub could sign in and then do nothing, so
 * the sign-in and the connection that makes the app work are now one step.
 */
export default function LoginPage() {
  const { signInWithOAuth, isLoading } = useAuth();

  const [nextPath, setNextPath] = useState("/projects");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const next = sp.get("next");
    if (next) setNextPath(next);
  }, []);

  const handleSignIn = async () => {
    setError(null);
    setSubmitting(true);

    try {
      await signInWithOAuth("github", {
        redirectTo: `${window.location.origin}${nextPath}`,
        scopes: ["read:org", "repo"],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to sign in");
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-1">
          <CardTitle className="text-2xl">Sign in to TerraBlox</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          <Button
            className="w-full"
            disabled={isLoading || submitting}
            onClick={() => void handleSignIn()}
            type="button"
          >
            <Github className="mr-2 h-4 w-4" />
            {submitting ? "Starting…" : "Continue with GitHub"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
