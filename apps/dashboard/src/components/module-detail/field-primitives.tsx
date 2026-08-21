"use client";

import { Badge } from "@terrablox/ui/badge";
import { Button } from "@terrablox/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@terrablox/ui/dropdown-menu";
import { Input } from "@terrablox/ui/input";
import { cn } from "@terrablox/ui/lib/utils";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  Copy,
  Filter,
  Search,
  X,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { isConventionalResourceName } from "@/lib/terraform/resource-label";

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

export function TypeBadge({
  type,
  title,
}: {
  type: string | null;
  /** Overrides the tooltip, e.g. to say the type was inferred rather than declared. */
  title?: string;
}) {
  if (!type) return null;

  const isComplex = /^(object|list|map|set|tuple)\b/.test(type);

  return (
    <code
      className={cn(
        "rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground",
        isComplex && "block max-w-full truncate whitespace-nowrap",
      )}
      title={title ?? type}
    >
      {type}
    </code>
  );
}

/**
 * The app's one search bar: field, result count and filters in a single border.
 *
 * Shaped after the modules overview, and now shared with it in spirit rather than
 * by copy — a second search bar that looked almost the same was the kind of
 * difference a reader has to stop and account for. Everything after the input is
 * passed in, because what counts as a filter differs per list.
 */
export function SearchField({
  value,
  onChange,
  placeholder,
  count,
  children,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  /** e.g. "12 inputs". Sits between the clear button and the filters. */
  count?: React.ReactNode;
  /** Trailing controls, typically a {@link FilterPopover}. */
  children?: React.ReactNode;
}) {
  return (
    <div className="flex w-full items-center gap-2 rounded-md border border-input bg-background px-2 py-1.5 focus-within:border-primary">
      <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
      <Input
        aria-label={placeholder}
        className="h-8 min-w-0 flex-1 border-0 px-0 focus-visible:ring-0 focus-visible:ring-offset-0"
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        value={value}
      />

      {value.trim() ? (
        <Button
          aria-label="Clear search"
          className="h-8 w-8"
          onClick={() => onChange("")}
          size="icon"
          type="button"
          variant="ghost"
        >
          <X className="h-4 w-4" />
        </Button>
      ) : null}

      {count ? (
        <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
          {count}
        </span>
      ) : null}

      {children}
    </div>
  );
}

/**
 * The filter popup that belongs in a {@link SearchField}.
 *
 * A trigger that counts what is active, and a panel with its own header and a way
 * out of every filter at once. The count on the trigger is the part that matters:
 * a filtered list that looks unfiltered is how people conclude their data is
 * missing.
 */
export function FilterPopover({
  activeCount,
  canClear,
  onClearAll,
  children,
}: {
  activeCount: number;
  canClear: boolean;
  onClearAll: () => void;
  children: React.ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          className="gap-2"
          size="sm"
          type="button"
          variant={activeCount ? "secondary" : "outline"}
        >
          <Filter className="h-4 w-4" />
          Filters
          {activeCount ? (
            <span className="ml-1 rounded bg-muted px-1.5 py-0.5 text-xs">
              {activeCount}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[340px] p-0">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <DropdownMenuLabel className="p-0">Filters</DropdownMenuLabel>
          <Button
            className="h-7 px-2 text-xs"
            disabled={!canClear}
            onClick={onClearAll}
            size="sm"
            type="button"
            variant="ghost"
          >
            Clear all
          </Button>
        </div>

        <div className="space-y-4 p-4">{children}</div>
      </DropdownMenuContent>
    </DropdownMenu>
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

/**
 * The block labels of one folded resource type, e.g. `this, ignore_value`.
 *
 * Conventional labels are drawn faintly rather than left out. Leaving them out
 * is what made a type badged `2` list a single name: the reader counts one line
 * against the count beside it and concludes the page lost something, when the
 * truth is that the second block is called `this`. Drawn plainly they would
 * instead lend a label nobody chose the same weight as one somebody did.
 *
 * The tooltip is on the faint label rather than the line, so the convention is
 * explained exactly where a reader stops to wonder about it.
 */
export function ResourceNames({
  names,
  resourceType,
  className,
}: {
  /** Already ordered; see `sortResourceNames`. */
  names: readonly string[];
  /** Named in the tooltip, so the explanation is about this type and not in general. */
  resourceType: string;
  className?: string;
}) {
  if (names.length === 0) return null;

  return (
    <p
      className={cn(
        "mt-1 break-words font-mono text-muted-foreground text-xs",
        className,
      )}
    >
      {names.map((name, index) => (
        <span key={name}>
          {index > 0 ? ", " : ""}
          {isConventionalResourceName(name) ? (
            <span
              className="opacity-60"
              title={`"${name}" is the conventional label for a module's main ${resourceType} — it distinguishes nothing, but it is the label in the code`}
            >
              {name}
            </span>
          ) : (
            name
          )}
        </span>
      ))}
    </p>
  );
}
