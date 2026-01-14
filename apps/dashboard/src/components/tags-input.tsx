"use client";

import { Button } from "@terrablox/ui/button";
import { Input } from "@terrablox/ui/input";
import { X } from "lucide-react";
import { useMemo, useState } from "react";

export interface TagsInputProps {
  label: string;
  description?: string;
  value: string[];
  onChange: (next: string[]) => void;
  suggestions?: string[];
  disabled?: boolean;
}

function normalizeTag(tag: string) {
  return tag.trim().replace(/\s+/g, "-").toLowerCase();
}

export function TagsInput({
  label,
  description,
  value,
  onChange,
  suggestions = [],
  disabled,
}: TagsInputProps) {
  const [draft, setDraft] = useState("");

  const normalizedValue = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const t of value ?? []) {
      const n = normalizeTag(t);
      if (!n || seen.has(n)) continue;
      seen.add(n);
      out.push(n);
    }
    return out;
  }, [value]);

  const normalizedSuggestions = useMemo(() => {
    const seen = new Set(normalizedValue);
    const out: string[] = [];
    for (const s of suggestions ?? []) {
      const n = normalizeTag(s);
      if (!n || seen.has(n)) continue;
      seen.add(n);
      out.push(n);
    }
    return out;
  }, [suggestions, normalizedValue]);

  function addTag(raw: string) {
    const n = normalizeTag(raw);
    if (!n) return;
    if (normalizedValue.includes(n)) return;
    onChange([...normalizedValue, n]);
    setDraft("");
  }

  function removeTag(tag: string) {
    onChange(normalizedValue.filter((t) => t !== tag));
  }

  return (
    <div className="space-y-2">
      <div>
        <div className="text-sm font-medium">{label}</div>
        {description ? (
          <div className="text-xs text-muted-foreground">{description}</div>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add a tag and press Enter"
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              addTag(draft);
            }
          }}
          disabled={disabled}
        />
        <Button
          type="button"
          variant="outline"
          onClick={() => addTag(draft)}
          disabled={disabled}
        >
          Add
        </Button>
      </div>

      {normalizedValue.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {normalizedValue.map((t) => (
            <span
              key={t}
              className="inline-flex items-center gap-1 rounded-full border bg-muted/30 px-2 py-1 text-xs"
            >
              {t}
              <button
                type="button"
                className="rounded-full p-0.5 hover:bg-muted"
                aria-label={`Remove tag ${t}`}
                onClick={() => removeTag(t)}
                disabled={disabled}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      ) : (
       <></>
      )}

      {normalizedSuggestions.length > 0 ? (
        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">Suggestions</div>
          <div className="flex flex-wrap gap-2">
            {normalizedSuggestions.map((s) => (
              <button
                type="button"
                key={s}
                className="rounded-full border px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50"
                onClick={() => addTag(s)}
                disabled={disabled}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
