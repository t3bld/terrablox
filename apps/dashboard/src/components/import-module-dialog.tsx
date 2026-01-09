"use client";

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
import { Github, Loader2, Search } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

interface ImportModuleDialogProps {
  provider: "github";
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type GithubRepoApiResponse = {
  id: number;
  name: string;
  description: string | null;
  private: boolean;
  html_url: string;
  owner: {
    login: string;
  };
};

interface Repo {
  id: string;
  name: string;
  description: string;
  private: boolean;
  owner: string;
  url: string;
}

function toRepo(r: GithubRepoApiResponse): Repo {
  return {
    id: String(r.id),
    name: r.name,
    description: r.description ?? "",
    private: r.private,
    owner: r.owner.login,
    url: r.html_url,
  };
}

export function ImportModuleDialog({
  provider,
  open,
  onOpenChange,
}: ImportModuleDialogProps) {
  const { user } = useAuth();
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

      try {
        const response = await fetch("/api/github/repos", {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
          },
        });

        const body: unknown = await response.json();

        if (!response.ok) {
          const maybeObj = body as { error?: string; scopes?: string };
          const scopesInfo = maybeObj?.scopes
            ? ` (token scopes: ${maybeObj.scopes})`
            : "";
          setError(`${maybeObj?.error ?? "Failed to fetch repositories"}${scopesInfo}`);
          setRepos([]);
          return;
        }

        const data = Array.isArray(body) ? (body as GithubRepoApiResponse[]) : [];
        setRepos(data.map(toRepo));
      } catch (err) {
        setError(err instanceof Error ? err.message : "An unknown error occurred.");
      } finally {
        setLoading(false);
      }
    }

    fetchRepos();
  }, [open, user]);

  const filteredRepos = repos.filter((repo) =>
    `${repo.owner}/${repo.name}`
      .toLowerCase()
      .includes(searchQuery.toLowerCase()),
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
              <p className="text-center">{error}</p>
              {error.includes("GitHub provider token not found") && (
                <Button asChild variant="link" className="mt-2">
                  <Link href="/account">Go to Account Settings</Link>
                </Button>
              )}
              <p className="mt-2 text-center text-xs text-muted-foreground">
                If organization repositories are missing, ensure the GitHub app
                has org access granted in GitHub settings.
              </p>
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
                Missing org repos? Open Account → GitHub and grant organization
                access.
              </p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
