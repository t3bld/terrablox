"use client";

import { useState } from "react";

import { useAuth } from "@terrablox/auth";
import { Button } from "@terrablox/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@terrablox/ui/card";

import { GithubAccessDialog } from "@/components/github-access-dialog";

export function GithubOrgAccess() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);

  const githubLinked = user?.identities?.some((id) => id.provider === "github");

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>GitHub organization access</CardTitle>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => setOpen(true)}
          disabled={!githubLinked}
        >
          Manage access
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {!githubLinked ? (
          <p className="text-sm text-muted-foreground">
            Link your GitHub account first.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            If organization repositories are missing in the import dialog, open
            Manage access and grant Terrablox access to your organizations.
          </p>
        )}

        <GithubAccessDialog open={open} onOpenChange={setOpen} />
      </CardContent>
    </Card>
  );
}
