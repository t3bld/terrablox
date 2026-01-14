"use client";

import { Button } from "@terrablox/ui/button";
import { Input } from "@terrablox/ui/input";
import { ChevronRight, FolderOpen, Loader2 } from "lucide-react";
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
  allowDot?: boolean;
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

export function RepoFolderPicker({
  label,
  description,
  value,
  onChange,
  provider,
  repoFullName,
  refName,
  disabled,
  allowDot = true,
}: RepoFolderPickerProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [prefix, setPrefix] = useState(".");

  const ownerRepo = useMemo(() => {
    const [owner, repo] = repoFullName.split("/");
    return { owner, repo };
  }, [repoFullName]);

  const currentValue = normalizeFolderPath(value ?? ".");

  useEffect(() => {
    if (!open) return;
    setPrefix(currentValue);
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

  const crumbs = useMemo(() => {
    const p = normalizeFolderPath(prefix);
    if (p === ".") return ["."]; // root
    return [".", ...p.split("/")];
  }, [prefix]);

  const foldersInPrefix = useMemo(() => {
    const p = normalizeFolderPath(prefix);
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
  }, [entries, prefix]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">{label}</div>
          {description ? (
            <div className="text-xs text-muted-foreground">{description}</div>
          ) : null}
        </div>

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setOpen((v) => !v)}
          disabled={disabled}
        >
          <FolderOpen className="h-4 w-4 mr-2" />
          {open ? "Close" : "Browse"}
        </Button>
      </div>

      <Input
        value={currentValue}
        onChange={(e) => onChange(normalizeFolderPath(e.target.value))}
        placeholder="e.g. . or modules/vpc"
        disabled={disabled}
      />

      {open ? (
        <div className="rounded-md border p-3 space-y-3">
          <div className="flex flex-wrap items-center gap-1 text-xs">
            {crumbs.map((c, idx) => {
              const isDot = idx === 0;
              const path = isDot
                ? "."
                : crumbs
                    .slice(1, idx + 1)
                    .filter(Boolean)
                    .join("/");

              const key = isDot ? "crumb:." : `crumb:${path}`;

              return (
                <button
                  type="button"
                  key={key}
                  className="inline-flex items-center rounded px-2 py-1 hover:bg-muted text-muted-foreground hover:text-foreground"
                  onClick={() => setPrefix(path || ".")}
                >
                  {idx !== 0 ? <ChevronRight className="h-3 w-3 mr-1" /> : null}
                  {c}
                </button>
              );
            })}
          </div>

          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading folders...
            </div>
          ) : error ? (
            <div className="text-sm text-destructive">{error}</div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {allowDot && prefix !== "." ? (
                <button
                  type="button"
                  className="rounded-md border p-2 text-left hover:bg-muted"
                  onClick={() => {
                    const parent =
                      prefix.split("/").slice(0, -1).join("/") || ".";
                    setPrefix(parent);
                  }}
                >
                  <div className="text-sm font-medium">..</div>
                  <div className="text-xs text-muted-foreground">Go up</div>
                </button>
              ) : null}

              {foldersInPrefix.length === 0 ? (
                <div className="text-sm text-muted-foreground">
                  No folders found here.
                </div>
              ) : (
                foldersInPrefix.map((name) => {
                  const next = prefix === "." ? name : `${prefix}/${name}`;

                  return (
                    <div
                      key={next}
                      className="flex items-center justify-between gap-2 rounded-md border p-2"
                    >
                      <button
                        type="button"
                        className="min-w-0 text-left hover:underline"
                        onClick={() => setPrefix(next)}
                        title={next}
                      >
                        <div className="text-sm font-medium truncate">
                          {name}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {next}
                        </div>
                      </button>
                      <Button
                        type="button"
                        size="sm"
                        variant={currentValue === next ? "default" : "outline"}
                        onClick={() => onChange(next)}
                      >
                        {currentValue === next ? "Selected" : "Select"}
                      </Button>
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
