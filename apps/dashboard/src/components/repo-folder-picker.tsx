"use client";

import { Button } from "@terrablox/ui/button";
import { Input } from "@terrablox/ui/input";
import { ChevronLeft, ChevronRight, FolderOpen, Loader2 } from "lucide-react";
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

function parentPath(path: string) {
  const p = normalizeFolderPath(path);
  if (p === ".") return ".";
  const parent = p.split("/").slice(0, -1).join("/");
  return parent || ".";
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

  // Folder being browsed
  const [cwd, setCwd] = useState(".");
  const [query, setQuery] = useState("");

  const ownerRepo = useMemo(() => {
    const [owner, repo] = repoFullName.split("/");
    return { owner, repo };
  }, [repoFullName]);

  const currentValue = normalizeFolderPath(value ?? ".");

  useEffect(() => {
    if (!open) return;
    setCwd(currentValue);
    setQuery("");
  }, [open, currentValue]);

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

  const breadcrumbs = useMemo(() => {
    const p = normalizeFolderPath(cwd);
    if (p === ".") return ["."];
    return [".", ...p.split("/")];
  }, [cwd]);

  const foldersInCwd = useMemo(() => {
    const p = normalizeFolderPath(cwd);
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

    const list = Array.from(names).sort((a, b) => a.localeCompare(b));

    const q = query.trim().toLowerCase();
    if (!q) return list;

    return list.filter((n) => n.toLowerCase().includes(q));
  }, [cwd, entries, query]);

  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">{label}</div>
          {description ? (
            <div className="text-xs text-muted-foreground">{description}</div>
          ) : null}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Input
          value={currentValue}
          onChange={(e) => onChange(normalizeFolderPath(e.target.value))}
          placeholder="e.g. . or modules/vpc"
          disabled={disabled}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setOpen((v) => !v)}
          disabled={disabled}
          className="shrink-0"
        >
          <FolderOpen className="mr-2 h-4 w-4" />
          Browse
        </Button>
      </div>

      {open ? (
        <div className="rounded-md border p-3 space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setCwd(parentPath(cwd))}
                disabled={cwd === "."}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>

              <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                {breadcrumbs.map((c, idx) => {
                  const isDot = idx === 0;
                  const path = isDot
                    ? "."
                    : breadcrumbs
                        .slice(1, idx + 1)
                        .filter(Boolean)
                        .join("/");

                  const key = isDot ? "crumb:." : `crumb:${path}`;

                  return (
                    <button
                      type="button"
                      key={key}
                      className="inline-flex items-center rounded px-2 py-1 hover:bg-muted hover:text-foreground"
                      onClick={() => setCwd(path || ".")}
                    >
                      {idx !== 0 ? (
                        <ChevronRight className="mr-1 h-3 w-3" />
                      ) : null}
                      {c}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter folders…"
                className="h-8"
              />
              <Button
                type="button"
                size="sm"
                variant={currentValue === "." ? "default" : "outline"}
                onClick={() => onChange(".")}
                title="Select repository root"
              >
                Root
              </Button>
            </div>
          </div>

          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading folders...
            </div>
          ) : error ? (
            <div className="text-sm text-destructive">{error}</div>
          ) : foldersInCwd.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No folders found.
            </div>
          ) : (
            <div className="space-y-1">
              {foldersInCwd.map((name) => {
                const path = cwd === "." ? name : `${cwd}/${name}`;
                const selected = currentValue === path;

                return (
                  <div
                    key={path}
                    className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5"
                  >
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      onClick={() => setCwd(path)}
                      title="Open folder"
                    >
                      <FolderOpen className="h-4 w-4 text-muted-foreground" />
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">
                          {name}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          {path}
                        </div>
                      </div>
                    </button>

                    <Button
                      type="button"
                      size="sm"
                      variant={selected ? "default" : "outline"}
                      onClick={() => onChange(path)}
                    >
                      {selected ? "Selected" : "Select"}
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
