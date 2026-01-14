"use client";

import { Button } from "@terrablox/ui/button";
import { Input } from "@terrablox/ui/input";
import { ChevronRight, Folder, FolderOpen, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

export interface RepoFolderPickerProps {
  label: string;
  description?: string;
  value: string;
  onChange: (value: string) => void;

  provider: "github";
  repoFullName: string;
  refName: string;

  disabled?: boolean;
}

type TreeEntry = {
  path: string;
  type: "tree" | "blob";
};

function normalizeFolderPath(input: string) {
  const raw = input.trim();
  if (!raw) return ".";
  const normalized = raw.replace(/^\/+/, "").replace(/\/+$/, "");
  return normalized === "" ? "." : normalized;
}

function joinPath(prefix: string, name: string) {
  const p = normalizeFolderPath(prefix);
  if (p === ".") return name;
  return `${p}/${name}`;
}

function getChildFolders(entries: TreeEntry[], parent: string) {
  const p = normalizeFolderPath(parent);
  const base = p === "." ? "" : `${p}/`;

  const names = new Set<string>();

  for (const e of entries) {
    if (e.type !== "tree") continue;
    if (!e.path.startsWith(base)) continue;

    const remainder = e.path.slice(base.length);
    if (!remainder) continue;

    const first = remainder.split("/")[0];
    if (first) names.add(first);
  }

  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

export function RepoFolderPicker({
  label,
  description,
  value,
  onChange,
  provider,
  repoFullName,
  refName,
  disabled,
}: RepoFolderPickerProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<TreeEntry[]>([]);

  // Finder-like column navigation state
  const [pathStack, setPathStack] = useState<string[]>(["."]); // stack of selected folder paths

  const ownerRepo = useMemo(() => {
    const [owner, repo] = repoFullName.split("/");
    return { owner, repo };
  }, [repoFullName]);

  const currentValue = normalizeFolderPath(value ?? ".");

  // When opening, always start browsing from root for a predictable UX.
  useEffect(() => {
    if (!open) return;
    setPathStack(["."]);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (!ownerRepo.owner || !ownerRepo.repo) return;

    async function fetchTree() {
      setLoading(true);
      setError(null);

      try {
        const url = `/api/git-provider/${provider}/repos/${ownerRepo.owner}/${ownerRepo.repo}/tree?ref=${encodeURIComponent(refName)}`;
        const res = await fetch(url);
        const body = await res.json();

        if (!res.ok) {
          const scopes = body?.scopes ? ` (scopes: ${body.scopes})` : "";
          throw new Error(
            body?.error
              ? `${body.error}${scopes}`
              : "Failed to fetch repo tree.",
          );
        }

        setEntries((body?.entries ?? []) as TreeEntry[]);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load repo tree.");
      } finally {
        setLoading(false);
      }
    }

    fetchTree();
  }, [open, ownerRepo.owner, ownerRepo.repo, provider, refName]);

  const selectedCwd = pathStack[pathStack.length - 1] ?? ".";

  const columns = useMemo(() => {
    // Each column shows the children of the corresponding pathStack[i].
    // And highlights the next selected entry (pathStack[i+1]) if present.
    return pathStack.map((parent, idx) => {
      const folders = getChildFolders(entries, parent);
      const selectedChild = pathStack[idx + 1];

      return {
        parent,
        folders,
        selectedChild,
      };
    });
  }, [entries, pathStack]);

  return (
    <div className="space-y-2">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {description ? (
          <div className="text-xs text-muted-foreground">{description}</div>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        <Input
          value={currentValue}
          onChange={(e) => onChange(normalizeFolderPath(e.target.value))}
          placeholder="e.g. . or modules/vpc"
          disabled={disabled}
        />

        {open ? (
          <>
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={() => {
                onChange(selectedCwd);
                setOpen(false);
              }}
              disabled={disabled}
              className="shrink-0"
            >
              Use this folder
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setOpen(false)}
              disabled={disabled}
              className="shrink-0"
            >
              Close
            </Button>
          </>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setOpen(true)}
            disabled={disabled}
            className="shrink-0"
          >
            <FolderOpen className="mr-2 h-4 w-4" />
            Browse
          </Button>
        )}
      </div>

      {open ? (
        loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading folders...
          </div>
        ) : error ? (
          <div className="text-sm text-destructive">{error}</div>
        ) : (
          <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
            {columns.map((col, colIdx) => {
              return (
                <div
                  key={`col:${col.parent}`}
                  className="rounded-md border bg-background"
                >
                  <div className="border-b px-2 py-1.5 text-xs text-muted-foreground">
                    {col.parent === "." ? "Root" : col.parent}
                  </div>

                  <div className="max-h-[240px] overflow-y-auto p-1">
                    {col.folders.length === 0 ? (
                      <div className="px-2 py-2 text-xs text-muted-foreground">
                        No folders
                      </div>
                    ) : (
                      col.folders.map((name) => {
                        const path = joinPath(col.parent, name);
                        const selected = col.selectedChild === path;

                        return (
                          <button
                            type="button"
                            key={path}
                            className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted ${
                              selected ? "bg-muted font-medium" : "font-normal"
                            }`}
                            onClick={() => {
                              setPathStack((prev) => {
                                const next = prev.slice(0, colIdx + 1);
                                next.push(path);
                                return next;
                              });
                            }}
                          >
                            <span className="flex min-w-0 items-center gap-2">
                              <Folder className="h-4 w-4 text-muted-foreground" />
                              <span className="truncate">{name}</span>
                            </span>
                            <ChevronRight className="h-4 w-4 text-muted-foreground" />
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )
      ) : null}
    </div>
  );
}
