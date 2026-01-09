"use client";

import { Github, Loader2, Search } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { useAuth } from "@terrablox/auth";
import { Button } from "@terrablox/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@terrablox/ui/dialog";
import { Input } from "@terrablox/ui/input";

interface ImportModuleDialogProps {
  provider: "github";
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface Repo {
  id: string;
  name: string;
  description: string;
  private: boolean;
  owner: string;
  url: string;
}

export function ImportModuleDialog({
  provider,
  open,
  onOpenChange,
}: ImportModuleDialogProps) {
  const { user, getProviderToken } = useAuth();
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    if (!open) return;

    async function fetchRepos() {
      setLoading(true);
      setError(null);
      const githubIdentity = user?.identities?.find(
        (id) => id.provider === "github",
      );

      if (!githubIdentity) {
        setError(
          "GitHub account not linked. Please link your account to import repositories.",
        );
        setLoading(false);
        return;
      }

      let allRepos: Repo[] = [];
      try {
        const token = await getProviderToken("github");
        if (!token) {
          throw new Error(
            "Could not retrieve authentication token. Please try linking your account again.",
          );
        }

        let nextUrl: string | null =
          "https://api.github.com/user/repos?affiliation=owner,organization_member&per_page=100";

        while (nextUrl) {
          const response: Response = await fetch(nextUrl, {
            headers: {
              Authorization: `Bearer ${token}`,
              "X-GitHub-Api-Version": "2022-11-28",
            },
          });

          if (!response.ok) {
            throw new Error(
              `Failed to fetch repositories: ${response.statusText}`,
            );
          }

          const data: any[] = await response.json();
          const transformedRepos: Repo[] = data.map((repo: any) => ({
            id: repo.id.toString(),
            name: repo.name,
            description: repo.description,
            private: repo.private,
            owner: repo.owner.login,
            url: repo.html_url,
          }));
          allRepos = [...allRepos, ...transformedRepos];

          const linkHeader: string | null = response.headers.get("Link");
          if (linkHeader) {
            const match: RegExpMatchArray | null =
              linkHeader.match(/<([^>]+)>;\s*rel="next"/);
            nextUrl = match?.[1] ?? null;
          } else {
            nextUrl = null;
          }
        }

        setRepos(allRepos);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "An unknown error occurred.",
        );
      } finally {
        setLoading(false);
      }
    }

    fetchRepos();
  }, [open, provider, user, getProviderToken]);

  const filteredRepos = repos.filter((repo) =>
    repo.name.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  const providerName = "GitHub";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[625px]">
        <DialogHeader>
          <DialogTitle className="flex items-center">
            <Github className="h-5 w-5 mr-2" />
            Import from {providerName}
          </DialogTitle>
          <DialogDescription>
            Select a repository to import as a Terraform module.
          </DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search repositories..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
          />
        </div>
        <div className="space-y-2 h-[300px] overflow-y-auto pr-2">
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center h-full text-destructive">
              <p>{error}</p>
              {error.includes("GitHub account not linked") && (
                <Button asChild variant="link" className="mt-2">
                  <Link href="/account">Go to Account Settings</Link>
                </Button>
              )}
            </div>
          ) : filteredRepos.length > 0 ? (
            filteredRepos.map((repo) => (
              <div
                key={repo.id}
                className="flex items-center justify-between p-2 rounded-md hover:bg-muted"
              >
                <div>
                  <div className="font-medium">
                    {repo.owner}/{repo.name}
                  </div>
                  <div className="text-sm text-muted-foreground line-clamp-1">
                    {repo.description}
                  </div>
                </div>
                <Button variant="outline" size="sm">
                  Import
                </Button>
              </div>
            ))
          ) : (
            <div className="text-center text-sm text-muted-foreground pt-8">
              <p>No repositories found.</p>
              <p className="mt-2">
                Missing an organization's repositories? You may need to{" "}
                <Link
                  href="https://github.com/settings/applications"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline text-primary"
                >
                  grant access on GitHub
                </Link>
                .
              </p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

