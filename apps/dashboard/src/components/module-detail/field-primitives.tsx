"use client";

import { Badge } from "@terrablox/ui/badge";
import { Button } from "@terrablox/ui/button";
import { Input } from "@terrablox/ui/input";
import { cn } from "@terrablox/ui/lib/utils";
import { Check, ChevronDown, Copy, Search } from "lucide-react";
import { useState } from "react";

/**
 * Building blocks shared by the tabs that render long, searchable lists of
 * declarations: the module's variables, its dependencies and its connections.
 */

export function formatDefault(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return String(value);
  }
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <Button
      aria-label={`Copy ${label}`}
      className="h-6 w-6 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      size="icon"
      type="button"
      variant="ghost"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-emerald-600" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </Button>
  );
}

export function TypeBadge({ type }: { type: string | null }) {
  if (!type) return null;

  const isComplex = /^(object|list|map|set|tuple)\b/.test(type);

  return (
    <code
      className={cn(
        "rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground",
        isComplex && "block max-w-full overflow-x-auto whitespace-pre",
      )}
      title={type}
    >
      {type}
    </code>
  );
}

export function SearchField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
}) {
  return (
    <div className="relative flex-1">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        className="pl-9"
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        type="search"
        value={value}
      />
    </div>
  );
}

export function FieldList({
  title,
  icon,
  total,
  shown,
  collapsible,
  open = true,
  onToggle,
  hint,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  total: number;
  shown: number;
  /** Turns the header into a button that folds the list away. */
  collapsible?: boolean;
  open?: boolean;
  onToggle?: () => void;
  /** Shown beside the count, e.g. why a collapsed section is worth opening. */
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  const isFiltered = shown !== total;

  const header = (
    <>
      <span className="text-muted-foreground">{icon}</span>
      <h3 className="font-semibold text-sm">{title}</h3>
      <Badge variant="secondary">
        {isFiltered ? `${shown} / ${total}` : total}
      </Badge>
      {hint}
    </>
  );

  return (
    // `overflow-hidden` would trap the sticky header inside the section, so the
    // rounded corners are clipped per-child instead.
    <section className="rounded-lg border bg-card">
      {collapsible ? (
        <button
          aria-expanded={open}
          // Sticky so that after scrolling through a long list the control that
          // folds it away is still on screen.
          className={cn(
            "sticky top-0 z-10 flex w-full items-center gap-2 rounded-t-lg bg-muted/95 px-4 py-2.5 text-left backdrop-blur transition-colors hover:bg-muted",
            // A closed section is nothing but its header, so the separator
            // would read as a second bottom edge next to the section border.
            open ? "border-b" : "rounded-b-lg",
          )}
          onClick={onToggle}
          type="button"
        >
          <ChevronDown
            className={cn(
              "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
              !open && "-rotate-90",
            )}
          />
          {header}
        </button>
      ) : (
        <header className="flex items-center gap-2 rounded-t-lg border-b bg-muted/30 px-4 py-2.5">
          {header}
        </header>
      )}
      {open ? children : null}
    </section>
  );
}

export function EmptyMessage({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-4 py-8 text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}
