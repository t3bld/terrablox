"use client";

import { useAuth } from "@terrablox/auth/hooks";

export const dynamic = "force-dynamic";

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
import { Github } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

export default function SignUpPage() {
  const { signUp, signInWithOAuth, isLoading } = useAuth();

  const [nextPath, setNextPath] = useState("/projects");

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const next = sp.get("next");
    if (next) setNextPath(next);
  }, []);

  const next = nextPath;

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [oauthSubmitting, setOauthSubmitting] = useState<"github" | null>(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }

    setIsSubmitting(true);

    try {
      await signUp({ email, password, name: name.trim() || undefined });
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to sign up");
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

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-2xl">Check your email</CardTitle>
            <CardDescription>
              We&apos;ve sent you a confirmation email. Please click the link to
              verify your account.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button asChild className="w-full">
              <Link href="/login">Back to sign in</Link>
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              After verifying, you can sign in and you&apos;ll be redirected to{" "}
              <span className="font-mono">{next}</span>.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-1">
          <CardTitle className="text-2xl">Create an account</CardTitle>
          <CardDescription>
            Enter your details below to create your account.
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
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={isLoading || isSubmitting || !!oauthSubmitting}
                placeholder="Optional"
              />
            </div>

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
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={isLoading || isSubmitting || !!oauthSubmitting}
                placeholder="Minimum 8 characters"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirmPassword">Confirm password</Label>
              <Input
                id="confirmPassword"
                type="password"
                autoComplete="new-password"
                required
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                disabled={isLoading || isSubmitting || !!oauthSubmitting}
              />
            </div>

            <Button
              type="submit"
              className="w-full"
              disabled={isLoading || isSubmitting || !!oauthSubmitting}
            >
              {isSubmitting ? "Creating account…" : "Create account"}
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
            Already have an account?{" "}
            <Link
              href="/login"
              className="underline underline-offset-4 hover:text-foreground"
            >
              Sign in
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
