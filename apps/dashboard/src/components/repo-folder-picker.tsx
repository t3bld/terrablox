"use client";

import { useCallback } from "react";

import {
  FolderPicker as UiFolderPicker,
  type FolderTreeEntry,
} from "@terrablox/ui/folder-picker";

export interface FolderPickerProps {
  label?: string;
  description?: string;
  value: string;
  onChange: (value: string) => void;

  provider: "github";
  repoFullName: string;
  refName: string;

  disabled?: boolean;
}

export function FolderPicker({
  label,
  description,
  value,
  onChange,
  provider,
  repoFullName,
  refName,
  disabled,
}: FolderPickerProps) {
  const [owner, repo] = repoFullName.split("/");

  const loadEntries = useCallback(async (): Promise<FolderTreeEntry[]> => {
    const url = `/api/git-provider/${provider}/repos/${owner}/${repo}/tree?ref=${encodeURIComponent(refName)}`;
    const res = await fetch(url);
    const body = await res.json();

    if (!res.ok) {
      const scopes = body?.scopes ? ` (scopes: ${body.scopes})` : "";
      throw new Error(
        body?.error ? `${body.error}${scopes}` : "Failed to fetch repo tree.",
      );
    }

    return (body?.entries ?? []) as FolderTreeEntry[];
  }, [owner, provider, refName, repo]);

  return (
    <UiFolderPicker
      label={label}
      description={description}
      value={value}
      onChange={onChange}
      disabled={disabled}
      loadEntries={loadEntries}
    />
  );
}
