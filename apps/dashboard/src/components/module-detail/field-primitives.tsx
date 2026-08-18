"use client";

import { Badge } from "@terrablox/ui/badge";
import { Button } from "@terrablox/ui/button";
import { Input } from "@terrablox/ui/input";
import { cn } from "@terrablox/ui/lib/utils";
import { ArrowUpRight, Check, ChevronDown, Copy, Search } from "lucide-react";
import Link from "next/link";
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
        isComplex && "block max-w-full truncate whitespace-nowrap",
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
    <div className="relative flex-1 rounded-md border border-input bg-background focus-within:border-primary">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        className="border-0 pl-9 focus-visible:ring-0 focus-visible:ring-offset-0"
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
  showToggleIcon = true,
  hint,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  total: number;
  shown: number;
  /** Turns the header into a button that folds the list away. */
  collapsible?: boolean;
  open?: boolean;
  onToggle?: () => void;
  showToggleIcon?: boolean;
  /** Shown beside the count, e.g. why a collapsed section is worth opening. */
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  const isFiltered = shown !== total;

  const header = (
    <>
      {icon ? <span className="text-muted-foreground">{icon}</span> : null}
      <h3 className="font-semibold text-sm">{title}</h3>
      <Badge variant="secondary">
        {isFiltered ? `${shown} / ${total}` : total}
      </Badge>
      {hint}
    </>
  );

  return (
    <section className="rounded-lg border bg-card">
      {collapsible ? (
        <button
          aria-expanded={open}
          className={cn(
            "flex w-full items-center gap-2 rounded-t-lg border-b bg-muted/30 px-4 py-2.5 text-left transition-colors hover:bg-muted/50",
            open ? "" : "rounded-b-lg",
          )}
          onClick={onToggle}
          type="button"
        >
          {showToggleIcon ? (
            <ChevronDown
              className={cn(
                "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                !open && "-rotate-90",
              )}
            />
          ) : null}
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

/**
 * A list row whose whole surface leads somewhere.
 *
 * The destination is named by the same trailing arrow used by "Used by".
 * Rows without a destination stay plain, so a list can mix the two cleanly.
 */
export function LinkRow({
  href,
  external = false,
  label,
  children,
}: {
  href?: string | null;
  /** Opens in a new tab and swaps the arrow for the external-link icon. */
  external?: boolean;
  /** Names the destination for screen readers, e.g. "Open aws provider docs". */
  label?: string;
  children: React.ReactNode;
}) {
  const row =
    "group relative flex items-center gap-3 border-b px-4 py-3 last:border-b-0";

  if (!href) return <div className={row}>{children}</div>;

  // Stretched over the row rather than wrapping it, so the row stays valid HTML.
  const stretched =
    "shrink-0 text-muted-foreground after:absolute after:inset-0 group-hover:text-foreground";

  return (
    <div className={cn(row, "hover:bg-muted/40")}>
      <div className="min-w-0 flex-1">{children}</div>
      {external ? (
        <a
          aria-label={label}
          className={stretched}
          href={href}
          rel="noreferrer"
          target="_blank"
        >
          <ArrowUpRight className="h-3.5 w-3.5" />
        </a>
      ) : (
        <Link aria-label={label} className={stretched} href={href}>
          <ArrowUpRight className="h-3.5 w-3.5" />
        </Link>
      )}
    </div>
  );
}
