"use client";

import {useAuth} from "@terrablox/auth/hooks";

export const dynamic = "force-dynamic";

import { Github } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";


import { Alert, AlertDescription } from "@terrablox/ui/alert";
import { Button } from "@terrablox/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@terrablox/ui/card";
import { Input } from "@terrablox/ui/input";
import { Label } from "@terrablox/ui/label";
import { Separator } from "@terrablox/ui/separator";

export default function LoginPage() {
  const router = useRouter();
  const { signIn, signInWithOAuth, isLoading } = useAuth();

  const [nextPath, setNextPath] = useState("/projects");

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const next = sp.get("next");
    if (next) setNextPath(next);
  }, []);

  const next = nextPath;

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [oauthSubmitting, setOauthSubmitting] = useState<"github" | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      console.log("Attempting to sign in with:", { email });
      await signIn(
        { email, password },
        {
          onSuccess: () => {
            console.log("Sign in successful, redirecting via onSuccess...");
            router.push(next);
          },
        },
      );
    } catch (err) {
      console.error("Sign in failed:", err);
      setError(err instanceof Error ? err.message : "Failed to sign in");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleOAuthSignIn = async (provider: "github") => {
    setError(null);
    setOauthSubmitting(provider);
    try {
      const redirectTo = `${window.location.origin}${next}`;
      await signInWithOAuth(provider, {
        redirectTo,
        scopes: ["read:org", "repo"],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to sign in");
      setOauthSubmitting(null);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-1">
          <CardTitle className="text-2xl">Sign in</CardTitle>
          <CardDescription>
            Enter your email below to sign in to your account.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={isLoading || isSubmitting || !!oauthSubmitting}
                placeholder="you@example.com"
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="password">Password</Label>
                <Link
                  href="/forgot-password"
                  className="text-sm text-muted-foreground hover:text-foreground"
                >
                  Forgot password?
                </Link>
              </div>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={isLoading || isSubmitting || !!oauthSubmitting}
              />
            </div>

            <Button
              type="submit"
              className="w-full"
              disabled={isLoading || isSubmitting || !!oauthSubmitting}
            >
              {isSubmitting ? "Signing in…" : "Sign in"}
            </Button>
          </form>

          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <Separator />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-background px-2 text-muted-foreground">
                Or continue with
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOAuthSignIn("github")}
              disabled={isLoading || isSubmitting || !!oauthSubmitting}
            >
              <Github className="mr-2 h-4 w-4" />
              {oauthSubmitting === "github" ? "Starting…" : "GitHub"}
            </Button>
          </div>

          <p className="text-center text-sm text-muted-foreground">
            Don&apos;t have an account?{" "}
            <Link
              href="/signup"
              className="underline underline-offset-4 hover:text-foreground"
            >
              Sign up
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
