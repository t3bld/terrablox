"use client";

import { User2 } from "lucide-react";
import { useEffect } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@terrablox/ui/avatar";
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
import { GithubAccountCard } from "@/components/github-account-card";
import { useAuth } from "@terrablox/auth/hooks";

export default function AccountPage() {
  const { user, isAuthenticated, refreshSession } = useAuth();

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

            <GithubAccountCard />
          </div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
