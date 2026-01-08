"use client";

import {
  ArrowRight,
  Check,
  ChevronsUpDown,
  GitBranch,
  Github,
  Gitlab,
  Loader2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useAuth } from "@terrablox/auth";
import { Button } from "@terrablox/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@terrablox/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@terrablox/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@terrablox/ui/popover";
import { cn } from "@terrablox/ui/lib/utils";
import Link from "next/link";

type RepoProvider = "github" | "gitlab";

interface Repo {
  id: string;
  name: string;
  full_name: string;
  private?: boolean;
  html_url: string;
}

interface ImportModuleDialogProps {
  provider: RepoProvider;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ImportModuleDialog({
  provider,
  open,
  onOpenChange,
}: ImportModuleDialogProps) {
  const { user } = useAuth();
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedRepo, setSelectedRepo] = useState<Repo | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isGithubLinked = useMemo(
    () => user?.identities?.some((id) => id.provider === "github"),
    [user],
  );
  const isGitlabLinked = useMemo(
    () => user?.identities?.some((id) => id.provider === "gitlab"),
    [user],
  );

  const isProviderLinked =
    provider === "github" ? isGithubLinked : isGitlabLinked;

  useEffect(() => {
    if (open) {
      const fetchRepos = async () => {
        setLoading(true);
        setError(null);
        try {
          const apiUrl = provider === "github" ? "/api/github/repos" : "/api/gitlab/repos";
          const response = await fetch(apiUrl);
          if (!response.ok) {
            const errorData = await response.json();
            setError(errorData.error || "Failed to fetch repositories");
          } else {
            let data = await response.json();

            if (provider === "gitlab") {
              data = data.map((repo: any) => ({
                id: repo.id,
                name: repo.name,
                full_name: repo.path_with_namespace,
                private: repo.visibility === 'private',
                html_url: repo.web_url,
              }));
            }

            setRepos(data);
          }
        } catch (err) {
          setError(
            err instanceof Error ? err.message : "An unknown error occurred",
          );
        } finally {
          setLoading(false);
        }
      };

      if ((provider === "github" && isGithubLinked) || (provider === "gitlab" && isGitlabLinked)) {
        fetchRepos();
      }
    }
  }, [open, provider, isGithubLinked, isGitlabLinked]);

  const handleImport = async () => {
    if (!selectedRepo) return;
    setIsImporting(true);
    // TODO: Implement actual import logic
    await new Promise((resolve) => setTimeout(resolve, 1500));
    setIsImporting(false);
    onOpenChange(false);
  };

  const ProviderIcon = provider === "github" ? Github : Gitlab;
  const providerName = provider === "github" ? "GitHub" : "GitLab";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ProviderIcon className="h-5 w-5" />
            Import from {providerName}
          </DialogTitle>
          <DialogDescription>
            Select a repository to import as a Terraform module.
          </DialogDescription>
        </DialogHeader>

        {!isProviderLinked ? (
          <div className="py-8 text-center">
            <p className="mb-4">
              You need to link your {providerName} account first.
            </p>
            <Button asChild>
              <Link href="/account">
                <ArrowRight className="mr-2 h-4 w-4" />
                Go to Account Settings
              </Link>
            </Button>
          </div>
        ) : (
          <div className="py-4">
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  className="w-full justify-between"
                  disabled={loading}
                >
                  {loading ? (
                    <span className="flex items-center">
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Fetching repositories...
                    </span>
                  ) : selectedRepo ? (
                    selectedRepo.full_name
                  ) : (
                    "Select a repository..."
                  )}
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[--radix-popover-trigger-width] p-0">
                <Command>
                  <CommandInput placeholder="Search repository..." />
                  <CommandList>
                    <CommandEmpty>No repository found.</CommandEmpty>
                    <CommandGroup>
                      {repos.map((repo) => (
                        <CommandItem
                          key={repo.id}
                          value={repo.full_name}
                          onSelect={() => {
                            setSelectedRepo(repo);
                          }}
                        >
                          <Check
                            className={cn(
                              "mr-2 h-4 w-4",
                              selectedRepo?.id === repo.id
                                ? "opacity-100"
                                : "opacity-0",
                            )}
                          />
                          {repo.full_name}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>

            {error && (
              <div className="text-red-500 text-sm py-2 text-center">
                {error}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isImporting}
          >
            Cancel
          </Button>
          <Button
            onClick={handleImport}
            disabled={
              !selectedRepo || isImporting || !isProviderLinked || loading
            }
          >
            {isImporting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Importing...
              </>
            ) : (
              <>
                <GitBranch className="mr-2 h-4 w-4" />
                Import
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

