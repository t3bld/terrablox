"use client";

import type { GitRepo } from "@terrablox/git-import";
import { Button } from "@terrablox/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@terrablox/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@terrablox/ui/popover";
import { Check, ChevronsUpDown, Loader2, Lock, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

/**
 * The repository holding the application a project builds infrastructure for.
 *
 * Optional, and optional in the sense that leaving it empty costs nothing: the
 * agent then asks about the application instead of reading it. Picked from the
 * same list the module import uses, so a repository the user can see here is one
 * the token can actually read afterwards.
 */
export interface AppRepoSelection {
  fullName: string;
  /** Default branch as GitHub reports it, so reads have a ref without a lookup. */
  branch: string | null;
}

/** Enough of the list to search it; the rest of `GitRepo` is not needed here. */
interface RepoOption {
  fullName: string;
  branch: string | null;
  private: boolean;
  description: string | null;
}

/**
 * How many rows the popover renders at once.
 *
 * The list is every repository the token can see, which for an organisation
 * member is routinely in the hundreds. Searching is the way through it, so the
 * cap only has to leave enough visible to recognise that searching is what this
 * is for.
 */
const VISIBLE_LIMIT = 50;

export function AppRepoPicker({
  value,
  onChange,
  disabled = false,
  triggerId,
}: {
  value: AppRepoSelection | null;
  onChange: (next: AppRepoSelection | null) => void;
  disabled?: boolean;
  /** So a `Label` elsewhere can point at the trigger. */
  triggerId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [repos, setRepos] = useState<RepoOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Whether the list has been asked for, kept in a ref rather than derived from
   * `loading`.
   *
   * This is what was broken: the effect both guarded on `loading` and listed it
   * as a dependency, so `setLoading(true)` re-ran the effect, the re-run's
   * cleanup set `cancelled` on the request that had just been sent, and the
   * guard then made the re-run do nothing. The response arrived and was
   * discarded, `setLoading(false)` was skipped for the same reason, and the
   * popover showed "Loading repositories…" forever.
   *
   * A ref does not participate in the dependency array, which is the whole point:
   * "have I already asked" must not be able to restart the asking.
   */
  const requested = useRef(false);

  // Loaded when the picker is first opened rather than on mount: this is an
  // optional field, and most of the dialogs it sits in are submitted without it
  // ever being touched. A request for several hundred repositories is not worth
  // making until somebody looks.
  useEffect(() => {
    if (!open || requested.current) return;

    requested.current = true;
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch("/api/git-provider/github/repos")
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          throw new Error(body?.error ?? "Could not load repositories.");
        }
        return (body?.repos ?? []) as GitRepo[];
      })
      .then((list) => {
        if (cancelled) return;
        setRepos(
          list.map((repo) => ({
            fullName: repo.full_name,
            branch: repo.default_branch,
            private: repo.private,
            description: repo.description,
          })),
        );
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Cleared so reopening tries again: a failed load is usually a network
        // blip or an expired token, and both are fixed by the time someone looks
        // a second time.
        requested.current = false;
        setError(
          err instanceof Error ? err.message : "Could not load repositories.",
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const pool = needle
      ? repos.filter((repo) => repo.fullName.toLowerCase().includes(needle))
      : repos;

    return { rows: pool.slice(0, VISIBLE_LIMIT), total: pool.length };
  }, [repos, query]);

  const hidden = Math.max(0, matches.total - matches.rows.length);

  return (
    <div className="flex items-center gap-2">
      <Popover onOpenChange={setOpen} open={open}>
        <PopoverTrigger asChild>
          <Button
            aria-expanded={open}
            className="h-10 min-w-0 flex-1 justify-between gap-1 font-normal"
            disabled={disabled}
            id={triggerId}
            role="combobox"
            variant="outline"
          >
            <span
              className={
                value
                  ? "min-w-0 truncate font-mono text-xs"
                  : "min-w-0 truncate text-muted-foreground"
              }
            >
              {value?.fullName ?? "None — the agent will ask instead"}
            </span>
            <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>

        <PopoverContent className="w-[--radix-popover-trigger-width] p-0">
          {/* Filtered above, so cmdk is told not to score the list again — it
              would reorder rows that are already in the order the search
              produced. */}
          <Command shouldFilter={false}>
            <CommandInput
              onValueChange={setQuery}
              placeholder="Search your repositories"
              value={query}
            />
            <CommandList>
              {loading ? (
                <p className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Loading repositories…
                </p>
              ) : error ? (
                <p className="px-3 py-6 text-center text-sm text-destructive">
                  {error}
                </p>
              ) : (
                <>
                  <CommandEmpty>No repository matches.</CommandEmpty>
                  <CommandGroup>
                    {matches.rows.map((repo) => (
                      <CommandItem
                        key={repo.fullName}
                        onSelect={() => {
                          onChange({
                            fullName: repo.fullName,
                            branch: repo.branch,
                          });
                          setOpen(false);
                        }}
                        value={repo.fullName}
                      >
                        <Check
                          className={`h-3.5 w-3.5 shrink-0 ${
                            value?.fullName === repo.fullName
                              ? "opacity-100"
                              : "opacity-0"
                          }`}
                        />
                        <span className="min-w-0 flex-1 truncate font-mono text-xs">
                          {repo.fullName}
                        </span>
                        {repo.private ? (
                          <Lock className="h-3 w-3 shrink-0 text-muted-foreground" />
                        ) : null}
                      </CommandItem>
                    ))}
                  </CommandGroup>

                  {hidden > 0 ? (
                    <p className="px-3 py-2 text-[10px] text-muted-foreground">
                      {hidden} more — keep typing to narrow it down.
                    </p>
                  ) : null}
                </>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {value ? (
        <Button
          aria-label="Unlink the application repository"
          className="h-10 w-10 shrink-0"
          disabled={disabled}
          onClick={() => onChange(null)}
          size="icon"
          variant="ghost"
        >
          <X className="h-4 w-4" />
        </Button>
      ) : null}
    </div>
  );
}
