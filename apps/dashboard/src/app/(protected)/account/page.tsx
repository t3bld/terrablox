"use client";

import { Github, Link as LinkIcon, Unlink, User2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useAuth } from "@terrablox/auth";
import { Avatar, AvatarFallback, AvatarImage } from "@terrablox/ui/avatar";
import { Button } from "@terrablox/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@terrablox/ui/card";
import { Separator } from "@terrablox/ui/separator";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@terrablox/ui/sidebar";

import { AppSidebar } from "@/components/app-sidebar";

function getGithubLinkStatus(
  user: NonNullable<ReturnType<typeof useAuth>["user"]>,
) {
  const githubIdentity = user.identities?.find(
    (id) => id.provider === "github",
  );

  return {
    linked: !!githubIdentity,
    githubUsername: githubIdentity?.identity_data?.user_name,
  };
}



export default function AccountPage() {
  const { user, isAuthenticated, signInWithOAuth, refreshSession } = useAuth();

  const [isLinkingGithub, setIsLinkingGithub] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  // After returning from an OAuth redirect, force-refresh the session once so the UI updates.
  useEffect(() => {
    if (!isAuthenticated) return;

    const url = new URL(window.location.href);
    const hasOAuthParams =
      url.hash.includes("access_token=") ||
      url.searchParams.has("code") ||
      url.searchParams.has("error");

    if (!hasOAuthParams) return;

    refreshSession().catch(() => {
      // Non-fatal; the built-in auth listener might still update the session.
    });
  }, [isAuthenticated, refreshSession]);

  const github = useMemo(() => {
    if (!user)
      return { linked: false, githubUsername: undefined as string | undefined };
    return getGithubLinkStatus(user);
  }, [user]);

  async function handleLinkGithub() {
    setLinkError(null);
    setIsLinkingGithub(true);

    try {
      const redirectTo = `${window.location.origin}/account`;
      await signInWithOAuth("github", redirectTo);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to link GitHub";
      setLinkError(message);
      setIsLinkingGithub(false);
    }
  }


  if (!isAuthenticated || !user) {
    return null;
  }

  const metadata = (user.metadata ?? {}) as Record<string, unknown>;
  const avatarUrlFromMetadata =
    typeof metadata.avatar_url === "string" ? metadata.avatar_url : undefined;

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 h-4" />
          <h1 className="text-lg font-semibold">Account</h1>
        </header>

        <main className="flex-1 p-6">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <User2 className="h-5 w-5" />
                  Your profile
                </CardTitle>
                <CardDescription>
                  Basic information from your authenticated session.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-start gap-4">
                  <Avatar className="h-12 w-12">
                    <AvatarImage
                      src={user.avatarUrl ?? avatarUrlFromMetadata}
                      alt={user.name || "User"}
                    />
                    <AvatarFallback className="bg-primary text-primary-foreground">
                      {user.name?.[0]?.toUpperCase() ||
                        user.email?.[0]?.toUpperCase() ||
                        "U"}
                    </AvatarFallback>
                  </Avatar>

                  <div className="grid gap-1">
                    <div className="text-base font-semibold">
                      {user.name || "Unnamed user"}
                    </div>
                    <div className="text-sm text-muted-foreground">
                      {user.email}
                    </div>
                    <div className="text-xs text-muted-foreground mt-2">
                      User ID: <span className="font-mono">{user.id}</span>
                    </div>
                    {user.createdAt ? (
                      <div className="text-xs text-muted-foreground">
                        Created: {user.createdAt.toLocaleString()}
                      </div>
                    ) : null}
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Github className="h-5 w-5" />
                  GitHub
                </CardTitle>
                <CardDescription>
                  Connect GitHub to enable GitHub-based workflows.
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
                      {github.githubUsername ?? "GitHub"}
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Unlink className="h-3.5 w-3.5" />
                      GitHub
                    </div>
                  )}
                </div>

                {!github.linked ? (
                  <Button
                    className="w-full"
                    onClick={handleLinkGithub}
                    disabled={isLinkingGithub}
                  >
                    {isLinkingGithub ? "Linking…" : "Link GitHub account"}
                  </Button>
                ) : null}

                <p className="text-xs text-muted-foreground">
                  Note: link detection currently uses session metadata (Supabase
                  identities aren’t exposed in the shared auth type yet).
                </p>
              </CardContent>
            </Card>


          </div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
