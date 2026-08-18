"use client";

import { useMemo, useState } from "react";

import { Button } from "./button";
import { Input } from "./input";

export interface TagsInputProps {
  label?: string;
  description?: string;

  value: string[];
  onChange: (tags: string[]) => void;

  suggestions?: string[];
  placeholder?: string;
  disabled?: boolean;
  /** Only allow selecting from suggestions; useful for filters. */
  suggestionsOnly?: boolean;
}

function normalizeTag(input: string) {
  return input.trim().replace(/\s+/g, "-").toLowerCase();
}

export function TagsInput({
  label,
  description,
  value,
  onChange,
  suggestions,
  placeholder = "Add a tag…",
  disabled,
  suggestionsOnly = false,
}: TagsInputProps) {
  const [draft, setDraft] = useState("");

  const tags = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];

    for (const t of value ?? []) {
      const n = normalizeTag(t);
      if (!n || seen.has(n)) continue;
      seen.add(n);
      out.push(n);
    }

    return out;
  }, [value]);

  const filteredSuggestions = useMemo(() => {
    const q = normalizeTag(draft);
    const base = (suggestions ?? [])
      .map(normalizeTag)
      .filter((t) => t && !tags.includes(t));

    if (!q) return base.slice(0, 12);

    return base.filter((t) => t.includes(q)).slice(0, 12);
  }, [draft, suggestions, tags]);

  function addTag(raw: string) {
    const n = normalizeTag(raw);
    if (!n) return;
    if (tags.includes(n)) return;
    onChange([...tags, n]);
  }

  function removeTag(tag: string) {
    onChange(tags.filter((t) => t !== tag));
  }

  function commitDraft() {
    const parts = draft
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (parts.length === 0) return;

    for (const p of parts) addTag(p);
    setDraft("");
  }

  return (
    <div className="space-y-2">
      {label ? <div className="text-sm font-medium">{label}</div> : null}
      {description ? (
        <div className="text-xs text-muted-foreground">{description}</div>
      ) : null}

      {suggestionsOnly ? null : (
        <div className="flex items-center gap-2">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                commitDraft();
              }
            }}
            placeholder={placeholder}
            disabled={disabled}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={commitDraft}
            disabled={disabled || !draft.trim()}
            className="shrink-0"
          >
            Add
          </Button>
        </div>
      )}

      {tags.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {tags.map((t) => (
            <button
              key={t}
              type="button"
              className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-2 py-1 text-xs hover:bg-primary/10"
              onClick={() => removeTag(t)}
              disabled={disabled}
              title="Remove tag"
            >
              {t}
              <span className="text-muted-foreground">×</span>
            </button>
          ))}
        </div>
      ) : null}

      {filteredSuggestions.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {filteredSuggestions.map((s) => (
            <Button
              key={s}
              type="button"
              size="sm"
              variant={suggestionsOnly ? "outline" : "ghost"}
              onClick={() => addTag(s)}
              disabled={disabled}
              className="h-7 cursor-pointer px-2 text-xs"
            >
              {s}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
