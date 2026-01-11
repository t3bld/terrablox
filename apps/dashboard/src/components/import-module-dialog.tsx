"use client";

import type { GitProviderId, GitRepo } from "@terrablox/git-import";
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
import { useAuth } from "@terrablox/auth/hooks";

interface ImportModuleDialogProps {
  provider: GitProviderId;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ImportModuleDialog({
  provider,
  open,
  onOpenChange,
}: ImportModuleDialogProps) {
  const { user } = useAuth();
  const [repos, setRepos] = useState<GitRepo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    if (!open) return;

    async function fetchRepos() {
      setLoading(true);
      setError(null);

      const identity = user?.identities?.find((id) => id.provider === provider);
      if (!identity) {
        setError(
          `Your ${provider} account is not linked. Please link it in your account settings.`,
        );
        setLoading(false);
        return;
      }

      try {
        const response = await fetch(`/api/git-provider/${provider}/repos`);
        const body = await response.json();

        if (!response.ok) {
          const scopes = body?.scopes ? ` (scopes: ${body.scopes})` : "";
          setError(
            body?.error
              ? `${body.error}${scopes}`
              : `Failed to fetch repositories.`,
          );
          return;
        }

        setRepos(body.repos ?? []);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "An unknown error occurred.",
        );
      } finally {
        setLoading(false);
      }
    }

    fetchRepos();
  }, [open, provider, user]);

  const filteredRepos = repos.filter((repo) =>
    repo.full_name.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  const providerName = provider.charAt(0).toUpperCase() + provider.slice(1);

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
            <div className="flex flex-col items-center justify-center h-full text-destructive text-center">
              <p>{error}</p>
              <Button asChild variant="link" className="mt-2">
                <Link href="/account">Go to Account Settings</Link>
              </Button>
            </div>
          ) : filteredRepos.length > 0 ? (
            filteredRepos.map((repo) => (
              <div
                key={repo.id}
                className="flex items-center justify-between p-2 rounded-md hover:bg-muted"
              >
                <div>
                  <div className="font-medium">{repo.full_name}</div>
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
