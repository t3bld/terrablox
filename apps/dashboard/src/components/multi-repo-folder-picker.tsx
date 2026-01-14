"use client";

import { Button } from "@terrablox/ui/button";
import { X } from "lucide-react";
import { RepoFolderPicker } from "./repo-folder-picker";

export interface MultiRepoFolderPickerProps {
  label: string;
  description?: string;
  value: string[];
  // Client component callback.
  onChange: (next: string[]) => void;

  provider: "github";
  repoFullName: string;
  refName: string;

  disabled?: boolean;
}

function normalizeFolderPath(input: string) {
  const raw = input.trim();
  if (!raw) return ".";
  const normalized = raw.replace(/^\/+/, "").replace(/\/+$/, "");
  return normalized === "" ? "." : normalized;
}

export function MultiRepoFolderPicker({
  label,
  description,
  value,
  onChange,
  provider,
  repoFullName,
  refName,
  disabled,
}: MultiRepoFolderPickerProps) {
  const folders = (value ?? [])
    .map(normalizeFolderPath)
    .filter((v) => v && v !== ".");

  return (
    <div className="space-y-3">
      <div>
        <div className="text-sm font-medium">{label}</div>
        {description ? (
          <div className="text-xs text-muted-foreground">{description}</div>
        ) : null}
      </div>

      {folders.length > 0 ? (
        <div className="space-y-2">
          {folders.map((f) => (
            <div
              key={f}
              className="flex items-center justify-between gap-2 rounded-md border p-2"
            >
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">{f}</div>
                <div className="text-xs text-muted-foreground">
                  Terraform submodule folder
                </div>
              </div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => onChange(folders.filter((x) => x !== f))}
                disabled={disabled}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">
          No submodule folders selected.
        </div>
      )}

      <RepoFolderPicker
        label="Add submodule folder"
        description="Browse the repo and select a folder to add."
        value={"."}
        onChange={(picked: string) => {
          const p = normalizeFolderPath(picked);
          if (!p || p === ".") return;
          if (folders.includes(p)) return;
          onChange([...folders, p]);
        }}
        provider={provider}
        repoFullName={repoFullName}
        refName={refName}
        disabled={disabled}
      />
    </div>
  );
}
