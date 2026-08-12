"use client";

import { Button } from "@terrablox/ui/button";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { CopyButton } from "./field-primitives";

/**
 * The panel beside a graph canvas, and the rows inside it.
 *
 * Shared by the Connections and Architecture views. Both answer the same
 * question — "what is this box, and what does it touch?" — so they are built
 * from the same parts: a reader who has learned to use one already knows the
 * other, and a change to the layout cannot drift between them.
 */
export function GraphDetailPanel({
  title,
  subtitle,
  badges,
  onClose,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  badges?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    // A column beside the canvas rather than an overlay: inspecting a graph
    // means clicking one block after another, and a sheet would both cover the
    // controls above and hide a third of the canvas.
    <aside
      aria-label={`Details for ${title}`}
      className="flex h-[calc(100vh-28rem)] min-h-[26rem] w-full shrink-0 flex-col overflow-hidden rounded-lg border bg-card lg:w-80 xl:w-96"
    >
      <div className="flex items-start justify-between gap-2 border-b p-4">
        <div className="min-w-0 space-y-2">
          <h3 className="break-all font-mono font-semibold text-sm">{title}</h3>
          {badges || subtitle ? (
            <div className="flex flex-wrap items-center gap-2">
              {badges}
              {subtitle ? (
                <span className="text-muted-foreground text-xs">
                  {subtitle}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
        <Button
          aria-label="Close details"
          className="h-7 w-7 shrink-0"
          onClick={onClose}
          size="icon"
          type="button"
          variant="ghost"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
    </aside>
  );
}

export function DetailRow({
  label,
  value,
  mono = true,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
}) {
  if (!value) return null;

  return (
    <div className="group grid grid-cols-[7rem_1fr] items-start gap-2 py-1.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="flex min-w-0 items-start gap-1">
        <span
          className={`min-w-0 break-all text-xs ${mono ? "font-mono" : ""}`}
        >
          {value}
        </span>
        <CopyButton label={label.toLowerCase()} value={value} />
      </dd>
    </div>
  );
}

/**
 * A connected block, rendered as a button so the panel doubles as a way to walk
 * the graph: selecting a neighbour swaps the panel over to it.
 */
export function ConnectionLink({
  address,
  label,
  note,
  onSelect,
}: {
  address: string;
  label: string;
  /**
   * Why the two are joined when it is not obvious. Connections to a box that
   * is not itself drawn are routed through it, and saying so is what keeps the
   * shortcut honest rather than mysterious.
   */
  note?: string;
  onSelect: () => void;
}) {
  return (
    <button
      className="flex w-full flex-col gap-0.5 rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground"
      onClick={onSelect}
      title={address}
      type="button"
    >
      <span className="min-w-0 w-full truncate font-mono">{label}</span>
      {note ? (
        <span className="min-w-0 w-full truncate text-[11px] text-muted-foreground">
          {note}
        </span>
      ) : null}
    </button>
  );
}

export function ConnectionList({
  title,
  icon,
  items,
  onSelect,
  emptyText,
}: {
  title: string;
  icon: ReactNode;
  items: { address: string; label: string; note?: string }[];
  onSelect: (address: string) => void;
  emptyText: string;
}) {
  return (
    <div>
      <h5 className="mb-2 flex items-center gap-1.5 font-semibold text-muted-foreground text-xs uppercase tracking-wide">
        {icon}
        {title}
        {items.length > 0 ? (
          <span className="tabular-nums opacity-70">{items.length}</span>
        ) : null}
      </h5>

      {items.length === 0 ? (
        <p className="text-muted-foreground text-xs">{emptyText}</p>
      ) : (
        <div className="space-y-1">
          {items.map((item) => (
            <ConnectionLink
              address={item.address}
              key={item.address}
              label={item.label}
              note={item.note}
              onSelect={() => onSelect(item.address)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
