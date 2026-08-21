"use client";

import { useAuth } from "@terrablox/auth/hooks";
import { Avatar, AvatarFallback, AvatarImage } from "@terrablox/ui/avatar";
import { Card, CardContent, CardHeader, CardTitle } from "@terrablox/ui/card";
import { SidebarInset, SidebarProvider } from "@terrablox/ui/sidebar";
import { useEffect } from "react";
import { InfracostCard } from "@/components/account/infracost-card";
import { AppSidebar } from "@/components/app-sidebar";
import { GithubAccountCard } from "@/components/github-account-card";
import { PageHeader } from "@/components/layout/page-header";
import {
  PageSkeleton,
  SettingsSkeleton,
} from "@/components/layout/page-skeleton";

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
    return (
      <PageSkeleton breadcrumbs={[{ label: "Account Settings" }]}>
        <SettingsSkeleton count={3} />
      </PageSkeleton>
    );
  }

  const metadata = (user.metadata ?? {}) as Record<string, unknown>;
  const avatarUrlFromMetadata =
    typeof metadata.avatar_url === "string" ? metadata.avatar_url : undefined;

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <PageHeader breadcrumbs={[{ label: "Account Settings" }]} />

        <main className="flex-1 p-6">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle>Your Profile</CardTitle>
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
                    {user.createdAt ? (
                      <div className="text-xs text-muted-foreground">
                        Created: {user.createdAt.toLocaleString()}
                      </div>
                    ) : null}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* No AWS card. Which account to deploy into belongs to a project,
                not to a person — two projects usually mean two accounts — so the
                connect flow lives in each project's Deploy and State tabs. */}
            <GithubAccountCard />
            <InfracostCard />
          </div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
